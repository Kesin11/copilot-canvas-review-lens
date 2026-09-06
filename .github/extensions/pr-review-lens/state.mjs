import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CanvasError } from "@github/copilot-sdk/extension";
import { analyzeDiff, buildSupportGroup, calculateStats, groupId, orderGroups } from "./analysis.mjs";
import { MAX_REVIEW_ARTIFACTS, REVIEW_RETENTION_MS } from "./constants.mjs";
import { getUpdateItems, normalizeImpact, sanitizeAiUpdates, validateDiff } from "./review-input.mjs";
import { clone, getArtifactsDirectory, getStatePath, hashText, isRecord, safeIdentifier } from "./utils.mjs";

export const servers = new Map();
export const states = new Map();
export const subscribers = new Map();
export const mutationQueues = new Map();

function createEmptyState(reviewId, input = {}) {
    return {
        version: 2,
        reviewId,
        title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : "PRレビュー補助",
        repository: typeof input.repository === "string" ? input.repository : "",
        pullRequestNumber: Number.isInteger(input.pullRequestNumber) ? input.pullRequestNumber : null,
        baseRef: typeof input.baseRef === "string" ? input.baseRef : "",
        headRef: typeof input.headRef === "string" ? input.headRef : "",
        language: typeof input.language === "string" && input.language.trim() ? input.language.trim() : "ja",
        languageSource: typeof input.language === "string" ? "metadata" : "fallback",
        diff: "",
        groups: [],
        stats: calculateStats("", [], []),
        analysisStatus: "cached",
        diffFingerprint: hashText(""),
        analysisError: "",
        unparsedFiles: [],
        unparsedReason: "",
        updatedAt: new Date().toISOString(),
    };
}

function normalizeGroup(raw, index, knownFiles = new Map()) {
    const source = isRecord(raw) ? raw : {};
    const oldImpact = source.impact ?? source.importance;
    let filePaths = [];
    if (Array.isArray(source.filePaths)) {
        filePaths = source.filePaths.filter((filePath) => typeof filePath === "string");
    } else if (Array.isArray(source.files)) {
        filePaths = source.files
            .map((file) => file?.path)
            .filter((filePath) => typeof filePath === "string");
    }
    const files = filePaths
        .map((filePath) => {
            if (knownFiles.size > 0) {
                return knownFiles.get(filePath);
            }
            return Array.isArray(source.files)
                ? source.files.find((file) => file?.path === filePath)
                : undefined;
        })
        .filter(isRecord);
    const normalizedFilePaths = files.map((file) => file.path);
    let role = "implementation";
    if (typeof source.role === "string" && source.role.trim()) {
        role = source.role.trim();
    } else if (typeof source.kind === "string" && source.kind.trim()) {
        role = source.kind;
    }
    const id = typeof source.id === "string" && source.id.trim() ? safeIdentifier(source.id) : groupId(normalizedFilePaths, role);
    let summary = "";
    if (typeof source.summary === "string") {
        summary = source.summary;
    } else if (typeof source.description === "string") {
        summary = source.description;
    }
    return {
        id: id || `group-${index + 1}`,
        title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : "変更",
        role,
        summary,
        description: summary,
        impact: normalizeImpact(oldImpact),
        evidence: Array.isArray(source.evidence) ? source.evidence.filter(isRecord) : [],
        relatedGroups: Array.isArray(source.relatedGroups) ? source.relatedGroups.filter((id) => typeof id === "string") : [],
        uncertainty: typeof source.uncertainty === "string" ? source.uncertainty : "",
        detail: typeof source.detail === "string" ? source.detail : "",
        files,
        filePaths: normalizedFilePaths,
        diff: files.map((file) => file.patch || "").filter(Boolean).join("\n\n") || (typeof source.diff === "string" ? source.diff : ""),
        diffFingerprint: hashText(files.map((file) => file.patch || "").join("\n\n") || (typeof source.diff === "string" ? source.diff : "")),
        diffTruncated: Boolean(source.diffTruncated),
        source: source.source === "ai" ? "ai" : "deterministic",
        aiError: typeof source.aiError === "string" ? source.aiError : "",
    };
}

