import path from "node:path";
import { KIND_LABELS } from "./constants.mjs";
import { hashText, normalizePath, getPathFromDiffLine, safeIdentifier, truncateText, unique } from "./utils.mjs";

function parseUnifiedDiff(diff) {
    const lines = String(diff ?? "").replace(/\r\n?/g, "\n").split("\n");
    const files = [];
    let current;

    const finishFile = () => {
        if (!current) {
            return;
        }
        current.path = current.newPath || current.oldPath || current.path || "unknown";
        current.patch = current.lines.join("\n");
        current.hunks = current.hunks.map((hunk) => ({
            header: hunk.header,
            context: hunk.context,
            lines: hunk.lines,
        }));
        files.push(current);
        current = undefined;
    };

    for (const line of lines) {
        if (line.startsWith("diff --git ")) {
            finishFile();
            const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
            current = {
                path: match?.[2] || match?.[1] || "unknown",
                oldPath: match?.[1] || "",
                newPath: match?.[2] || "",
                lines: [line],
                hunks: [],
                additions: 0,
                deletions: 0,
                binary: false,
            };
            continue;
        }

        if (!current) {
            if (!line.startsWith("--- ") && !line.startsWith("+++ ")) {
                continue;
            }
            current = {
                path: "unknown",
                oldPath: "",
                newPath: "",
                lines: [],
                hunks: [],
                additions: 0,
                deletions: 0,
                binary: false,
            };
        }

        current.lines.push(line);
        if (line.startsWith("--- ")) {
            current.oldPath = getPathFromDiffLine(line);
            continue;
        }
        if (line.startsWith("+++ ")) {
            current.newPath = getPathFromDiffLine(line);
            current.path = current.newPath || current.oldPath || current.path;
            continue;
        }
        if (line.startsWith("Binary files ")) {
            current.binary = true;
            continue;
        }
        if (line.startsWith("@@")) {
            const context = line.split("@@")[2]?.trim() || "";
            current.hunks.push({ header: line, context, lines: [] });
            continue;
        }

        const hunk = current.hunks.at(-1);
        if (!hunk) {
            continue;
        }
        hunk.lines.push(line);
        if (line.startsWith("+") && !line.startsWith("+++")) {
            current.additions += 1;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
            current.deletions += 1;
        }
    }
    finishFile();
    return files;
}

