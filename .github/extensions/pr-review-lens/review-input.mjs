import { groupId } from "./analysis.mjs";
import { MAX_REQUEST_BYTES } from "./constants.mjs";
import { HttpError, hashText, isRecord, normalizePath, safeIdentifier, unique } from "./utils.mjs";

function validateDiff(diff) {
    if (typeof diff !== "string") {
        throw new HttpError(400, "diffには文字列を指定してください。");
    }
    if (Buffer.byteLength(diff, "utf8") > MAX_REQUEST_BYTES) {
        throw new HttpError(413, "差分が大きすぎます。4MB以下の差分を指定してください。");
    }
}

function normalizeImpact(value, fallback) {
    const base = fallback || { level: "medium", score: 25, reason: "", signals: [], changedLines: 0 };
    if (typeof value === "string") {
        return { ...base, level: ["high", "medium", "low"].includes(value) ? value : base.level };
    }
    if (!isRecord(value)) return base;
    return {
        level: ["high", "medium", "low"].includes(value.level) ? value.level : base.level,
        score: Number.isFinite(value.score) ? value.score : base.score,
        reason: typeof value.reason === "string" ? value.reason.slice(0, 500) : base.reason || "",
        signals: Array.isArray(value.signals)
            ? value.signals.filter((signal) => typeof signal === "string").map((signal) => signal.slice(0, 200)).slice(0, 12)
            : base.signals,
        changedLines: Number.isFinite(value.changedLines) ? value.changedLines : base.changedLines,
    };
}

function sanitizeEvidence(value, knownPaths, fallback = []) {
    if (!Array.isArray(value)) return fallback;
    return value.map((item) => {
        if (!isRecord(item) || typeof item.file !== "string" || !knownPaths.has(normalizePath(item.file))) return null;
        const file = normalizePath(item.file);
        return {
            file,
            hunk: typeof item.hunk === "string" ? item.hunk.slice(0, 500) : null,
            lineStart: Number.isInteger(item.lineStart) ? item.lineStart : null,
            lineEnd: Number.isInteger(item.lineEnd) ? item.lineEnd : null,
            reason: typeof item.reason === "string" ? item.reason.slice(0, 500) : "",
        };
    }).filter(Boolean).slice(0, 50);
}

function materializeGroup(group, knownFiles) {
    const files = group.filePaths.map((filePath) => knownFiles.get(filePath)).filter(Boolean);
    return {
        ...group,
        files,
        filePaths: files.map((file) => file.path),
        diff: files.map((file) => file.patch || "").filter(Boolean).join("\n\n") || group.diff || "",
        diffFingerprint: hashText(files.map((file) => file.patch || "").join("\n\n") || group.diff || ""),
    };
}

function getUpdateItems(input) {
    if (Array.isArray(input.groups)) {
        return input.groups;
    }
    if (Array.isArray(input.sections)) {
        return input.sections;
    }
    return [];
}

