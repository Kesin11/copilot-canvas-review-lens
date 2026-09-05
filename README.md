# PR Review Lens

Pull Request の Unified Diff を意味単位に整理し、コードレビュー時の認知負荷を下げる GitHub Copilot Canvas 拡張です。

この拡張は差分を外部サービスへ送信せず、Canvas とローカルの拡張プロセスだけで解析・保存します。GitHub の Pull Request を自動取得する機能は含まれていません。

## 提供する機能

### Unified Diff の解析

- Unified Diff を Canvas の入力欄に貼り付けて解析
- 変更ファイル数、追加行数、削除行数を集計
- ファイルパスと差分の特徴から変更種別を推定
- 変更種別ごとに意味単位のレビューセクションを生成
- 各セクションに関連ファイルと差分抜粋を表示
- 長い差分はセクションごとに抜粋し、切り詰めたことを表示
- 標準的な Unified Diff として解釈できない場合は、差分全体を「未分類の差分」として表示

変更種別は次のカテゴリに分類されます。

| カテゴリ | 主な判定対象 |
| --- | --- |
| 権限・セキュリティ | `auth`、`security`、`permission`、`token`、`oauth` など |
| データベース・スキーマ | migration、schema、database、`.sql`、`.prisma` など |
| 依存関係・ビルド | `package.json`、lockfile、`go.mod`、`Cargo.toml` など |
| API・サーバー境界 | api、route、controller、handler、HTTP、GraphQL など |
| テスト | `tests`、`spec`、`.test.*`、`.spec.*` など |
| ドキュメント | `docs`、`.md`、`.mdx`、`.rst` など |
| 画面・UI | `.tsx`、`.jsx`、Vue、Svelte、CSS、components など |
| 設定 | JSON、YAML、TOML、`.github`、config など |
| 実装 | 上記に該当しない変更 |

### 重要度の推定

セクションごとに重要度を自動推定します。

- **高**: セキュリティ、データベース、依存関係、規模の大きい変更など
- **中**: API、複数ファイル、一定量の変更など
- **低**: 比較的小規模な変更

重要度は初期推定値です。Canvas上で変更できます。

### レビュー情報の編集

各セクションで次の項目を編集・保存できます。

- セクションタイトル
- セクション説明
- 重要度
- レビュー状態
- レビュー注記

レビュー状態は次の4種類です。

- `未確認`
- `確認中`
- `問題なし`
- `要確認`

エージェントから更新された確認観点（`reviewQuestions`）も表示されます。

### 依存関係の表示

変更ファイル内の import や require などを調べ、今回の差分に含まれる変更ファイル同士の依存関係を表示します。

対応している主な参照形式は次のとおりです。

- JavaScript / TypeScript の `import`
- CommonJS の `require`
- Python の `from ... import`
- Python 形式の `import`
- C/C++ の `#include`

依存先が今回の差分に含まれるファイルとして解決できた場合だけ、依存関係グラフに追加されます。

### フローチャートとシーケンス図

解析結果から次の図を生成します。

- 変更セクション間の依存関係を表すフローチャート
- Reviewer が各セクションを確認する流れを表すシーケンス図

図は外部 CDN や Mermaid サーバーに依存せず、Canvas内でSVGとして描画されます。元の Mermaid ソースも展開して確認できます。

自動生成される図は、次の Mermaid サブセットを対象にしています。

- `flowchart LR`、`flowchart RL`、`flowchart TB`、`flowchart TD`
- `graph` 形式の基本的なノードと矢印
- `sequenceDiagram`
- `participant`
- 基本的なメッセージ矢印

`update_dependency_view` で任意の図を設定した場合、簡易描画に対応しない構文はソースをテキストでフォールバック表示します。

## 使い方

### Canvasを開く

エージェントに、次のように依頼します。

```text
PR Review Lensを開いてください。
```

または、対象の差分を指定して開きます。

```text
このUnified DiffをPR Review Lensでレビュー用に整理してください。
```

Canvasを開いた時の入力に `diff` を含めると、表示時に自動解析されます。

### Canvasから解析する

1. Canvasの「レビュー対象のUnified Diff」を開く
2. `git diff` または Pull Request の Unified Diff を貼り付ける
3. 「解析して表示」を押す
4. セクション、重要度、依存関係、図を確認する
5. 必要に応じてタイトル、説明、重要度、状態、注記を編集する
6. 各セクションの「注記を保存」を押す

### GitHub PRの差分を使う場合

この拡張はGitHub APIを直接呼び出しません。エージェントや別のGitHub連携機能で差分を取得し、`set_review_diff` に渡すか、Canvasへ貼り付けてください。

例:

```text
owner/repository の PR #123 のUnified Diffを取得し、
PR Review Lensで意味単位に分解してください。
```

## Canvasアクション

Canvas ID は `pr-review-lens` です。

### `get_review_state`

現在のレビュー状態を取得します。

返却内容には次の情報が含まれます。

- `reviewId`
- タイトル、リポジトリ、Pull Request番号
- Unified Diff
- レビューセクション
- 依存関係のノードとエッジ
- フローチャートとシーケンス図のソース
- 集計統計
- 最終更新時刻

入力は空のオブジェクトです。

```json
{}
```

### `set_review_diff`

Unified Diffを設定し、解析結果を保存します。

```json
{
  "diff": "diff --git a/src/example.js b/src/example.js\n...",
  "title": "Example PR",
  "repository": "owner/repository",
  "pullRequestNumber": 123
}
```