function classifyFile(file) {
    const filePath = normalizePath(file.path).toLowerCase();
    const content = file.lines.join("\n").toLowerCase();
    if (/(auth|security|permission|role|credential|secret|token|oauth|jwt)/.test(filePath)) {
        return "security";
    }
    if (/(^|\/)(migration|migrations|schema|database|db)(\/|$)|\.(sql|prisma)$/.test(filePath)) {
        return "database";
    }
    if (/(package\.json|package-lock\.json|yarn\.lock|pnpm-lock|requirements.*\.txt|poetry\.lock|go\.mod|go\.sum|cargo\.(toml|lock)|pom\.xml|build\.gradle)/.test(filePath)) {
        return "dependencies";
    }
    if (/(^|\/)(api|apis|routes?|controllers?|handlers?)(\/|$)|\b(fetch|graphql|rest|http|endpoint)\b/.test(filePath + "\n" + content)) {
        return "api";
    }
    if (/(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[^.]+$/.test(filePath)) {
        return "tests";
    }
    if (/(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst|adoc)$/.test(filePath)) {
        return "docs";
    }
    if (/\.(tsx|jsx|vue|svelte|css|scss|less)$/.test(filePath) || /(^|\/)(components?|pages?|views?)(\/|$)/.test(filePath)) {
        return "frontend";
    }
    if (/\.(json|ya?ml|toml|ini|properties|env)$/.test(filePath) || /(^|\/)(config|\.github)(\/|$)/.test(filePath)) {
        return "config";
    }
    return "implementation";
}

function getImportance(kind, files) {
    const additions = files.reduce((total, file) => total + file.additions, 0);
    const deletions = files.reduce((total, file) => total + file.deletions, 0);
    const changedLines = additions + deletions;
    if (["security", "database", "dependencies"].includes(kind)) {
        return "high";
    }
    if (kind === "api" && changedLines >= 10) {
        return "high";
    }
    if (changedLines >= 80 || deletions >= 35 || files.length >= 5) {
        return "high";
    }
    if (changedLines >= 15 || files.length >= 2 || kind === "api") {
        return "medium";
    }
    return "low";
}

function describeSection(kind, files) {
    const additions = files.reduce((total, file) => total + file.additions, 0);
    const deletions = files.reduce((total, file) => total + file.deletions, 0);
    const pathList = files.map((file) => file.path).join("、");
    return `${files.length}ファイルの${KIND_LABELS[kind] || "変更"}です。追加${additions}行・削除${deletions}行。対象: ${pathList}。初期分類はファイルパスと差分の特徴から推定しています。`;
}

function buildSections(files) {
    const groups = new Map();
    for (const file of files) {
        const kind = classifyFile(file);
        const group = groups.get(kind) || [];
        group.push(file);
        groups.set(kind, group);
    }

    return [...groups.entries()].map(([kind, groupFiles], index) => {
        const contexts = unique(
            groupFiles.flatMap((file) => file.hunks.map((hunk) => hunk.context)).filter((context) => context && !context.startsWith("+")),
        ).slice(0, 3);
        const contextTitle = contexts.length > 0 ? `: ${contexts.join(" / ").slice(0, 100)}` : "";
        const rawDiff = groupFiles.map((file) => file.patch).join("\n\n");
        const excerpt = truncateText(rawDiff);
        const importance = getImportance(kind, groupFiles);
        let importanceReason = "比較的小さな変更ですが、周辺コードとの整合性を確認してください。";
        if (importance === "high") {
            importanceReason = "影響範囲または変更のリスクが高い可能性があります。";
        } else if (importance === "medium") {
            importanceReason = "複数箇所または一定量の変更があり、意図の確認が必要です。";
        }
        return {
            id: `section-${safeIdentifier(kind)}-${index + 1}`,
            title: `${KIND_LABELS[kind] || "変更"}${contextTitle}`,
            description: describeSection(kind, groupFiles),
            importance,
            importanceReason,
            status: "unreviewed",
            notes: "",
            reviewQuestions: [],
            kind,
            files: groupFiles.map((file) => ({
                path: file.path,
                oldPath: file.oldPath,
                newPath: file.newPath,
                additions: file.additions,
                deletions: file.deletions,
                binary: file.binary,
            })),
            filePaths: groupFiles.map((file) => file.path),
            diff: excerpt.text,
            diffFingerprint: hashText(rawDiff),
            diffTruncated: excerpt.truncated,
        };
    });
}

function getPatchContent(file) {
    return file.hunks
        .flatMap((hunk) => hunk.lines)
        .filter((line) => !line.startsWith("-") || line.startsWith("---"))
        .map((line) => (line.startsWith("+") || line.startsWith(" ")) ? line.slice(1) : line)
        .join("\n");
}

function extractImports(file) {
    const content = getPatchContent(file);
    const imports = [];
    const patterns = [
        /\bimport\s+(?:[^'"]+from\s+)?["']([^"']+)["']/g,
        /\brequire\(\s*["']([^"']+)["']\s*\)/g,
        /^\s*from\s+([A-Za-z0-9_./-]+)\s+import\b/gm,
        /^\s*import\s+([A-Za-z0-9_./-]+)/gm,
        /^\s*#include\s+[<"]([^>"]+)[>"]/gm,
    ];
    for (const pattern of patterns) {
        for (const match of content.matchAll(pattern)) {
            imports.push(match[1]);
        }
    }
    return unique(imports);
}

function resolveChangedFile(sourcePath, importPath, fileByPath) {
    const normalizedImport = normalizePath(importPath);
    const candidates = [];
    if (normalizedImport.startsWith(".")) {
        candidates.push(normalizePath(path.posix.join(path.posix.dirname(normalizePath(sourcePath)), normalizedImport)));
    } else {
        candidates.push(normalizedImport);
    }

    for (const candidate of candidates) {
        if (fileByPath.has(candidate)) {
            return candidate;
        }
        const withoutExtension = candidate.replace(/\.[^.\/]+$/, "");
        for (const filePath of fileByPath.keys()) {
            const fileWithoutExtension = filePath.replace(/\.[^.\/]+$/, "");
            if (fileWithoutExtension === withoutExtension || filePath === `${candidate}/index.js` || filePath === `${candidate}/index.ts`) {
                return filePath;
            }
        }
    }

    if (!normalizedImport.startsWith(".")) {
        const suffix = `/${normalizedImport}`;
        for (const filePath of fileByPath.keys()) {
            if (filePath.endsWith(suffix) || filePath.replace(/\.[^.\/]+$/, "").endsWith(suffix)) {
                return filePath;
            }
        }
    }
    return undefined;
}

function buildDependencies(files, sections) {
    const fileByPath = new Map(files.map((file) => [normalizePath(file.path), file]));
    const sectionByPath = new Map(
        sections.flatMap((section) => section.filePaths.map((filePath) => [normalizePath(filePath), section.id])),
    );
    const nodes = files.map((file, index) => ({
        id: `module-${index + 1}`,
        label: file.path,
        sectionId: sectionByPath.get(normalizePath(file.path)),
    }));
    const nodeByPath = new Map(files.map((file, index) => [normalizePath(file.path), nodes[index].id]));
    const edges = [];

    for (const file of files) {
        const from = nodeByPath.get(normalizePath(file.path));
        for (const importPath of extractImports(file)) {
            const targetPath = resolveChangedFile(file.path, importPath, fileByPath);
            const to = targetPath ? nodeByPath.get(targetPath) : undefined;
            if (from && to && from !== to) {
                edges.push({ from, to, label: importPath });
            }
        }
    }
    return {
        nodes,
        edges: edges.filter((edge, index, all) => all.findIndex((candidate) => candidate.from === edge.from && candidate.to === edge.to) === index),
    };
}

function escapeMermaidLabel(value) {
    return String(value ?? "")
        .replace(/[\r\n]+/g, " ")
        .replace(/"/g, "'");
}

function buildDiagrams(sections, dependencies) {
    const sectionIds = new Map(sections.map((section, index) => [section.id, `S${index + 1}`]));
    const sectionIdByNodeId = new Map(
        dependencies.nodes.map((node) => [node.id, sectionIds.get(node.sectionId)]),
    );
    const flowchart = ["flowchart LR"];
    for (const section of sections) {
        flowchart.push(`  ${sectionIds.get(section.id)}["${escapeMermaidLabel(section.title)}"]`);
    }

    const sectionEdges = [];
    for (const edge of dependencies.edges) {
        const from = sectionIdByNodeId.get(edge.from);
        const to = sectionIdByNodeId.get(edge.to);
        if (from && to && from !== to) {
            sectionEdges.push(`${from} -->|依存| ${to}`);
        }
    }
    for (const edge of unique(sectionEdges)) {
        flowchart.push(`  ${edge}`);
    }

    const sequence = ["sequenceDiagram", "  participant R as Reviewer"];
    for (const section of sections.slice(0, 10)) {
        const id = sectionIds.get(section.id);
        sequence.push(`  participant ${id} as ${escapeMermaidLabel((KIND_LABELS[section.kind] || "変更").slice(0, 24))}`);
        sequence.push(`  R->>${id}: 意図・リスクを確認`);
    }
    for (const edge of unique(sectionEdges)) {
        const match = edge.match(/^(S\d+) -->\|[^|]+\| (S\d+)$/);
        if (match) {
            sequence.push(`  ${match[1]}->>${match[2]}: 依存関係を確認`);
        }
    }
    if (sections.length === 0) {
        flowchart.push("  R[差分を入力してください]");
        sequence.push("  R-->>R: 差分を入力してください");
    }
    return {
        flowchart: flowchart.join("\n"),
        sequence: sequence.join("\n"),
    };
}

function calculateStats(diff, files, sections) {
    const additions = files.reduce((total, file) => total + file.additions, 0);
    const deletions = files.reduce((total, file) => total + file.deletions, 0);
    return {
        files: files.length,
        additions,
        deletions,
        sections: sections.length,
        highImportance: sections.filter((section) => section.importance === "high").length,
        diffLines: String(diff ?? "").split(/\r?\n/).length,
    };
}

function buildUnparsedDiffSections(diff) {
    const excerpt = truncateText(String(diff));
    return [
        {
            id: "section-unparsed-1",
            title: "未分類の差分",
            description: "標準的なUnified Diffのファイルヘッダーを検出できなかったため、差分全体を確認してください。",
            importance: "medium",
            importanceReason: "自動分類できていないため、手動で意味単位を確認してください。",
            status: "unreviewed",
            notes: "",
            reviewQuestions: [],
            kind: "implementation",
            files: [],
            filePaths: [],
            diff: excerpt.text,
            diffFingerprint: hashText(String(diff)),
            diffTruncated: excerpt.truncated,
        },
    ];
}

function sectionIdentity(section) {
    const filePaths = Array.isArray(section.filePaths) ? [...section.filePaths].sort() : [];
    return `${section.kind || ""}|${filePaths.join("\n")}`;
}

function hasSameSectionDiff(previous, next) {
    if (previous.diffFingerprint && next.diffFingerprint) {
        return previous.diffFingerprint === next.diffFingerprint;
    }
    return previous.diff === next.diff;
}

function reconcileSections(previousSections, nextSections) {
    const previousByIdentity = new Map(previousSections.map((section) => [sectionIdentity(section), section]));
    return nextSections.map((section) => {
        const previous = previousByIdentity.get(sectionIdentity(section));
        if (!previous || !hasSameSectionDiff(previous, section)) {
            return section;
        }
        return {
            ...section,
            title: previous.title,
            description: previous.description,
            importance: previous.importance,
            importanceReason: previous.importanceReason,
            status: previous.status,
            notes: previous.notes,
            reviewQuestions: previous.reviewQuestions,
        };
    });
}

function mergeReviewSections(currentSections, updates, replaceAll) {
    if (replaceAll) {
        return updates;
    }

    const updatesById = new Map(updates.map((section) => [section.id, section]));
    const currentIds = new Set(currentSections.map((section) => section.id));
    const mergedSections = currentSections.map((section) => updatesById.get(section.id) || section);
    updates.forEach((section) => {
        if (!currentIds.has(section.id)) {
            mergedSections.push(section);
        }
    });
    return mergedSections;
}

function analyzeDiff(diff) {
    const files = parseUnifiedDiff(diff);
    const isUnparsedDiff = files.length === 0 && String(diff).trim().length > 0;
    const sections = isUnparsedDiff ? buildUnparsedDiffSections(diff) : buildSections(files);
    const dependencies = isUnparsedDiff ? { nodes: [], edges: [] } : buildDependencies(files, sections);
    return {
        sections,
        dependencies,
        diagrams: buildDiagrams(sections, dependencies),
        stats: calculateStats(diff, files, sections),
    };
}
export {
    parseUnifiedDiff,
    classifyFile,
    buildSections,
    buildDependencies,
    buildDiagrams,
    calculateStats,
    buildUnparsedDiffSections,
    reconcileSections,
    mergeReviewSections,
    analyzeDiff,
};