function normalizeGroupUpdate(item, existing, index, knownFiles) {
    if (!isRecord(item)) return { group: null, error: `グループ${index + 1}はオブジェクトではありません。` };
    const source = item;
    const fallback = existing || {};
    const knownPaths = new Set(knownFiles.keys());
    let requestedPaths = Array.isArray(fallback.filePaths) ? fallback.filePaths : [];
    if (Array.isArray(source.filePaths)) {
        requestedPaths = source.filePaths.map(normalizePath);
    }
    const filePaths = unique(requestedPaths.filter((filePath) => knownPaths.has(filePath)));
    const droppedPaths = requestedPaths.filter((filePath) => !knownPaths.has(filePath));
    if (droppedPaths.length && !filePaths.length) {
        return { group: null, error: `グループ${index + 1}は入力差分にないファイルだけを参照しています。` };
    }
    if (!filePaths.length && !fallback.filePaths?.length) {
        return { group: null, error: `グループ${index + 1}に入力差分のファイルがありません。` };
    }

    const role = typeof source.role === "string" && source.role.trim()
        ? source.role.trim().slice(0, 80)
        : fallback.role || "implementation";
    const requestedId = typeof source.id === "string" && source.id.trim()
        ? safeIdentifier(source.id)
        : "";
    const id = typeof fallback.id === "string" && fallback.id
        ? fallback.id
        : requestedId || groupId(filePaths, role);
    const title = typeof source.title === "string" && source.title.trim()
        ? source.title.trim().slice(0, 240)
        : fallback.title || "変更";
    let summary = fallback.summary || "";
    if (typeof source.summary === "string") {
        summary = source.summary.slice(0, 2_000);
    } else if (typeof source.description === "string") {
        summary = source.description.slice(0, 2_000);
    }
    const relatedGroups = Array.isArray(source.relatedGroups)
        ? unique(source.relatedGroups.filter((relatedId) => typeof relatedId === "string").map((relatedId) => safeIdentifier(relatedId)).filter(Boolean))
        : fallback.relatedGroups || [];
    const group = {
        ...fallback,
        id: safeIdentifier(id, groupId(filePaths, role)),
        title,
        role,
        summary,
        description: summary,
        impact: normalizeImpact(source.impact, fallback.impact),
        evidence: sanitizeEvidence(source.evidence, knownPaths, fallback.evidence || []),
        relatedGroups,
        uncertainty: typeof source.uncertainty === "string" ? source.uncertainty.slice(0, 1_000) : fallback.uncertainty || "",
        detail: typeof source.detail === "string" ? source.detail.slice(0, 4_000) : fallback.detail || "",
        filePaths,
        source: "ai",
        aiError: droppedPaths.length ? `未知のファイル参照を除外しました: ${droppedPaths.join(", ")}` : "",
    };
    return {
        group: materializeGroup(group, knownFiles),
        error: droppedPaths.length ? group.aiError : "",
    };
}

function addMissingFiles(groups, knownFiles) {
    const included = new Set(groups.flatMap((group) => group.filePaths || []));
    const missing = [...knownFiles.keys()].filter((filePath) => !included.has(filePath));
    if (!missing.length) return groups;
    const reason = "AIの候補に含まれなかった変更ファイルを、横断・サポートとして保持しました。";
    const support = {
        id: groupId(missing, "support"),
        title: "横断・サポート",
        role: "support",
        summary: reason,
        description: reason,
        impact: { level: "medium", score: 25, reason, signals: ["unassigned files"], changedLines: 0 },
        evidence: [],
        relatedGroups: [],
        uncertainty: reason,
        detail: "",
        filePaths: missing,
        source: "deterministic",
        aiError: "",
        diff: "",
    };
    return [...groups, materializeGroup(support, knownFiles)];
}

function sanitizeAiUpdates(input, currentGroups, knownFiles) {
    const replaceAll = input.replaceAll === true;
    const updates = getUpdateItems(input);
    const currentById = new Map(currentGroups.map((group) => [group.id, group]));
    const errors = [];
    const normalized = [];

    updates.forEach((item, index) => {
        const requestedId = isRecord(item) && typeof item.id === "string" ? item.id : "";
        let existing;
        if (requestedId) {
            existing = currentById.get(requestedId);
        } else if (!replaceAll) {
            existing = currentGroups[index];
        }
        const result = normalizeGroupUpdate(item, existing, index, knownFiles);
        if (result.group) normalized.push(result.group);
        if (result.error) errors.push(result.error);
    });

    let groups;
    if (replaceAll) {
        groups = normalized;
    } else {
        const updatesById = new Map(normalized.map((group) => [group.id, group]));
        groups = currentGroups.map((group) => updatesById.get(group.id) || group);
        normalized.filter((group) => !currentById.has(group.id)).forEach((group) => groups.push(group));
    }
    groups = addMissingFiles(groups, knownFiles);
    const groupIds = new Set(groups.map((group) => group.id));
    groups = groups.map((group) => ({
        ...group,
        relatedGroups: (group.relatedGroups || []).filter((id) => groupIds.has(id) && id !== group.id),
    }));
    return { groups, errors };
}

export {
    validateDiff,
    getUpdateItems,
    normalizeImpact,
    sanitizeEvidence,
    normalizeGroupUpdate,
    sanitizeAiUpdates,
};