`diff` は必須です。最大サイズは3MBです。

### `update_review_sections`

レビューセクションをエージェントから更新します。

```json
{
  "sections": [
    {
      "id": "section-security-1",
      "title": "認証処理の追加",
      "description": "リクエスト処理の前に認証を実行する変更です。",
      "importance": "high",
      "importanceReason": "未認証アクセスに影響します。",
      "status": "needs-attention",
      "notes": "認証失敗時のレスポンスを確認する。",
      "reviewQuestions": [
        "認証処理はすべての経路で実行されるか？"
      ]
    }
  ]
}
```

デフォルトでは指定されたセクションだけを既存状態へマージします。全セクションを置き換える場合は、次のように `replaceAll` を指定します。

```json
{
  "replaceAll": true,
  "sections": []
}
```

`importance` は `high`、`medium`、`low`、`status` は `unreviewed`、`reviewing`、`accepted`、`needs-attention` のいずれかです。

### `update_dependency_view`

依存関係と図の内容を更新します。

```json
{
  "dependencies": {
    "nodes": [
      { "id": "module-1", "label": "src/api.js", "sectionId": "section-api-1" }
    ],
    "edges": [
      { "from": "module-1", "to": "module-2", "label": "./auth.js" }
    ]
  },
  "flowchart": "flowchart LR\n  A[API] -->|依存| B[認証]",
  "sequence": "sequenceDiagram\n  participant R as Reviewer\n  participant A as API\n  R->>A: 意図を確認"
}
```

指定された項目だけが更新されます。

## ローカルHTTPインターフェース

Canvasを開くと、拡張はインスタンスごとに `127.0.0.1` の一時ポートでHTTPサーバーを起動します。

| メソッド | パス | 用途 |
| --- | --- | --- |
| `GET` | `/` | Canvas HTMLを返す |
| `GET` | `/api/state` | 現在のレビュー状態を返す |
| `GET` | `/events` | Server-Sent Eventsで状態更新を配信 |
| `POST` | `/api/load` | Unified Diffを解析して保存 |
| `PATCH` | `/api/sections/:id` | セクションの編集内容を保存 |

このサーバーはループバックアドレスにのみバインドされ、外部ネットワークから直接アクセスできるようにはしていません。

## 状態の保存

レビュー状態は次の場所へJSONとして保存されます。

```text
$COPILOT_HOME/extensions/pr-review-lens/artifacts/reviews/
```

`COPILOT_HOME` が未設定の場合は、通常次の場所です。

```text
$HOME/.copilot/extensions/pr-review-lens/artifacts/reviews/
```

レビューIDは次の優先順位で決まります。

1. 明示された `reviewId`
2. `repository` と `pullRequestNumber` から生成したID
3. Unified DiffのSHA-256ハッシュ
4. `new-review`

Canvasの `instanceId` ではなくレビューIDを保存キーにするため、Canvasを再オープンしても同じレビュー状態を復元できます。

保存時には次の整理が行われます。

- 90日以上更新されていないレビュー状態を削除
- 保存済みレビューが100件を超えた場合、古いものから削除
- 現在開いているレビューや更新中のレビューは削除対象から除外

複数の更新が同時に発生した場合は、レビューIDごとに直列化して保存します。

## 制限事項

- GitHub PR、ブランチ、コミットを自動取得しない
- GitHubアクセストークンや認証情報を使用しない
- 解析は静的なヒューリスティックであり、コードの正しさや脆弱性を保証しない
- 依存関係は差分に含まれるファイル間の参照だけを対象とする
- すべてのプログラミング言語、import形式、Mermaid構文に対応しているわけではない
- 差分の最大サイズは3MB
- セクションに表示する差分は最大約18,000文字で、超過分は抜粋表示になる
- SVG描画に対応しない図はMermaidソースのテキスト表示になる

## インストール場所とGit管理

このリポジトリでは、拡張をprojectスコープで共有・Git管理します。

```text
.github/extensions/pr-review-lens/
├── extension.mjs       # SDKへの登録だけを行うエントリポイント
├── canvas.mjs          # Canvas定義とエージェント向けアクション
├── server.mjs          # CanvasごとのローカルHTTPサーバー
├── state.mjs           # レビュー状態の保存、更新、SSE配信
├── analysis.mjs        # Unified Diffの解析と図・依存関係の生成
├── review-input.mjs    # 入力値の検証とセクション更新の正規化
├── renderer.mjs        # CanvasのHTML/CSS/ブラウザ側UI
├── constants.mjs       # 定数と表示ラベル
└── utils.mjs           # 共通ユーティリティ
```

プロジェクトスコープの拡張は、そのリポジトリを開いたCopilotセッションで読み込まれます。同名のプロジェクト拡張がある場合、プロジェクト側がユーザースコープ側より優先されます。

## 開発・再読み込み

`extension.mjs` または関連ファイルを変更した後は、Copilot CLIで拡張を再読み込みします。

```text
extensions_reload
```

状態を確認する場合は、次の操作を使います。

```text
extensions_manage({ operation: "list" })
extensions_manage({ operation: "inspect", name: "pr-review-lens" })
```

拡張のエントリポイントは必ず `extension.mjs` である必要があります。内部実装を複数の `.mjs` ファイルへ分割する場合も、`extension.mjs` からそれらをimportしてください。
