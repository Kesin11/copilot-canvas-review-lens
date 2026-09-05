import { createCanvas } from "@github/copilot-sdk/extension";
import { MAX_REQUEST_BYTES } from "./constants.mjs";
import { validateDiff } from "./review-input.mjs";
import { startServer } from "./server.mjs";
import {
    applyAiUpdate,
    applyReviewInput,
    closeSubscribers,
    getCanvasState,
    releaseReviewState,
    servers,
} from "./state.mjs";
import { isRecord, resolveReviewId } from "./utils.mjs";

const STORY_FIELDS = {
    id: { type: "string", maxLength: 128 },
    filePaths: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 500 },
    title: { type: "string", maxLength: 240 },
    role: { type: "string", maxLength: 80 },
    summary: { type: "string", maxLength: 2_000 },
    impact: {
        oneOf: [
            { type: "string", enum: ["high", "medium", "low"] },
            {
                type: "object",
                properties: {
                    level: { type: "string", enum: ["high", "medium", "low"] },
                    score: { type: "number" },
                    reason: { type: "string", maxLength: 500 },
                    signals: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 12 },
                    changedLines: { type: "number" },
                },
                additionalProperties: false,
            },
        ],
    },
    evidence: { type: "array", items: { type: "object", additionalProperties: true }, maxItems: 50 },
    relatedGroups: { type: "array", items: { type: "string", maxLength: 128 }, maxItems: 50 },
    uncertainty: { type: "string", maxLength: 1_000 },
    detail: { type: "string", maxLength: 4_000 },
};

const canvas = createCanvas({
    id: "pr-review-lens",
    displayName: "PR Review Lens",
    description: "Unified Diffを決定的な候補グループとエージェント要約から、読み取り専用のレビュー・ストーリーとして表示します。",
    inputSchema: {
        type: "object",
        properties: {
            reviewId: { type: "string", minLength: 1, maxLength: 128 },
            title: { type: "string", maxLength: 240 },
            repository: { type: "string", maxLength: 240 },
            pullRequestNumber: { type: "integer", minimum: 1 },
            baseRef: { type: "string", maxLength: 240 },
            headRef: { type: "string", maxLength: 240 },
            language: { type: "string", maxLength: 32 },
            diff: { type: "string", maxLength: MAX_REQUEST_BYTES },
        },
        additionalProperties: false,
    },
    actions: [
        {
            name: "get_review_state",
            description: "現在のPR Review Lensの読み取り専用ストーリー状態を取得します。図や依存関係ではなく、決定的な候補グループ、証拠、全差分、分析状態を返します。",
            inputSchema: { type: "object", additionalProperties: false },
            handler: async (ctx) => (await getCanvasState(ctx)).state,
        },
        {
            name: "set_review_diff",
            description: "Unified Diffを設定し、まず決定的な候補グループと重要度・証拠を同期解析します。成功後、入力された差分のファイルだけを根拠にエージェントが要約を更新できます。",
            inputSchema: {
                type: "object",
                properties: {
                    diff: { type: "string", minLength: 1, maxLength: MAX_REQUEST_BYTES },
                    title: { type: "string", maxLength: 240 },
                    repository: { type: "string", maxLength: 240 },
                    pullRequestNumber: { type: "integer", minimum: 1 },
                    language: { type: "string", maxLength: 32 },
                },
                required: ["diff"],
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const input = isRecord(ctx.input) ? ctx.input : {};
                validateDiff(input.diff);
                const { entry } = await getCanvasState(ctx);
                return applyReviewInput(entry.reviewId, input);
            },
        },
        {
            name: "update_review_sections",
            description: "決定的な候補グループを、供給された差分内のファイルだけでAI要約に更新します。図・依存関係・status・notes・reviewQuestionsは受け付けません。title, role, summary, impact, evidence, relatedGroups, uncertainty, detailと任意のfilePathsだけを構造化して渡し、根拠のないファイルや事実は追加しないでください。replaceAllは全グループを原子的に置換します。AIに失敗した場合はerrorを渡すと決定的状態を保持したままエラー表示できます。",
            inputSchema: {
                type: "object",
                properties: {
                    replaceAll: { type: "boolean" },
                    error: { type: "string", maxLength: 2_000 },
                    groups: { type: "array", items: { type: "object", properties: STORY_FIELDS, additionalProperties: false } },
                    sections: { type: "array", items: { type: "object", properties: STORY_FIELDS, additionalProperties: false } },
                },
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const input = isRecord(ctx.input) ? ctx.input : {};
                const { entry } = await getCanvasState(ctx);
                return applyAiUpdate(entry.reviewId, input);
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
            status: "読み取り専用のストーリー分析",
            url: entry.url,
        };
    },
    onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (!entry) return;
        servers.delete(ctx.instanceId);
        closeSubscribers(entry.reviewId);
        releaseReviewState(entry.reviewId);
        await new Promise((resolve) => entry.server.close(() => resolve()));
    },
});

export { canvas };
