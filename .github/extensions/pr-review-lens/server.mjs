import { createServer } from "node:http";
import { URL } from "node:url";
import { MAX_REQUEST_BYTES } from "./constants.mjs";
import { renderHtml } from "./renderer.mjs";
import { normalizeSectionUpdate, validateDiff } from "./review-input.mjs";
import {
    applyReviewInput,
    loadState,
    queueReviewMutation,
    servers,
    subscribers,
} from "./state.mjs";
import { HttpError, isRecord } from "./utils.mjs";

let runtimeSession;

export function setRuntimeSession(session) {
    runtimeSession = session;
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

export async function startServer(instanceId, reviewId) {
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
