import { IMPORTANCE_LABELS, MAX_DIFF_BYTES, STATUS_LABELS } from "./constants.mjs";
import { HttpError, isRecord, safeIdentifier } from "./utils.mjs";

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
export {
    validateDiff,
    validateImportance,
    validateStatus,
    isString,
    pickArray,
    normalizeSectionUpdate,
};
