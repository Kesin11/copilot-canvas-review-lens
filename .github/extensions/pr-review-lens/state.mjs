import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CanvasError } from "@github/copilot-sdk/extension";
import { analyzeDiff, buildDiagrams, calculateStats, reconcileSections } from "./analysis.mjs";
import { MAX_REVIEW_ARTIFACTS, REVIEW_RETENTION_MS } from "./constants.mjs";
import { validateDiff } from "./review-input.mjs";
import { clone, getArtifactsDirectory, getStatePath, isRecord, safeIdentifier } from "./utils.mjs";

export const servers = new Map();
export const states = new Map();
export const subscribers = new Map();
export const mutationQueues = new Map();

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
export {
    createEmptyState,
    normalizeDependencies,
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
};

export function getServerEntry(instanceId) {
    const entry = servers.get(instanceId);
    if (!entry) {
        throw new CanvasError("canvas_instance_not_found", "指定されたCanvasインスタンスが見つかりません。");
    }
    return entry;
}

export async function getCanvasState(ctx) {
    const entry = getServerEntry(ctx.instanceId);
    return { entry, state: await loadState(entry.reviewId) };
}
