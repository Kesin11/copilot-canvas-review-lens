# PR Review Lens

Pull Request の Unified Diff を、コードレビューで追いやすい「変更のストーリー」に整理する GitHub Copilot Canvas 拡張です。差分は外部サービスへ送信せず、Canvas とローカルの拡張プロセスだけで解析・保存します。GitHub の Pull Request を自動取得する機能はありません。

## 体験

PR Review Lens のメインビューは、読み取り専用のストーリー表示です。

- PR の導入、分析状態、更新時刻、言語メタデータ
- 変更ファイル、追加行、削除行、グループ数、高影響グループ数、差分行数
- 高影響を先頭に、変更行数、パスの順で並ぶ目次
- 各グループのタイトル、役割タグ、要約、影響、証拠、関連グループ、不確実性、任意の詳細
- ファイルメタデータ、ハンク見出しと行範囲、グループごとの完全な差分
- サイズ超過や解釈不能な差分の未解析ファイルと理由

Canvas 内にステータス、注記、確認質問、手動グループ編集・並べ替えのUIはありません。図、依存関係ビュー、フローチャート、シーケンス図、Mermaidソースも提供しません。

## 解析モデル

差分を読み込むと、まず拡張内の決定的解析が候補グループを作ります。パス、差分の特徴、import/require 等の変更ファイル間参照を使い、次を推定します。

- 役割: セキュリティ、データベース、依存関係、API、UI、テスト、ドキュメント、設定、実装
- 高影響シグナル: breaking change、DB/migration、公開API、認証/権限、データ整合性、広い依存関係・変更範囲
- 証拠: ファイル、ハンク見出し、追加行の行範囲（取得できる場合）
- 影響順: 高影響を先頭、同順位は変更行数の降順、最後にパス順

すべての変更ファイルをグループに含めます。分類できないファイルは末尾の「横断・サポート」グループに理由付きで残します。解析上限を超えた差分は、解析できる部分を表示し、未解析ファイルを明示します。

決定的候補を表示した後、エージェントが要約を更新できます。エージェントは入力された差分内のファイルだけを使い、機能境界・名前・ストーリーを決めます。グループ更新により同じファイルが複数グループに現れることがあり、その場合も各グループに完全な差分を表示します。拡張内でモデル呼び出しは行いません。

## 使い方

エージェントに次のように依頼します。

```text
PR Review Lensを開いてください。
```

または差分を指定します。

```text
このUnified DiffをPR Review Lensでレビュー用に整理してください。
```

Canvas の入力欄に差分を貼り付けて「解析して表示」を押すこともできます。エージェントや別の GitHub 連携機能で取得した差分は `set_review_diff` に渡せます。

## Canvasアクション

Canvas ID は `pr-review-lens` です。

### `get_review_state`

入力は空のオブジェクトです。現在のストーリー状態を返します。

```json
{}
```

返却状態には、`reviewId`、PRメタデータ、`diff`、`groups`、`stats`、`analysisStatus`、`updatedAt`、`diffFingerprint`、`unparsedFiles`、`unparsedReason` が含まれます。依存関係グラフや図の状態は返しません。

`analysisStatus` は `cached`、`analyzing`、`ai-updated`、`error` のいずれかです。AI更新が失敗しても決定的なグループは保持され、グループごとの `aiError` と状態の `analysisError` で示されます。

### `set_review_diff`

Unified Diffを設定し、決定的解析を保存します。`diff` は必須です。通常の入力は最大4MB、3MBを超える場合は部分解析になります。

```json
{
  "diff": "diff --git a/src/example.js b/src/example.js\n...",
  "title": "Example PR",
  "repository": "owner/repository",
  "pullRequestNumber": 123,
  "language": "ja"
}
```

### `update_review_sections`

決定的候補に対するエージェント要約を構造化して反映します。旧アクション名を維持していますが、対象はレビューセクションの編集ではなくストーリーグループのAI要約です。`groups`（互換のため `sections` も可）には、次のフィールドだけを使います。

`id`、`filePaths`、`title`、`role`、`summary`、`impact`、`evidence`、`relatedGroups`、`uncertainty`、`detail`

