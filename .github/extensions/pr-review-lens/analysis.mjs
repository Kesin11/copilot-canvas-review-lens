import path from "node:path";
import { MAX_DIFF_BYTES } from "./constants.mjs";
import { getPathFromDiffLine, hashText, normalizePath, unique } from "./utils.mjs";

const ROLE_LABELS = {
    security: "権限・セキュリティ",
    database: "データベース・スキーマ",
    dependencies: "依存関係・ビルド",
    api: "API・サーバー境界",
    frontend: "画面・UI",
    tests: "テスト",
    docs: "ドキュメント",
    config: "設定",
    implementation: "実装",
    support: "横断・サポート",
};

const IMPACT_RANK = { high: 3, medium: 2, low: 1 };

function parseHunkHeader(header) {
    const match = String(header).match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s?(.*))?$/);
    if (!match) {
        return { header, oldStart: null, oldCount: null, newStart: null, newCount: null, context: "", lines: [] };
    }
    return {
        header,
        oldStart: Number(match[1]),
        oldCount: Number(match[2] || 1),
        newStart: Number(match[3]),
        newCount: Number(match[4] || 1),
        context: match[5] || "",
        lines: [],
    };
}

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
            ...hunk,
            lines: [...hunk.lines],
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
            current.hunks.push(parseHunkHeader(line));
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
    if (file.path === "unknown") {
        return "support";
    }
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
    if (!file.lines.length && !file.hunks.length && file.binary) {
        return "support";
    }
    return "implementation";
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
    const candidates = normalizedImport.startsWith(".")
        ? [normalizePath(path.posix.join(path.posix.dirname(normalizePath(sourcePath)), normalizedImport))]
        : [normalizedImport];

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

function buildDependencies(files, groups) {
    const fileByPath = new Map(files.map((file) => [normalizePath(file.path), file]));
    const groupByPath = new Map(groups.flatMap((group) => group.filePaths.map((filePath) => [normalizePath(filePath), group.id])));
    const edges = [];
    for (const file of files) {
        const fromGroup = groupByPath.get(normalizePath(file.path));
        for (const importPath of extractImports(file)) {
            const targetPath = resolveChangedFile(file.path, importPath, fileByPath);
            const toGroup = targetPath ? groupByPath.get(targetPath) : undefined;
            if (fromGroup && toGroup && fromGroup !== toGroup) {
                edges.push({ from: fromGroup, to: toGroup, file: file.path, importPath });
            }
        }
    }
    return edges.filter((edge, index, all) =>
        all.findIndex((candidate) => candidate.from === edge.from && candidate.to === edge.to) === index);
}

function hunkEvidence(file, reason) {
    if (!file.hunks.length) {
        return [{ file: file.path, reason, hunk: null, lineStart: null, lineEnd: null }];
    }
    return file.hunks.map((hunk) => {
        let line = hunk.newStart;
        let lineStart = null;
        let lineEnd = null;
        for (const content of hunk.lines) {
            if (content.startsWith("+") && !content.startsWith("+++")) {
                lineStart ??= line;
                lineEnd = line;
                line += 1;
            } else if (!content.startsWith("-") || content.startsWith("---")) {
                line += 1;
            }
        }
        return {
            file: file.path,
            reason,
            hunk: hunk.header,
            lineStart,
            lineEnd,
        };
    });
}

function buildFileMetadata(file) {
    return {
        path: file.path,
        oldPath: file.oldPath,
        newPath: file.newPath,
        additions: file.additions,
        deletions: file.deletions,
        changedLines: file.additions + file.deletions,
        binary: file.binary,
        patch: file.patch,
        hunks: file.hunks.map((hunk) => ({
            header: hunk.header,
            oldStart: hunk.oldStart,
            oldCount: hunk.oldCount,
            newStart: hunk.newStart,
            newCount: hunk.newCount,
            context: hunk.context,
        })),
    };
}