function normalizeStoredState(raw, reviewId) {
    if (!isRecord(raw)) {
        throw new Error("保存されたレビュー状態の形式が不正です。");
    }
    const empty = createEmptyState(reviewId);
    const diff = typeof raw.diff === "string" ? raw.diff : "";
    const analysis = diff ? analyzeDiff(diff) : null;
    const allFiles = new Map(
        analysis?.groups.flatMap((group) => group.files || []).map((file) => [file.path, file]) || [],
    );
    let rawGroups = [];
    if (Array.isArray(raw.groups) && raw.groups.length) {
        rawGroups = raw.groups;
    } else if (Array.isArray(raw.sections) && raw.sections.length) {
        rawGroups = raw.sections;
    } else if (analysis) {
        rawGroups = analysis.groups;
    }
    let groups = rawGroups
        .map((group, index) => normalizeGroup(group, index, allFiles))
        .filter((group) => group.filePaths.length || !allFiles.size);
    if (analysis && allFiles.size) {
        const included = new Set(groups.flatMap((group) => group.filePaths));
        const missingFiles = [...allFiles.values()].filter((file) => !included.has(file.path));
        if (missingFiles.length) {
            groups = [...groups, buildSupportGroup(
                missingFiles,
                "保存済みのストーリーに含まれなかった差分を保持するための補助グループです。",
            )];
        }
    }
    let unparsedFiles = [];
    let unparsedReason = "";
    if (analysis) {
        unparsedFiles = analysis.unparsedFiles;
        unparsedReason = analysis.unparsedReason;
    } else {
        if (Array.isArray(raw.unparsedFiles)) {
            unparsedFiles = raw.unparsedFiles.filter((file) => typeof file === "string");
        }
        if (typeof raw.unparsedReason === "string") {
            unparsedReason = raw.unparsedReason;
        }
    }
    const rawStats = isRecord(raw.stats) ? raw.stats : {};
    const { sections: _legacySections, highImportance: _legacyHighImportance, ...storedStats } = rawStats;
    const normalized = {
        ...empty,
        ...raw,
        version: 2,
        reviewId,
        diff,
        groups: orderGroups(groups),
        stats: {
            ...empty.stats,
            ...(analysis?.stats || {}),
            ...(analysis ? {} : storedStats),
            groups: groups.length,
            highImpact: groups.filter((group) => group.impact?.level === "high").length,
        },
        analysisStatus: ["cached", "analyzing", "ai-updated", "error"].includes(raw.analysisStatus) ? raw.analysisStatus : "cached",
        diffFingerprint: analysis ? analysis.diffFingerprint : hashText(diff),
        analysisError: typeof raw.analysisError === "string" ? raw.analysisError : "",
        unparsedFiles,
        unparsedReason,
        language: typeof raw.language === "string" && raw.language.trim() ? raw.language : "ja",
        languageSource: typeof raw.languageSource === "string" ? raw.languageSource : "fallback",
    };
    // Legacy artifacts may contain dependency graphs, diagrams, or editable
    // section state. They are intentionally not exposed in the story schema.
    delete normalized.dependencies;
    delete normalized.diagrams;
    delete normalized.sections;
    return normalized;
}

async function loadState(reviewId) {
    if (states.has(reviewId)) return states.get(reviewId);
    try {
        const content = await readFile(getStatePath(reviewId), "utf8");
        const state = normalizeStoredState(JSON.parse(content), reviewId);
        states.set(reviewId, state);
        return state;
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        const state = createEmptyState(reviewId);
        states.set(reviewId, state);
        return state;
    }
}

function isReviewOpen(reviewId) {
    return [...servers.values()].some((entry) => entry.reviewId === reviewId);
}

function releaseReviewState(reviewId) {
    if (!isReviewOpen(reviewId) && !subscribers.has(reviewId) && !mutationQueues.has(reviewId)) states.delete(reviewId);
}

async function pruneReviewArtifacts(preserveReviewId) {
    let entries;
    try {
        entries = await readdir(getArtifactsDirectory(), { withFileTypes: true });
    } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
    }
    const cutoff = Date.now() - REVIEW_RETENTION_MS;
    const candidates = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const reviewId = entry.name.slice(0, -".json".length);
        if (reviewId === safeIdentifier(preserveReviewId) || isReviewOpen(reviewId) || mutationQueues.has(reviewId)) continue;
        const filePath = path.join(getArtifactsDirectory(), entry.name);
        try {
            const metadata = await stat(filePath);
            if (metadata.mtimeMs < cutoff) await unlink(filePath);
            else candidates.push({ filePath, mtimeMs: metadata.mtimeMs });
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
    }
    candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const candidate of candidates.slice(0, Math.max(0, candidates.length - MAX_REVIEW_ARTIFACTS))) {
        await unlink(candidate.filePath).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
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
        if (!isRecord(next) || next.reviewId !== reviewId) throw new Error("レビュー状態の更新結果が不正です。");
        await saveState(next);
        publishState(reviewId, next);
        return next;
    });
    mutationQueues.set(reviewId, operation);
    return operation.finally(() => {
        if (mutationQueues.get(reviewId) === operation) mutationQueues.delete(reviewId);
        releaseReviewState(reviewId);
    });
}

