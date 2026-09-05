export const EXTENSION_NAME = "pr-review-lens";
export const MAX_DIFF_BYTES = 3_000_000;
export const MAX_REQUEST_BYTES = 4_000_000;
export const MAX_SECTION_DIFF_CHARS = 18_000;
export const MAX_REVIEW_ARTIFACTS = 100;
export const REVIEW_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const KIND_LABELS = {
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

export const IMPORTANCE_LABELS = {
    high: "高",
    medium: "中",
    low: "低",
};

export const STATUS_LABELS = {
    unreviewed: "未確認",
    reviewing: "確認中",
    accepted: "問題なし",
    "needs-attention": "要確認",
};