function scoreImpact(role, files, dependencyCount) {
    const changedLines = files.reduce((total, file) => total + file.additions + file.deletions, 0);
    const patch = files.map((file) => file.patch).join("\n").toLowerCase();
    const paths = files.map((file) => normalizePath(file.path).toLowerCase()).join("\n");
    const signals = [];
    let score = Math.min(30, changedLines);
    const addSignal = (name, points) => {
        signals.push(name);
        score += points;
    };
    if (/\bbreaking(?: change)?\b|!:\s*$/.test(patch)) addSignal("breaking change", 70);
    if (role === "database" || /(^|\/)(migration|migrations|schema|database|db)(\/|$)/.test(paths)) addSignal("database or migration", 65);
    if (role === "api" || /\b(export|public|endpoint|route|graphql|rest)\b/.test(patch)) addSignal("public API boundary", 55);
    if (role === "security" || /\b(auth|permission|role|credential|token|oauth|jwt)\b/.test(paths + "\n" + patch)) addSignal("auth or permissions", 65);
    if (/\b(transaction|integrity|constraint|foreign key|unique index|validation)\b/.test(patch)) addSignal("data integrity", 55);
    if (role === "dependencies" || files.some((file) => file.additions + file.deletions > 40)) addSignal("broad dependency or change range", 45);
    if (dependencyCount > 0) addSignal("cross-group dependency", Math.min(20, dependencyCount * 5));

    let level = "low";
    if (score >= 55) {
        level = "high";
    } else if (score >= 25) {
        level = "medium";
    }
    const reason = signals.length ? signals.join("、") : "変更量とファイルの特徴から推定";
    return { level, score, reason, signals, changedLines };
}

function groupId(filePaths, role) {
    return `group-${hashText(`${[...filePaths].sort().join("\n")}|${role}`)}`;
}

function buildSections(files) {
    const groups = new Map();
    for (const file of files) {
        const role = classifyFile(file);
        const group = groups.get(role) || [];
        group.push(file);
        groups.set(role, group);
    }

    return [...groups.entries()].map(([role, groupFiles]) => {
        const filePaths = groupFiles.map((file) => file.path);
        const changedLines = groupFiles.reduce((total, file) => total + file.additions + file.deletions, 0);
        const summary = `${groupFiles.length}ファイルの${ROLE_LABELS[role] || "変更"}です。追加${groupFiles.reduce((total, file) => total + file.additions, 0)}行・削除${groupFiles.reduce((total, file) => total + file.deletions, 0)}行。`;
        return {
            id: groupId(filePaths, role),
            title: ROLE_LABELS[role] || "変更",
            role,
            summary,
            description: summary,
            impact: scoreImpact(role, groupFiles, 0),
            evidence: groupFiles.flatMap((file) => hunkEvidence(file, "変更されたファイルとハンク")),
            relatedGroups: [],
            uncertainty: "ファイルパス、差分量、変更内容からの決定的な推定です。",
            detail: changedLines > 40 ? "変更量が多いため、ハンク単位で意図と回帰リスクを確認してください。" : "",
            files: groupFiles.map(buildFileMetadata),
            filePaths,
            diff: groupFiles.map((file) => file.patch).join("\n\n"),
            diffFingerprint: hashText(groupFiles.map((file) => file.patch).join("\n\n")),
            diffTruncated: false,
            source: "deterministic",
            aiError: "",
        };
    });
}

function orderGroups(groups) {
    return [...groups].sort((left, right) => {
        if ((left.role === "support") !== (right.role === "support")) {
            return left.role === "support" ? 1 : -1;
        }
        const impactOrder = (IMPACT_RANK[right.impact?.level] || 0) - (IMPACT_RANK[left.impact?.level] || 0);
        if (impactOrder) return impactOrder;
        const lineOrder = (right.impact?.changedLines || 0) - (left.impact?.changedLines || 0);
        if (lineOrder) return lineOrder;
        return String(left.filePaths?.[0] || "").localeCompare(String(right.filePaths?.[0] || ""));
    });
}

function attachDependencyImpact(groups, files) {
    const edges = buildDependencies(files, groups);
    const dependencyCounts = new Map();
    for (const edge of edges) {
        dependencyCounts.set(edge.from, (dependencyCounts.get(edge.from) || 0) + 1);
        dependencyCounts.set(edge.to, (dependencyCounts.get(edge.to) || 0) + 1);
    }
    const withImpact = groups.map((group) => {
        const groupFiles = files.filter((file) => group.filePaths.includes(file.path));
        return { ...group, impact: scoreImpact(group.role, groupFiles, dependencyCounts.get(group.id) || 0) };
    });
    const ordered = orderGroups(withImpact);
    const validIds = new Set(ordered.map((group) => group.id));
    return {
        groups: ordered.map((group) => ({
            ...group,
            relatedGroups: unique(edges
                .filter((edge) => edge.from === group.id || edge.to === group.id)
                .map((edge) => edge.from === group.id ? edge.to : edge.from)
                .filter((id) => validIds.has(id))),
        })),
        edges,
    };
}

