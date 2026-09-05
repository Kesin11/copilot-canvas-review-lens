import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const EXTENSION_NAME = "pr-review-lens";
const MAX_DIFF_BYTES = 3_000_000;
const MAX_REQUEST_BYTES = 4_000_000;
const MAX_SECTION_DIFF_CHARS = 18_000;
const MAX_REVIEW_ARTIFACTS = 100;
const REVIEW_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const servers = new Map();
const states = new Map();
const subscribers = new Map();
const mutationQueues = new Map();
let runtimeSession;

const KIND_LABELS = {
    security: "権限・セキュリティ",
    database: "データベース・スキーマ",
    dependencies: "依存関係・ビルド",
    api: "API・サーバー境界",
    frontend: "画面・UI",
    tests: "テスト",
    docs: "ドキュメント",
    config: "設定",
    implementation: "実装",
};

const IMPORTANCE_LABELS = {
    high: "高",
    medium: "中",
    low: "低",
};

const STATUS_LABELS = {
    unreviewed: "未確認",
    reviewing: "確認中",
    accepted: "問題なし",
    "needs-attention": "要確認",
};

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeIdentifier(value, fallback = "review") {
    const normalized = String(value ?? "")
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return normalized || fallback;
}

function hashText(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function resolveReviewId(input) {
    if (typeof input?.reviewId === "string" && input.reviewId.trim()) {
        return safeIdentifier(input.reviewId);
    }
    if (typeof input?.repository === "string" && Number.isInteger(input.pullRequestNumber)) {
        return safeIdentifier(`pr-${input.repository}-${input.pullRequestNumber}`);
    }
    if (typeof input?.diff === "string" && input.diff.length > 0) {
        return `diff-${hashText(input.diff)}`;
    }
    return "new-review";
}

function getArtifactsDirectory() {
    const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
    return path.join(copilotHome, "extensions", EXTENSION_NAME, "artifacts", "reviews");
}

function getStatePath(reviewId) {
    return path.join(getArtifactsDirectory(), `${safeIdentifier(reviewId)}.json`);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizePath(value) {
    return String(value ?? "")
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/^\/+/, "");
}

function stripDiffPath(value) {
    const raw = String(value ?? "").trim();
    if (!raw || raw === "/dev/null") {
        return "";
    }
    const unquoted = raw.replace(/^["']|["']$/g, "");
    return normalizePath(unquoted.replace(/^(?:a|b)\//, ""));
}

function getPathFromDiffLine(line) {
    const value = String(line).slice(4).trim();
    return stripDiffPath(value.split("\t")[0]);
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function truncateText(value, maxLength = MAX_SECTION_DIFF_CHARS) {
    if (value.length <= maxLength) {
        return { text: value, truncated: false };
    }
    return {
        text: `${value.slice(0, maxLength)}\n\n[差分が長いため省略されました]`,
        truncated: true,
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

function createEmptyState(reviewId, input = {}) {
    return {
        version: 1,
        reviewId,
        title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : "PRレビュー補助",
        repository: typeof input.repository === "string" ? input.repository : "",
        pullRequestNumber: Number.isInteger(input.pullRequestNumber) ? input.pullRequestNumber : null,
        baseRef: typeof input.baseRef === "string" ? input.baseRef : "",
        headRef: typeof input.headRef === "string" ? input.headRef : "",
        diff: "",
        sections: [],
        dependencies: { nodes: [], edges: [] },
        diagrams: { flowchart: "flowchart LR", sequence: "sequenceDiagram" },
        stats: calculateStats("", [], []),
        updatedAt: new Date().toISOString(),
    };
}

function normalizeDependencies(value, fallback = { nodes: [], edges: [] }) {
    const source = isRecord(value) ? value : {};
    return {
        nodes: Array.isArray(source.nodes) ? source.nodes.filter(isRecord) : fallback.nodes,
        edges: Array.isArray(source.edges) ? source.edges.filter(isRecord) : fallback.edges,
    };
}

function normalizeStoredState(raw, reviewId) {
    if (!isRecord(raw)) {
        throw new Error("保存されたレビュー状態の形式が不正です。");
    }
    const empty = createEmptyState(reviewId);
    const diagrams = isRecord(raw.diagrams) ? raw.diagrams : {};
    const stats = isRecord(raw.stats) ? raw.stats : {};
    return {
        ...empty,
        ...raw,
        reviewId,
        sections: Array.isArray(raw.sections) ? raw.sections.filter(isRecord) : [],
        dependencies: normalizeDependencies(raw.dependencies, empty.dependencies),
        diagrams: { ...empty.diagrams, ...diagrams },
        stats: { ...empty.stats, ...stats },
    };
}

async function loadState(reviewId) {
    if (states.has(reviewId)) {
        return states.get(reviewId);
    }
    try {
        const content = await readFile(getStatePath(reviewId), "utf8");
        const state = normalizeStoredState(JSON.parse(content), reviewId);
        states.set(reviewId, state);
        return state;
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
        const state = createEmptyState(reviewId);
        states.set(reviewId, state);
        return state;
    }
}

function isReviewOpen(reviewId) {
    return [...servers.values()].some((entry) => entry.reviewId === reviewId);
}

function releaseReviewState(reviewId) {
    if (!isReviewOpen(reviewId) && !subscribers.has(reviewId) && !mutationQueues.has(reviewId)) {
        states.delete(reviewId);
    }
}

async function pruneReviewArtifacts(preserveReviewId) {
    let entries;
    try {
        entries = await readdir(getArtifactsDirectory(), { withFileTypes: true });
    } catch (error) {
        if (error?.code === "ENOENT") {
            return;
        }
        throw error;
    }

    const cutoff = Date.now() - REVIEW_RETENTION_MS;
    const candidates = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
            continue;
        }
        const reviewId = entry.name.slice(0, -".json".length);
        if (reviewId === safeIdentifier(preserveReviewId) || isReviewOpen(reviewId) || mutationQueues.has(reviewId)) {
            continue;
        }
        const filePath = path.join(getArtifactsDirectory(), entry.name);
        try {
            const metadata = await stat(filePath);
            if (metadata.mtimeMs < cutoff) {
                await unlink(filePath);
            } else {
                candidates.push({ filePath, mtimeMs: metadata.mtimeMs });
            }
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }

    candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
    const excess = candidates.length - MAX_REVIEW_ARTIFACTS;
    for (const candidate of candidates.slice(0, Math.max(0, excess))) {
        await unlink(candidate.filePath).catch((error) => {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        });
    }
}

async function saveState(state) {
    const reviewId = state.reviewId;
    state.updatedAt = new Date().toISOString();
    states.set(reviewId, state);

    const directory = getArtifactsDirectory();
    await mkdir(directory, { recursive: true });
    const target = getStatePath(reviewId);
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rename(temporary, target);
    await pruneReviewArtifacts(reviewId);
}

function queueReviewMutation(reviewId, mutator) {
    const previous = mutationQueues.get(reviewId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
        const current = await loadState(reviewId);
        const next = await mutator(clone(current));
        if (!isRecord(next) || next.reviewId !== reviewId) {
            throw new Error("レビュー状態の更新結果が不正です。");
        }
        await saveState(next);
        publishState(reviewId, next);
        return next;
    });
    mutationQueues.set(reviewId, operation);
    return operation.finally(() => {
        if (mutationQueues.get(reviewId) === operation) {
            mutationQueues.delete(reviewId);
        }
        releaseReviewState(reviewId);
    });
}

function publishState(reviewId, state) {
    const clients = subscribers.get(reviewId);
    if (!clients) {
        return;
    }
    const message = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) {
        try {
            client.write(message);
        } catch {
            clients.delete(client);
        }
    }
}

function closeSubscribers(reviewId) {
    const clients = subscribers.get(reviewId);
    if (!clients) {
        return;
    }
    for (const client of clients) {
        client.end();
    }
    subscribers.delete(reviewId);
}

async function applyReviewInput(reviewId, input) {
    if (input.diff !== undefined) {
        validateDiff(input.diff);
    }
    return queueReviewMutation(reviewId, (next) => {
        if (typeof input.title === "string" && input.title.trim()) {
            next.title = input.title.trim();
        }
        if (typeof input.repository === "string") {
            next.repository = input.repository;
        }
        if (Number.isInteger(input.pullRequestNumber)) {
            next.pullRequestNumber = input.pullRequestNumber;
        }
        if (typeof input.baseRef === "string") {
            next.baseRef = input.baseRef;
        }
        if (typeof input.headRef === "string") {
            next.headRef = input.headRef;
        }
        if (typeof input.diff === "string" && (next.diff !== input.diff || next.sections.length === 0)) {
            const analysis = analyzeDiff(input.diff);
            const sections = reconcileSections(next.sections, analysis.sections);
            next.diff = input.diff;
            next.sections = sections;
            next.dependencies = analysis.dependencies;
            next.diagrams = buildDiagrams(sections, next.dependencies);
            next.stats = {
                ...analysis.stats,
                sections: sections.length,
                highImportance: sections.filter((section) => section.importance === "high").length,
            };
        }
        return next;
    });
}

function getServerEntry(instanceId) {
    const entry = servers.get(instanceId);
    if (!entry) {
        throw new CanvasError("canvas_instance_not_found", "指定されたCanvasインスタンスが見つかりません。");
    }
    return entry;
}

function getRequestPath(req) {
    return new URL(req.url || "/", "http://127.0.0.1").pathname;
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
}

function sendError(res, error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "Canvas内部で処理に失敗しました。";
    sendJson(res, status, { error: message });
    if (!(error instanceof HttpError)) {
        runtimeSession?.log(error instanceof Error ? error.message : String(error), {
            level: "error",
            ephemeral: true,
        });
    }
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        req.on("data", (chunk) => {
            if (settled) {
                return;
            }
            total += chunk.length;
            if (total > MAX_REQUEST_BYTES) {
                settled = true;
                reject(new HttpError(413, "リクエストが大きすぎます。"));
                req.resume();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (settled) {
                return;
            }
            try {
                const text = Buffer.concat(chunks).toString("utf8");
                resolve(text ? JSON.parse(text) : {});
            } catch {
                reject(new HttpError(400, "JSON形式のリクエストが必要です。"));
            }
        });
        req.on("error", (error) => {
            if (!settled) {
                reject(error);
            }
        });
    });
}

function validateDiff(diff) {
    if (typeof diff !== "string") {
        throw new HttpError(400, "diffには文字列を指定してください。");
    }
    if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
        throw new HttpError(413, "差分が大きすぎます。3MB以下の差分を指定してください。");
    }
}

function validateImportance(value) {
    return IMPORTANCE_LABELS[value] ? value : "medium";
}

function validateStatus(value) {
    return STATUS_LABELS[value] ? value : "unreviewed";
}

function isString(value) {
    return typeof value === "string";
}

// Prefers `candidate` when it is an array (optionally filtered), otherwise falls
// back to the previously stored array, otherwise undefined.
function pickArray(candidate, fallback, filterFn) {
    if (Array.isArray(candidate)) {
        return filterFn ? candidate.filter(filterFn) : candidate;
    }
    return Array.isArray(fallback) ? fallback : undefined;
}

function normalizeSectionUpdate(item, existing, index) {
    const source = isRecord(item) ? item : {};
    const fallback = existing || {};
    const id = safeIdentifier(source.id || fallback.id || `agent-section-${index + 1}`, `agent-section-${index + 1}`);
    const files = pickArray(source.files, fallback.files) || [];
    const filePaths =
        pickArray(source.filePaths, fallback.filePaths, isString) || files.map((file) => file.path).filter(Boolean);
    const reviewQuestions = pickArray(source.reviewQuestions, fallback.reviewQuestions, isString) || [];
    return {
        ...fallback,
        ...source,
        id,
        title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : fallback.title || `レビューセクション ${index + 1}`,
        description: typeof source.description === "string" ? source.description : fallback.description || "",
        importance: validateImportance(source.importance || fallback.importance),
        importanceReason: typeof source.importanceReason === "string" ? source.importanceReason : fallback.importanceReason || "",
        status: validateStatus(source.status || fallback.status),
        notes: typeof source.notes === "string" ? source.notes : fallback.notes || "",
        reviewQuestions,
        files,
        filePaths,
        diff: typeof source.diff === "string" ? source.diff : fallback.diff || "",
        diffFingerprint: typeof source.diffFingerprint === "string" ? source.diffFingerprint : fallback.diffFingerprint || "",
        diffTruncated: Boolean(source.diffTruncated ?? fallback.diffTruncated),
    };
}

function renderHtml(instanceId) {
    const encodedInstanceId = JSON.stringify(instanceId).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PR Review Lens</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--background-color-default, #ffffff);
      --panel: var(--background-color-secondary, #f6f8fa);
      --border: var(--border-color-default, #d0d7de);
      --text: var(--text-color-default, #1f2328);
      --muted: var(--text-color-muted, #656d76);
      --accent: var(--true-color-blue, #0969da);
      --accent-muted: var(--true-color-blue-muted, #ddf4ff);
      --danger: var(--true-color-red, #cf222e);
      --warning: #9a6700;
      --success: #1a7f37;
      --code-bg: #161b22;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 15px; margin-bottom: 6px; }
    button, input, textarea, select {
      font: inherit;
      color: inherit;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
    }
    button {
      cursor: pointer;
      padding: 6px 10px;
      background: var(--panel);
    }
    button:hover { border-color: var(--accent); }
    button.primary { color: #fff; background: var(--accent); border-color: var(--accent); }
    button.ghost { background: transparent; }
    textarea, input, select { width: 100%; padding: 7px 8px; }
    textarea { resize: vertical; min-height: 72px; }
    .topbar, .toolbar, .actions, .meta, .summary, .section-heading, .section-footer {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .topbar { justify-content: space-between; gap: 16px; margin-bottom: 16px; }
    .topbar p, .hint, .muted { color: var(--muted); }
    .topbar p { margin-bottom: 0; }
    .toolbar { flex-shrink: 0; }
    .input-panel, .panel, .section-card, .empty {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
    }
    .input-panel { padding: 12px; margin-bottom: 16px; }
    .input-panel summary { cursor: pointer; font-weight: 600; }
    .input-content { padding-top: 10px; }
    label { display: block; font-weight: 600; margin-bottom: 5px; }
    .hint { font-size: 12px; margin: 6px 0 0; }
    .actions { justify-content: flex-end; margin-top: 8px; }
    .summary { flex-wrap: wrap; margin-bottom: 16px; }
    .stat {
      min-width: 110px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
    }
    .stat strong { display: block; font-size: 20px; line-height: 24px; }
    .stat span { color: var(--muted); font-size: 12px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, .85fr); gap: 16px; align-items: start; }
    .section-heading { justify-content: space-between; margin-bottom: 10px; }
    .section-heading h2 { margin-bottom: 0; }
    .section-card { padding: 12px; margin-bottom: 12px; background: var(--bg); }
    .section-heading-card { align-items: flex-start; justify-content: space-between; }
    .section-heading-card input { font-weight: 600; }
    .section-description { margin: 8px 0; }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .importance-high { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .importance-medium { color: var(--warning); background: color-mix(in srgb, #d4a72c 18%, transparent); }
    .importance-low { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
    .section-grid { display: grid; grid-template-columns: minmax(0, 1fr) 150px; gap: 8px; }
    .section-meta { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0; }
    .file-chip { border: 1px solid var(--border); border-radius: 999px; padding: 2px 7px; color: var(--muted); font-size: 12px; }
    .diff {
      overflow: auto;
      max-height: 360px;
      margin: 10px 0;
      padding: 10px;
      border-radius: 6px;
      background: var(--code-bg);
      color: #e6edf3;
      font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
      font-size: 12px;
      line-height: 18px;
      white-space: pre;
    }
    .diff-line-add { color: #aff5b4; background: rgba(46, 160, 67, .18); }
    .diff-line-del { color: #ffb3b3; background: rgba(248, 81, 73, .18); }
    .review-questions { margin: 8px 0; padding: 8px 8px 8px 26px; border-left: 3px solid var(--accent); background: var(--panel); }
    .review-questions li { margin: 3px 0; }
    .section-footer { justify-content: flex-end; }
    .panel { padding: 12px; margin-bottom: 12px; }
    .panel h2 { display: flex; justify-content: space-between; align-items: center; }
    .graph { display: grid; gap: 6px; margin-bottom: 10px; }
    .node { padding: 7px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
    .node small { display: block; color: var(--muted); }
    .edge { color: var(--muted); font-size: 12px; padding-left: 10px; }
    .mermaid-view {
      overflow: auto;
      min-height: 120px;
      margin: 0;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
    }
    .mermaid-view svg {
      display: block;
      min-width: 260px;
      max-width: none;
    }
    .mermaid-view .diagram-node {
      fill: var(--background-color-default, #ffffff);
      stroke: var(--border-color-default, #d0d7de);
      stroke-width: 1.5;
    }
    .mermaid-view .diagram-edge {
      stroke: var(--text-color-muted, #656d76);
      stroke-width: 1.5;
    }
    .mermaid-view .diagram-arrow {
      fill: var(--text-color-muted, #656d76);
    }
    .mermaid-view .diagram-lifeline {
      stroke: var(--border-color-default, #d0d7de);
      stroke-dasharray: 4 4;
    }
    .mermaid-view text {
      fill: var(--text-color-default, #1f2328);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: 12px;
    }
    .mermaid-view .diagram-muted {
      fill: var(--text-color-muted, #656d76);
    }
    .diagram-source {
      margin-top: 8px;
    }
    .diagram-source summary {
      cursor: pointer;
      color: var(--text-color-muted, #656d76);
      font-size: 12px;
    }
    .diagram-source pre {
      overflow: auto;
      margin: 0;
      padding: 8px;
      border-radius: 6px;
      background: var(--code-bg);
      color: #e6edf3;
      font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
      font-size: 11px;
      line-height: 16px;
      white-space: pre;
    }
    .diagram-fallback {
      margin: 0;
      color: var(--text-color-muted, #656d76);
      font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
      font-size: 11px;
      white-space: pre-wrap;
    }
    .empty { padding: 18px; color: var(--muted); text-align: center; }
    #toast { position: fixed; right: 16px; bottom: 16px; max-width: 320px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); box-shadow: 0 4px 18px rgba(0,0,0,.16); }
    .hidden { display: none !important; }
    @media (max-width: 850px) {
      body { padding: 14px; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .layout { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div>
      <h1 id="title">PR Review Lens</h1>
      <p>差分を意味単位で読み解き、レビュー時の認知負荷を下げるCanvas</p>
    </div>
    <div class="toolbar">
      <button class="ghost" id="refresh">再読み込み</button>
    </div>
  </header>

  <details class="input-panel" open>
    <summary>レビュー対象のUnified Diff</summary>
    <div class="input-content">
      <label for="diffInput">差分を貼り付け</label>
      <textarea id="diffInput" rows="8" placeholder="git diff またはPull RequestのUnified Diffを貼り付けてください"></textarea>
      <p class="hint">Canvasは差分をローカルで解析します。初期分類は推定値なので、タイトル・説明・重要度をレビューの観点に合わせて編集できます。</p>
      <div class="actions">
        <button class="primary" id="loadDiff">解析して表示</button>
      </div>
    </div>
  </details>

  <section class="summary" id="summary"></section>
  <div class="layout">
    <main>
      <div class="section-heading">
        <h2>意味単位のレビューセクション</h2>
        <span class="muted" id="updatedAt"></span>
      </div>
      <div id="sections"></div>
    </main>
    <aside>
      <section class="panel">
        <h2>モジュール依存関係</h2>
        <div id="graph"></div>
        <div id="edges"></div>
      </section>
      <section class="panel">
        <h2>フローチャート</h2>
        <div class="mermaid-view" id="flowchart"></div>
        <details class="diagram-source">
          <summary>Mermaidソースを表示</summary>
          <pre id="flowchart-source"></pre>
        </details>
      </section>
      <section class="panel">
        <h2>シーケンス図</h2>
        <div class="mermaid-view" id="sequence"></div>
        <details class="diagram-source">
          <summary>Mermaidソースを表示</summary>
          <pre id="sequence-source"></pre>
        </details>
      </section>
    </aside>
  </div>
  <div id="toast" class="hidden" role="status"></div>

  <script>
    window.__INSTANCE_ID__ = ${encodedInstanceId};
    (function () {
      var state = null;
      var toastTimer;
      var diffInput = document.getElementById("diffInput");
      var sectionDrafts = Object.create(null);
      var IMPORTANCE_LABELS = { high: "高", medium: "中", low: "低" };
      var STATUS_LABELS = { unreviewed: "未確認", reviewing: "確認中", accepted: "問題なし", "needs-attention": "要確認" };

      function request(path, options) {
        var config = options || {};
        config.headers = Object.assign({ "Content-Type": "application/json" }, config.headers || {});
        return fetch(path, config).then(function (response) {
          return response.text().then(function (text) {
            var payload = text ? JSON.parse(text) : {};
            if (!response.ok) {
              throw new Error(payload.error || "リクエストに失敗しました。");
            }
            return payload;
          });
        });
      }

      function showToast(message) {
        var toast = document.getElementById("toast");
        toast.textContent = message;
        toast.classList.remove("hidden");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toast.classList.add("hidden"); }, 3200);
      }

      function element(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text !== undefined) { node.textContent = text; }
        return node;
      }

      function importanceText(importance) {
        return "重要度: " + (IMPORTANCE_LABELS[importance] || IMPORTANCE_LABELS.medium);
      }

      function importanceBadge(importance) {
        return element("span", "badge importance-" + importance, importanceText(importance));
      }

      function diffLineClass(line) {
        if (line.indexOf("+") === 0 && line.indexOf("+++") !== 0) {
          return "diff-line-add";
        }
        if (line.indexOf("-") === 0 && line.indexOf("---") !== 0) {
          return "diff-line-del";
        }
        return "";
      }

      function renderDiff(target, text) {
        target.textContent = "";
        String(text || "").split("\\n").forEach(function (line) {
          target.appendChild(element("span", diffLineClass(line), line + "\\n"));
        });
      }

      function getSectionDraft(card) {
        return {
          title: card.querySelector(".section-title").value,
          description: card.querySelector(".section-description").value,
          importance: card.querySelector(".section-importance").value,
          status: card.querySelector(".section-status").value,
          notes: card.querySelector(".section-notes").value
        };
      }

      function rememberSectionDraft(event) {
        var card = event.target.closest(".section-card");
        if (card) {
          sectionDrafts[card.dataset.id] = getSectionDraft(card);
        }
      }

      function saveSection(section) {
        var payload = getSectionDraft(section);
        return request("/api/sections/" + encodeURIComponent(section.dataset.id), {
          method: "PATCH",
          body: JSON.stringify(payload)
        }).then(function (next) {
          delete sectionDrafts[section.dataset.id];
          state = next;
          render();
          showToast("セクションを保存しました。");
        });
      }

      function renderSections() {
        var container = document.getElementById("sections");
        container.textContent = "";
        Object.keys(sectionDrafts).forEach(function (sectionId) {
          if (!state.sections.some(function (section) { return section.id === sectionId; })) {
            delete sectionDrafts[sectionId];
          }
        });
        if (!state.sections.length) {
          container.appendChild(element("div", "empty", "差分を入力すると、意味単位のセクションがここに表示されます。"));
          return;
        }
        state.sections.forEach(function (section) {
          var displayed = Object.assign({}, section, sectionDrafts[section.id] || {});
          var card = element("article", "section-card");
          card.dataset.id = section.id;
          var heading = element("div", "section-heading-card");
          var title = document.createElement("input");
          title.className = "section-title";
          title.value = displayed.title || "";
          title.setAttribute("aria-label", "セクションタイトル");
          heading.appendChild(title);
          var badge = importanceBadge(displayed.importance);
          heading.appendChild(badge);
          card.appendChild(heading);

          var grid = element("div", "section-grid");
          var description = document.createElement("textarea");
          description.className = "section-description";
          description.value = displayed.description || "";
          description.setAttribute("aria-label", "セクション説明");
          grid.appendChild(description);
          var controls = element("div");
          var importance = document.createElement("select");
          importance.className = "section-importance";
          importance.setAttribute("aria-label", "重要度");
          Object.keys(IMPORTANCE_LABELS).forEach(function (value) {
            var option = document.createElement("option");
            option.value = value;
            option.textContent = importanceText(value);
            option.selected = displayed.importance === value;
            importance.appendChild(option);
          });
          var status = document.createElement("select");
          status.className = "section-status";
          status.setAttribute("aria-label", "レビュー状態");
          Object.keys(STATUS_LABELS).forEach(function (value) {
            var option = document.createElement("option");
            option.value = value;
            option.textContent = STATUS_LABELS[value];
            option.selected = displayed.status === value;
            status.appendChild(option);
          });
          controls.appendChild(importance);
          controls.appendChild(status);
          grid.appendChild(controls);
          card.appendChild(grid);

          var meta = element("div", "section-meta");
          (section.filePaths || []).forEach(function (filePath) { meta.appendChild(element("span", "file-chip", filePath)); });
          if (section.diffTruncated) { meta.appendChild(element("span", "muted", "差分抜粋")); }
          card.appendChild(meta);

          var diff = element("pre", "diff");
          renderDiff(diff, section.diff);
          card.appendChild(diff);

          var reason = element("p", "hint", "重要度の推定理由: " + (section.importanceReason || "未設定"));
          card.appendChild(reason);
          if (section.reviewQuestions && section.reviewQuestions.length) {
            var questionList = element("ul", "review-questions");
            questionList.appendChild(element("strong", "", "確認観点"));
            section.reviewQuestions.forEach(function (question) {
              questionList.appendChild(element("li", "", question));
            });
            card.appendChild(questionList);
          }
          var notes = document.createElement("textarea");
          notes.className = "section-notes";
          notes.placeholder = "レビュー観点、確認結果、懸念点を記録";
          notes.value = displayed.notes || "";
          notes.setAttribute("aria-label", "レビュー注記");
          card.appendChild(notes);
          [title, description, importance, status, notes].forEach(function (field) {
            field.addEventListener("input", rememberSectionDraft);
            field.addEventListener("change", rememberSectionDraft);
          });
          importance.addEventListener("change", function () {
            badge.className = "badge importance-" + importance.value;
            badge.textContent = importanceText(importance.value);
          });
          var footer = element("div", "section-footer");
          var save = element("button", "primary", "注記を保存");
          save.addEventListener("click", function () {
            save.disabled = true;
            saveSection(card).catch(function (error) { showToast(error.message); }).finally(function () { save.disabled = false; });
          });
          footer.appendChild(save);
          card.appendChild(footer);
          container.appendChild(card);
        });
      }

      function renderSummary() {
        var summary = document.getElementById("summary");
        summary.textContent = "";
        var stats = state.stats || {};
        [["sections", "セクション"], ["files", "変更ファイル"], ["additions", "追加行"], ["deletions", "削除行"], ["highImportance", "高重要度"]].forEach(function (item) {
          var stat = element("div", "stat");
          stat.appendChild(element("strong", "", String(stats[item[0]] || 0)));
          stat.appendChild(element("span", "", item[1]));
          summary.appendChild(stat);
        });
        document.getElementById("title").textContent = state.title || "PRレビュー補助";
        document.getElementById("updatedAt").textContent = state.updatedAt ? "更新: " + new Date(state.updatedAt).toLocaleString() : "";
        if (document.activeElement !== diffInput) { diffInput.value = state.diff || ""; }
      }

      function renderDependencies() {
        var graph = document.getElementById("graph");
        var edges = document.getElementById("edges");
        graph.textContent = "";
        edges.textContent = "";
        var dependencies = state.dependencies || { nodes: [], edges: [] };
        if (!dependencies.nodes.length) {
          graph.appendChild(element("div", "muted", "変更ファイル間の依存関係は検出されませんでした。"));
        } else {
          dependencies.nodes.forEach(function (node) {
            var item = element("div", "node");
            item.appendChild(element("strong", "", node.label));
            var section = (state.sections || []).find(function (candidate) { return candidate.id === node.sectionId; });
            item.appendChild(element("small", "", section ? section.title : "セクション未紐付け"));
            graph.appendChild(item);
          });
        }
        (dependencies.edges || []).forEach(function (edge) {
          var from = dependencies.nodes.find(function (node) { return node.id === edge.from; });
          var to = dependencies.nodes.find(function (node) { return node.id === edge.to; });
          edges.appendChild(element("div", "edge", (from ? from.label : edge.from) + " → " + (to ? to.label : edge.to) + (edge.label ? " (" + edge.label + ")" : "")));
        });
      }

      var SVG_NS = "http://www.w3.org/2000/svg";

      function svgNode(name, attributes, text) {
        var node = document.createElementNS(SVG_NS, name);
        Object.keys(attributes || {}).forEach(function (key) {
          if (attributes[key] !== undefined && attributes[key] !== null) {
            node.setAttribute(key, attributes[key]);
          }
        });
        if (text !== undefined) {
          node.textContent = text;
        }
        return node;
      }

      function addArrowMarker(svg, id) {
        var defs = svgNode("defs");
        var marker = svgNode("marker", {
          id: id,
          viewBox: "0 0 8 8",
          refX: "7",
          refY: "4",
          markerWidth: "8",
          markerHeight: "8",
          orient: "auto",
          markerUnits: "strokeWidth"
        });
        marker.appendChild(svgNode("path", { d: "M 0 0 L 8 4 L 0 8 z", class: "diagram-arrow" }));
        defs.appendChild(marker);
        svg.appendChild(defs);
      }

      function shortDiagramLabel(value, maxLength) {
        var label = String(value || "").replace(/[\\r\\n]+/g, " ");
        return label.length > maxLength ? label.slice(0, maxLength - 1) + "…" : label;
      }

      function parseFlowchart(source) {
        var nodes = [];
        var nodeById = Object.create(null);
        var edges = [];
        var direction = "LR";
        var lines = String(source || "").split("\\n");
        var directionMatch = lines[0].match(/^\\s*(?:flowchart|graph)\\s+(LR|RL|TB|TD)\\s*$/i);
        if (!directionMatch) {
          return { supported: false, direction: direction, nodes: nodes, edges: edges };
        }
        direction = directionMatch[1].toUpperCase();
        function addNode(id, label) {
          if (!id) { return; }
          if (!nodeById[id]) {
            nodeById[id] = { id: id, label: label || id };
            nodes.push(nodeById[id]);
          } else if (label) {
            nodeById[id].label = label;
          }
        }
        lines.forEach(function (line) {
          var nodeMatch = line.match(/^\\s*([A-Za-z][A-Za-z0-9_-]*)\\s*\\[(.*)\\]\\s*$/);
          if (nodeMatch) {
            var label = nodeMatch[2].trim();
            if (label.length >= 2 && label[0] === '"' && label[label.length - 1] === '"') {
              label = label.slice(1, -1);
            }
            addNode(nodeMatch[1], label);
          }
          var labeledEdgeMatch = line.match(/^\\s*([A-Za-z][A-Za-z0-9_-]*)\\s*-->\\|([^|]*)\\|\\s*([A-Za-z][A-Za-z0-9_-]*)/);
          var edgeMatch = labeledEdgeMatch || line.match(/^\\s*([A-Za-z][A-Za-z0-9_-]*)\\s*-->\\s*([A-Za-z][A-Za-z0-9_-]*)/);
          if (edgeMatch) {
            var targetId = labeledEdgeMatch ? edgeMatch[3] : edgeMatch[2];
            addNode(edgeMatch[1], edgeMatch[1]);
            addNode(targetId, targetId);
            edges.push({
              from: edgeMatch[1],
              to: targetId,
              label: labeledEdgeMatch ? edgeMatch[2] : ""
            });
          }
        });
        return { supported: true, direction: direction, nodes: nodes, edges: edges };
      }

      function diagramFallback(container, source) {
        container.textContent = "";
        container.appendChild(element("pre", "diagram-fallback", "このMermaid構文は簡易描画の対象外です。ソースを確認してください。\\n\\n" + String(source || "")));
      }

      function renderFlowchart(container, source) {
        var graph = parseFlowchart(source);
        if (!graph.supported || !graph.nodes.length) {
          diagramFallback(container, source);
          return;
        }
        var horizontal = graph.direction === "LR" || graph.direction === "RL";
        var nodeWidth = 166;
        var nodeHeight = 52;
        var gap = 42;
        var padding = 20;
        var nodeCount = graph.nodes.length;
        var gapCount = Math.max(0, nodeCount - 1);
        var width = horizontal
          ? Math.max(280, padding * 2 + nodeCount * nodeWidth + gapCount * gap)
          : 220;
        var height = horizontal
          ? 132
          : Math.max(160, padding * 2 + nodeCount * nodeHeight + gapCount * gap);
        var svg = svgNode("svg", {
          viewBox: "0 0 " + width + " " + height,
          width: width,
          height: height,
          role: "img",
          "aria-label": "PRレビューの変更依存関係"
        });
        addArrowMarker(svg, "flow-arrow");
        var positions = Object.create(null);
        graph.nodes.forEach(function (node, index) {
          var visualIndex = graph.direction === "RL" ? graph.nodes.length - index - 1 : index;
          positions[node.id] = horizontal
            ? { x: padding + visualIndex * (nodeWidth + gap), y: 34 }
            : { x: (width - nodeWidth) / 2, y: padding + visualIndex * (nodeHeight + gap) };
        });
        graph.edges.forEach(function (edge) {
          var from = positions[edge.from];
          var to = positions[edge.to];
          if (!from || !to) { return; }
          var x1;
          var y1;
          var x2;
          var y2;
          if (horizontal) {
            var forward = to.x >= from.x;
            x1 = from.x + (forward ? nodeWidth : 0);
            y1 = from.y + nodeHeight / 2;
            x2 = to.x + (forward ? 0 : nodeWidth);
            y2 = to.y + nodeHeight / 2;
          } else {
            var downward = to.y >= from.y;
            x1 = from.x + nodeWidth / 2;
            y1 = from.y + (downward ? nodeHeight : 0);
            x2 = to.x + nodeWidth / 2;
            y2 = to.y + (downward ? 0 : nodeHeight);
          }
          svg.appendChild(svgNode("line", {
            x1: x1,
            y1: y1,
            x2: x2,
            y2: y2,
            class: "diagram-edge",
            "marker-end": "url(#flow-arrow)"
          }));
          if (edge.label) {
            svg.appendChild(svgNode("text", {
              x: (x1 + x2) / 2,
              y: (y1 + y2) / 2 - 6,
              "text-anchor": "middle",
              class: "diagram-muted"
            }, shortDiagramLabel(edge.label, 18)));
          }
        });
        graph.nodes.forEach(function (node) {
          var position = positions[node.id];
          svg.appendChild(svgNode("rect", {
            x: position.x,
            y: position.y,
            width: nodeWidth,
            height: nodeHeight,
            rx: 8,
            class: "diagram-node"
          }));
          svg.appendChild(svgNode("text", {
            x: position.x + nodeWidth / 2,
            y: position.y + nodeHeight / 2 + 4,
            "text-anchor": "middle"
          }, shortDiagramLabel(node.label, 24)));
        });
        container.textContent = "";
        container.appendChild(svg);
      }

      function parseSequence(source) {
        var participants = [];
        var participantById = Object.create(null);
        var messages = [];
        var lines = String(source || "").split("\\n");
        if (!/^\\s*sequenceDiagram\\s*$/i.test(lines[0] || "")) {
          return { supported: false, participants: participants, messages: messages };
        }
        function addParticipant(id, label) {
          if (!id) { return; }
          if (!participantById[id]) {
            participantById[id] = { id: id, label: label || id };
            participants.push(participantById[id]);
          } else if (label) {
            participantById[id].label = label;
          }
        }
        lines.slice(1).forEach(function (line) {
          var participantMatch = line.match(/^\\s*participant\\s+([A-Za-z][A-Za-z0-9_-]*)\\s+as\\s+(.+)$/i);
          if (participantMatch) {
            addParticipant(participantMatch[1], participantMatch[2].trim());
            return;
          }
          var messageMatch = line.match(/^\\s*([A-Za-z][A-Za-z0-9_-]*)\\s*(?:-+>>?|=+>>?)\\s*([A-Za-z][A-Za-z0-9_-]*)\\s*:\\s*(.*)$/);
          if (messageMatch) {
            addParticipant(messageMatch[1], messageMatch[1]);
            addParticipant(messageMatch[2], messageMatch[2]);
            messages.push({ from: messageMatch[1], to: messageMatch[2], label: messageMatch[3] });
          }
        });
        return { supported: true, participants: participants, messages: messages };
      }

      function renderSequence(container, source) {
        var diagram = parseSequence(source);
        if (!diagram.supported || !diagram.participants.length) {
          diagramFallback(container, source);
          return;
        }
        var participantWidth = 150;
        var participantGap = 20;
        var padding = 20;
        var participantCount = diagram.participants.length;
        var participantGapCount = Math.max(0, participantCount - 1);
        var width = Math.max(300, padding * 2 + participantCount * participantWidth + participantGapCount * participantGap);
        var height = Math.max(150, 88 + diagram.messages.length * 44);
        var svg = svgNode("svg", {
          viewBox: "0 0 " + width + " " + height,
          width: width,
          height: height,
          role: "img",
          "aria-label": "PRレビューの確認シーケンス"
        });
        addArrowMarker(svg, "sequence-arrow");
        var positions = Object.create(null);
        diagram.participants.forEach(function (participant, index) {
          var x = padding + index * (participantWidth + participantGap) + participantWidth / 2;
          positions[participant.id] = x;
          svg.appendChild(svgNode("line", {
            x1: x,
            y1: 48,
            x2: x,
            y2: height - 12,
            class: "diagram-lifeline"
          }));
          svg.appendChild(svgNode("rect", {
            x: x - participantWidth / 2,
            y: 10,
            width: participantWidth,
            height: 34,
            rx: 6,
            class: "diagram-node"
          }));
          svg.appendChild(svgNode("text", {
            x: x,
            y: 32,
            "text-anchor": "middle"
          }, shortDiagramLabel(participant.label, 20)));
        });
        diagram.messages.forEach(function (message, index) {
          var from = positions[message.from];
          var to = positions[message.to];
          if (from === undefined || to === undefined) { return; }
          var y = 76 + index * 44;
          var x1 = from;
          var x2 = to;
          if (x1 === x2) { x2 += 58; }
          svg.appendChild(svgNode("line", {
            x1: x1,
            y1: y,
            x2: x2,
            y2: y,
            class: "diagram-edge",
            "marker-end": "url(#sequence-arrow)"
          }));
          svg.appendChild(svgNode("text", {
            x: (x1 + x2) / 2,
            y: y - 7,
            "text-anchor": "middle",
            class: "diagram-muted"
          }, shortDiagramLabel(message.label, 28)));
        });
        container.textContent = "";
        container.appendChild(svg);
      }

      function renderDiagrams() {
        var diagrams = state.diagrams || {};
        var flowchart = diagrams.flowchart || "flowchart LR";
        var sequence = diagrams.sequence || "sequenceDiagram";
        renderFlowchart(document.getElementById("flowchart"), flowchart);
        renderSequence(document.getElementById("sequence"), sequence);
        document.getElementById("flowchart-source").textContent = flowchart;
        document.getElementById("sequence-source").textContent = sequence;
      }

      function render() {
        if (!state) { return; }
        renderSummary();
        renderSections();
        renderDependencies();
        renderDiagrams();
      }

      document.getElementById("loadDiff").addEventListener("click", function () {
        var diff = diffInput.value;
        if (!diff.trim()) {
          showToast("差分を貼り付けてください。");
          return;
        }
        request("/api/load", { method: "POST", body: JSON.stringify({ diff: diff }) })
          .then(function (next) { state = next; render(); showToast("差分を解析しました。"); })
          .catch(function (error) { showToast(error.message); });
      });
      document.getElementById("refresh").addEventListener("click", function () {
        request("/api/state").then(function (next) { state = next; render(); }).catch(function (error) { showToast(error.message); });
      });

      request("/api/state").then(function (next) { state = next; render(); }).catch(function (error) { showToast(error.message); });
      var events = new EventSource("/events");
      events.addEventListener("state", function (event) {
        try {
          state = JSON.parse(event.data);
          render();
        } catch (error) {
          showToast("Canvas状態の更新を読み込めませんでした。");
        }
      });
    }());
  </script>
</body>
</html>`;
}

async function startServer(instanceId, reviewId) {
    const server = createServer(async (req, res) => {
        const entry = servers.get(instanceId);
        if (!entry) {
            sendError(res, new HttpError(404, "Canvasインスタンスが見つかりません。"));
            return;
        }
        try {
            const requestPath = getRequestPath(req);
            if (req.method === "GET" && requestPath === "/") {
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(renderHtml(instanceId));
                return;
            }
            if (req.method === "GET" && requestPath === "/api/state") {
                sendJson(res, 200, await loadState(entry.reviewId));
                return;
            }
            if (req.method === "GET" && requestPath === "/events") {
                const state = await loadState(entry.reviewId);
                const reviewId = entry.reviewId;
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
                res.setHeader("Cache-Control", "no-cache, no-store");
                res.setHeader("Connection", "keep-alive");
                res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
                const clients = subscribers.get(reviewId) || new Set();
                clients.add(res);
                subscribers.set(reviewId, clients);
                req.on("close", () => {
                    clients.delete(res);
                    if (clients.size === 0) {
                        subscribers.delete(reviewId);
                    }
                });
                return;
            }
            if (req.method === "POST" && requestPath === "/api/load") {
                const input = await readJsonBody(req);
                if (!isRecord(input)) {
                    throw new HttpError(400, "JSONオブジェクトのリクエストが必要です。");
                }
                validateDiff(input.diff);
                sendJson(res, 200, await applyReviewInput(entry.reviewId, input));
                return;
            }
            if (req.method === "PATCH" && requestPath.startsWith("/api/sections/")) {
                let sectionId;
                try {
                    sectionId = decodeURIComponent(requestPath.slice("/api/sections/".length));
                } catch {
                    throw new HttpError(400, "セクションIDの形式が不正です。");
                }
                const input = await readJsonBody(req);
                if (!isRecord(input)) {
                    throw new HttpError(400, "JSONオブジェクトのリクエストが必要です。");
                }
                const next = await queueReviewMutation(entry.reviewId, (nextState) => {
                    const index = nextState.sections.findIndex((section) => section.id === sectionId);
                    if (index < 0) {
                        throw new HttpError(404, "指定されたレビューセクションが見つかりません。");
                    }
                    nextState.sections[index] = normalizeSectionUpdate(input, nextState.sections[index], index);
                    nextState.stats.highImportance = nextState.sections.filter((section) => section.importance === "high").length;
                    return nextState;
                });
                sendJson(res, 200, next);
                return;
            }
            sendError(res, new HttpError(404, "Canvas APIのパスが見つかりません。"));
        } catch (error) {
            sendError(res, error);
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, reviewId, url: `http://127.0.0.1:${port}/` };
}

async function getCanvasState(ctx) {
    const entry = getServerEntry(ctx.instanceId);
    return { entry, state: await loadState(entry.reviewId) };
}

const canvas = createCanvas({
    id: "pr-review-lens",
    displayName: "PR Review Lens",
    description: "Pull Requestの差分を意味単位に分解し、重要度・依存関係・図でレビューを支援します。",
    inputSchema: {
        type: "object",
        properties: {
            reviewId: { type: "string", minLength: 1, maxLength: 128 },
            title: { type: "string", maxLength: 240 },
            repository: { type: "string", maxLength: 240 },
            pullRequestNumber: { type: "integer", minimum: 1 },
            baseRef: { type: "string", maxLength: 240 },
            headRef: { type: "string", maxLength: 240 },
            diff: { type: "string", maxLength: MAX_DIFF_BYTES },
        },
        additionalProperties: false,
    },
    actions: [
        {
            name: "get_review_state",
            description: "現在表示中のPRレビュー状態、セクション、依存関係、図を取得します。",
            inputSchema: { type: "object", additionalProperties: false },
            handler: async (ctx) => {
                const result = await getCanvasState(ctx);
                return result.state;
            },
        },
        {
            name: "set_review_diff",
            description: "現在のCanvasにUnified Diffを設定し、意味単位の初期分析を実行します。",
            inputSchema: {
                type: "object",
                properties: {
                    diff: { type: "string", minLength: 1, maxLength: MAX_DIFF_BYTES },
                    title: { type: "string", maxLength: 240 },
                    repository: { type: "string", maxLength: 240 },
                    pullRequestNumber: { type: "integer", minimum: 1 },
                },
                required: ["diff"],
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const input = isRecord(ctx.input) ? ctx.input : {};
                validateDiff(input.diff);
                const result = await getCanvasState(ctx);
                const next = await applyReviewInput(result.entry.reviewId, input);
                return {
                    reviewId: next.reviewId,
                    title: next.title,
                    stats: next.stats,
                    sections: next.sections,
                };
            },
        },
        {
            name: "update_review_sections",
            description: "エージェントが意味単位のセクションのタイトル、説明、重要度、レビュー観点を精緻化します。",
            inputSchema: {
                type: "object",
                properties: {
                    replaceAll: { type: "boolean" },
                    sections: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                id: { type: "string", maxLength: 128 },
                                title: { type: "string", maxLength: 240 },
                                description: { type: "string", maxLength: 2000 },
                                importance: { type: "string", enum: ["high", "medium", "low"] },
                                importanceReason: { type: "string", maxLength: 1000 },
                                status: { type: "string", enum: ["unreviewed", "reviewing", "accepted", "needs-attention"] },
                                notes: { type: "string", maxLength: 4000 },
                                reviewQuestions: { type: "array", items: { type: "string", maxLength: 500 } },
                                filePaths: { type: "array", items: { type: "string", maxLength: 500 } },
                                diff: { type: "string", maxLength: MAX_SECTION_DIFF_CHARS + 100 },
                            },
                            additionalProperties: false,
                        },
                    },
                },
                required: ["sections"],
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const input = isRecord(ctx.input) ? ctx.input : {};
                const result = await getCanvasState(ctx);
                const next = await queueReviewMutation(result.entry.reviewId, (nextState) => {
                    const currentSections = nextState.sections;
                    const currentById = new Map(currentSections.map((section) => [section.id, section]));
                    const sections = Array.isArray(input.sections) ? input.sections : [];
                    const updates = sections.map((item, index) => {
                        const existing = item?.id ? currentById.get(item.id) : currentSections[index];
                        return normalizeSectionUpdate(item, existing, index);
                    });
                    nextState.sections = mergeReviewSections(currentSections, updates, input.replaceAll === true);
                    nextState.stats.sections = nextState.sections.length;
                    nextState.stats.highImportance = nextState.sections.filter((section) => section.importance === "high").length;
                    nextState.diagrams = buildDiagrams(nextState.sections, nextState.dependencies);
                    return nextState;
                });
                return next;
            },
        },
        {
            name: "update_dependency_view",
            description: "モジュール依存関係、フローチャート、シーケンス図をエージェントの分析結果で更新します。",
            inputSchema: {
                type: "object",
                properties: {
                    dependencies: {
                        type: "object",
                        properties: {
                            nodes: { type: "array" },
                            edges: { type: "array" },
                        },
                        additionalProperties: false,
                    },
                    flowchart: { type: "string", maxLength: 20_000 },
                    sequence: { type: "string", maxLength: 20_000 },
                },
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const input = isRecord(ctx.input) ? ctx.input : {};
                const result = await getCanvasState(ctx);
                const next = await queueReviewMutation(result.entry.reviewId, (nextState) => {
                    if (isRecord(input.dependencies)) {
                        nextState.dependencies = normalizeDependencies(input.dependencies);
                    }
                    nextState.diagrams = isRecord(nextState.diagrams) ? nextState.diagrams : {};
                    if (typeof input.flowchart === "string") {
                        nextState.diagrams.flowchart = input.flowchart;
                    }
                    if (typeof input.sequence === "string") {
                        nextState.diagrams.sequence = input.sequence;
                    }
                    return nextState;
                });
                return {
                    dependencies: next.dependencies,
                    diagrams: next.diagrams,
                };
            },
        },
    ],
    open: async (ctx) => {
        const input = isRecord(ctx.input) ? ctx.input : {};
        const reviewId = resolveReviewId(input);
        await applyReviewInput(reviewId, input);
        let entry = servers.get(ctx.instanceId);
        if (!entry) {
            entry = await startServer(ctx.instanceId, reviewId);
            servers.set(ctx.instanceId, entry);
        } else if (entry.reviewId !== reviewId) {
            const previousReviewId = entry.reviewId;
            closeSubscribers(previousReviewId);
            entry.reviewId = reviewId;
            releaseReviewState(previousReviewId);
        }
        return {
            title: "PR Review Lens",
            status: "差分の意味分解・依存関係・レビュー注記",
            url: entry.url,
        };
    },
    onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (!entry) {
            return;
        }
        servers.delete(ctx.instanceId);
        closeSubscribers(entry.reviewId);
        releaseReviewState(entry.reviewId);
        await new Promise((resolve) => entry.server.close(() => resolve()));
    },
});

runtimeSession = await joinSession({ canvases: [canvas] });
