import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { EXTENSION_NAME } from "./constants.mjs";

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function safeIdentifier(value, fallback = "review") {
    const normalized = String(value ?? "")
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return normalized || fallback;
}

export function hashText(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function resolveReviewId(input) {
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

export function getArtifactsDirectory() {
    const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
    return path.join(copilotHome, "extensions", EXTENSION_NAME, "artifacts", "reviews");
}

export function getStatePath(reviewId) {
    return path.join(getArtifactsDirectory(), `${safeIdentifier(reviewId)}.json`);
}

export function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function normalizePath(value) {
    return String(value ?? "")
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/^\/+/, "");
}

export function stripDiffPath(value) {
    const raw = String(value ?? "").trim();
    if (!raw || raw === "/dev/null") {
        return "";
    }
    const unquoted = raw.replace(/^["']|["']$/g, "");
    return normalizePath(unquoted.replace(/^(?:a|b)\//, ""));
}

export function getPathFromDiffLine(line) {
    const value = String(line).slice(4).trim();
    return stripDiffPath(value.split("\t")[0]);
}

export function unique(values) {
    return [...new Set(values.filter(Boolean))];
}