function buildSupportGroup(files, reason, rawDiff = "") {
    const filePaths = files.map((file) => file.path);
    return {
        id: groupId(filePaths.length ? filePaths : ["unparsed"], "support"),
        title: "横断・サポート",
        role: "support",
        summary: reason,
        description: reason,
        impact: { level: "medium", score: 25, reason, signals: ["partial analysis"], changedLines: files.reduce((sum, file) => sum + file.additions + file.deletions, 0) },
        evidence: files.flatMap((file) => hunkEvidence(file, reason)),
        relatedGroups: [],
        uncertainty: reason,
        detail: "",
        files: files.map(buildFileMetadata),
        filePaths,
        diff: files.map((file) => file.patch).join("\n\n") || rawDiff,
        diffFingerprint: hashText(files.map((file) => file.patch).join("\n\n") || rawDiff || reason),
        diffTruncated: false,
        source: "deterministic",
        aiError: "",
    };
}

function calculateStats(diff, files, groups, unparsedFiles = []) {
    const additions = files.reduce((total, file) => total + file.additions, 0);
    const deletions = files.reduce((total, file) => total + file.deletions, 0);
    return {
        files: files.length,
        additions,
        deletions,
        groups: groups.length,
        highImpact: groups.filter((group) => group.impact?.level === "high").length,
        diffLines: String(diff ?? "").split(/\r?\n/).length,
        unparsedFiles: unparsedFiles.length,
        partial: unparsedFiles.length > 0,
    };
}

function analyzeDiff(diff) {
    const text = String(diff ?? "");
    const allFiles = parseUnifiedDiff(text);
    const overLimit = Buffer.byteLength(text, "utf8") > MAX_DIFF_BYTES;
    const parsedFiles = [];
    const unparsedFiles = [];
    let remaining = MAX_DIFF_BYTES;
    for (const file of allFiles) {
        const size = Buffer.byteLength(file.patch, "utf8");
        if (!overLimit || size <= remaining) {
            parsedFiles.push(file);
            remaining -= size;
        } else {
            unparsedFiles.push(file.path);
        }
    }
    if (overLimit && allFiles.length === 0) {
        unparsedFiles.push("(差分全体)");
    }

    let groups = buildSections(parsedFiles);
    const internal = attachDependencyImpact(groups, parsedFiles);
    groups = internal.groups;
    let reason = "";
    if (unparsedFiles.length) {
        reason = overLimit
            ? `差分が解析上限${Math.round(MAX_DIFF_BYTES / 1_000_000)}MBを超えたため、${unparsedFiles.length}件は未解析です。`
            : `差分の一部を解析できなかったため、${unparsedFiles.length}件は未解析です。`;
        groups.push(buildSupportGroup(
            allFiles.filter((file) => unparsedFiles.includes(file.path)),
            reason,
            allFiles.length === 0 ? text : "",
        ));
        groups = orderGroups(groups);
    } else if (groups.length === 0 && text.trim()) {
        reason = "標準的なUnified Diffのファイルヘッダーを検出できないため、差分全体を未分類として保持しています。";
        groups = [buildSupportGroup([], reason, text)];
    }
    const stats = calculateStats(text, allFiles, groups, unparsedFiles);
    return {
        groups,
        stats,
        dependencyEdges: internal.edges,
        unparsedFiles,
        unparsedReason: reason,
        diffFingerprint: hashText(text),
    };
}

function reconcileSections(previousGroups, nextGroups) {
    // Kept as a compatibility export for old callers. Human-edited state is no
    // longer preserved; deterministic analysis is the source of truth.
    return nextGroups;
}

export {
    ROLE_LABELS,
    parseUnifiedDiff,
    classifyFile,
    buildSections,
    buildDependencies,
    calculateStats,
    buildSupportGroup,
    orderGroups,
    reconcileSections,
    analyzeDiff,
    groupId,
};
