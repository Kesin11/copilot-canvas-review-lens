import { createCanvas } from "@github/copilot-sdk/extension";
import { buildDiagrams, mergeReviewSections } from "./analysis.mjs";
import { MAX_DIFF_BYTES, MAX_SECTION_DIFF_CHARS } from "./constants.mjs";
import { normalizeSectionUpdate, validateDiff } from "./review-input.mjs";
import { startServer } from "./server.mjs";
import {
    applyReviewInput,
    closeSubscribers,
    getCanvasState,
    normalizeDependencies,
    queueReviewMutation,
    releaseReviewState,
    servers,
} from "./state.mjs";
import { isRecord, resolveReviewId } from "./utils.mjs";

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
export { canvas };