`status`、`notes`、`reviewQuestions`、図、Mermaid、依存関係は受け付けません。`filePaths` に入力差分にないファイルがあれば除外し、使えるフィールドを保持します。`replaceAll: true` はサニタイズ済みグループを原子的に置換し、未指定の変更ファイルは横断・サポートグループに戻します。

```json
{
  "replaceAll": false,
  "groups": [
    {
      "id": "group-0123456789abcdef",
      "filePaths": ["src/auth/middleware.ts"],
      "title": "認証境界を追加",
      "role": "security",
      "summary": "リクエスト処理前に認証を適用する変更です。",
      "impact": "high",
      "evidence": [
        { "file": "src/auth/middleware.ts", "hunk": "@@ -10,2 +10,8 @@", "lineStart": 12, "lineEnd": 18 }
      ],
      "relatedGroups": [],
      "uncertainty": "公開ルートの網羅性は差分だけでは確定できません。",
      "detail": "各ルートの認証適用と失敗時レスポンスを確認してください。"
    }
  ]
}
```

AIが要約できない場合は、次のように決定的状態を残したままエラーを表示できます。

```json
{ "error": "AI要約を生成できませんでした。", "groups": [] }
```

## ローカルHTTPインターフェース

Canvas はインスタンスごとに `127.0.0.1` の一時ポートでサーバーを起動します。

| メソッド | パス | 用途 |
| --- | --- | --- |
| `GET` | `/` | Canvas HTML（読み取り専用ストーリー） |
| `GET` | `/api/state` | 現在のストーリー状態 |
| `GET` | `/events` | Server-Sent Eventsで状態更新を配信 |
| `POST` | `/api/load` | Unified Diffを決定的解析して保存 |

手動編集用の PATCH API はありません。状態更新はエージェント向け Canvas アクションから行います。

## 状態の保存

レビュー状態は次の場所にJSONとして保存されます。

```text
$COPILOT_HOME/extensions/pr-review-lens/artifacts/reviews/
```

`COPILOT_HOME` が未設定の場合は `$HOME/.copilot/extensions/pr-review-lens/artifacts/reviews/` です。保存キーは Canvas の `instanceId` ではなくレビューIDです。

保存処理はレビューIDごとに直列化し、一時ファイルからのrenameで状態を原子的に置き換えます。90日以上更新されていない状態を削除し、保存数が100件を超えた場合は古いものから整理します。旧バージョンの `sections`、`importance`、`dependencies`、`diagrams` を含むJSONは読み込み時に新しいストーリー状態へ正規化します（図・依存関係は返却状態に復元しません）。

## 制限事項

- GitHub PR、ブランチ、コミットを自動取得しない
- GitHubアクセストークンや認証情報を使用しない
- 解析は決定的なヒューリスティックであり、コードの正しさや脆弱性を保証しない
- 言語は入力メタデータを表示するだけで、モデル言語検出は行わない
- 通常の差分入力は4MBまで。3MBを超える差分は部分解析し、未解析ファイルを表示する
- AI更新は入力差分のファイルだけを許可し、未知のファイル参照や不正な部分はサニタイズして保持可能な部分を反映する

## ファイル構成

```text
.github/extensions/pr-review-lens/
├── extension.mjs       # SDKへの登録
├── canvas.mjs          # Canvas定義とエージェント向けアクション
├── server.mjs          # ループバックHTTPサーバーとSSE
├── state.mjs           # 状態保存、正規化、原子的更新
├── analysis.mjs        # Unified Diffの決定的解析と内部影響判定
├── review-input.mjs    # 入力検証とAIフィールドのサニタイズ
├── renderer.mjs        # 読み取り専用ストーリーUI
├── constants.mjs       # 定数と表示ラベル
└── utils.mjs           # 共通ユーティリティ
```

## 開発・再読み込み

ファイルを変更した後はCopilot CLIで拡張を再読み込みします。

```text
extensions_reload
```

状態確認には次を使えます。

```text
extensions_manage({ operation: "list" })
extensions_manage({ operation: "inspect", name: "pr-review-lens" })
```