function publishState(reviewId, state) {
    const clients = subscribers.get(reviewId);
    if (!clients) return;
    const message = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) {
        try { client.write(message); } catch { clients.delete(client); }
    }
}

function closeSubscribers(reviewId) {
    const clients = subscribers.get(reviewId);
    if (!clients) return;
    for (const client of clients) client.end();
    subscribers.delete(reviewId);
}

async function applyReviewInput(reviewId, input) {
    if (input.diff !== undefined) validateDiff(input.diff);
    return queueReviewMutation(reviewId, (next) => {
        if (typeof input.title === "string" && input.title.trim()) next.title = input.title.trim();
        if (typeof input.repository === "string") next.repository = input.repository;
        if (Number.isInteger(input.pullRequestNumber)) next.pullRequestNumber = input.pullRequestNumber;
        if (typeof input.baseRef === "string") next.baseRef = input.baseRef;
        if (typeof input.headRef === "string") next.headRef = input.headRef;
        if (typeof input.language === "string" && input.language.trim()) {
            next.language = input.language.trim();
            next.languageSource = "metadata";
        }
        if (typeof input.diff === "string" && (next.diff !== input.diff || next.groups.length === 0)) {
            const analysis = analyzeDiff(input.diff);
            next.diff = input.diff;
            next.groups = analysis.groups;
            next.stats = analysis.stats;
            next.analysisStatus = "cached";
            next.diffFingerprint = analysis.diffFingerprint;
            next.analysisError = "";
            next.unparsedFiles = analysis.unparsedFiles;
            next.unparsedReason = analysis.unparsedReason;
        }
        return next;
    });
}

async function applyAiUpdate(reviewId, input) {
    return queueReviewMutation(reviewId, (next) => {
        const updateInput = isRecord(input) ? input : {};
        const updates = getUpdateItems(updateInput);
        if (updateInput.replaceAll === true && updates.length === 0) {
            const message = "replaceAllには1件以上のAIグループが必要です。";
            next.analysisStatus = "error";
            next.analysisError = message;
            next.groups = next.groups.map((group) => ({ ...group, aiError: group.aiError || message }));
            return next;
        }
        const knownFiles = new Map(next.groups.flatMap((group) => (group.files || []).map((file) => [file.path, file])));
        const result = sanitizeAiUpdates(updateInput, next.groups, knownFiles);
        if (result.groups.length) {
            next.groups = orderGroups(result.groups);
            next.stats.groups = next.groups.length;
            next.stats.highImpact = next.groups.filter((group) => group.impact?.level === "high").length;
            next.analysisStatus = result.errors.length || updateInput.error ? "error" : "ai-updated";
            next.analysisError = updateInput.error || result.errors.join(" ");
            if (updateInput.error || result.errors.length) {
                next.groups = next.groups.map((group) => ({
                    ...group,
                    aiError: group.aiError || next.analysisError,
                }));
            }
            return next;
        }
        if (updateInput.error || result.errors.length) {
            next.analysisStatus = "error";
            next.analysisError = updateInput.error || result.errors.join(" ");
            next.groups = next.groups.map((group) => ({
                ...group,
                aiError: group.aiError || next.analysisError,
            }));
        }
        return next;
    });
}

export {
    createEmptyState,
    normalizeStoredState,
    loadState,
    isReviewOpen,
    releaseReviewState,
    pruneReviewArtifacts,
    saveState,
    queueReviewMutation,
    publishState,
    closeSubscribers,
    applyReviewInput,
    applyAiUpdate,
};

export function getServerEntry(instanceId) {
    const entry = servers.get(instanceId);
    if (!entry) throw new CanvasError("canvas_instance_not_found", "指定されたCanvasインスタンスが見つかりません。");
    return entry;
}

export async function getCanvasState(ctx) {
    const entry = getServerEntry(ctx.instanceId);
    return { entry, state: await loadState(entry.reviewId) };
}
