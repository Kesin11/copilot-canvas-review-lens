# PR Review Lens

Pull Request の Unified Diff を、変更ファイルのパス順ではなく意味単位のストーリーとして整理する GitHub Copilot Canvas 拡張です。

この拡張は差分を外部サービスへ送信せず、Canvas とローカルの拡張プロセスだけで解析・保存します。GitHub の Pull Request を自動取得する機能は含まれていません。

## 提供する機能

### ストーリーとしての差分解析

- Unified Diff を Canvas の入力欄に貼り付けて解析
- 変更ファイル数、追加行数、削除行数、影響度を集計
- ファイルパス、変更内容、import / require などの参照関係から候補グループを生成
- 重要度、変更量、論理的な関連性に基づいてグループを並べ替え
- 各グループに役割、要約、証拠、関連グループ、不確実性を表示
- グループ内のファイルを変更行数つきの折りたたみ一覧として表示
- ファイルを展開すると、そのファイルだけのコードdiffを確認可能
- バイナリファイルや表示できないdiffは明示的なメッセージで表示
- 標準的な Unified Diff として解釈できない場合は、未解析の差分として保持

解析は次のような変更を高い影響度として扱います。

- 認証、権限、秘密情報などのセキュリティ境界
- データベース、migration、schema
- 依存関係やビルド設定
- API、route、controller、handlerなどの外部境界
- 大きな変更量や複数ファイルにまたがる変更

### AIによるストーリー要約

決定的な解析で作られた候補グループを、エージェントが差分内のファイルと証拠だけを根拠に要約できます。AI更新が失敗した場合も、決定的なグループを保持したままエラーを表示します。

Canvasは読み取り専用です。タイトル、要約、重要度、グループ構成、レビュー状態などをCanvas上で手動編集する機能はありません。

## 使い方

### Canvasを開く

エージェントに次のように依頼します。

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
4. 上から順にグループの要約、証拠、影響度を読む
5. 必要なファイルだけを展開してコードdiffを確認する

### GitHub PRの差分を使う場合

この拡張はGitHub APIを直接呼び出しません。エージェントや別のGitHub連携機能で累積PR差分を取得し、`set_review_diff` に渡すか、Canvasへ貼り付けてください。

## Canvasアクション

Canvas ID は `pr-review-lens` です。

### `get_review_state`

現在の読み取り専用ストーリー状態を取得します。

返却内容には次の情報が含まれます。

- `reviewId`
- タイトル、リポジトリ、Pull Request番号
- Unified Diff
- `groups`: グループのID、役割、要約、影響度、証拠、関連グループ
- `groups[].files`: ファイルパス、追加行数、削除行数、変更行数、バイナリ判定、個別パッチ
- 集計統計、分析状態、未解析ファイル

入力は空のオブジェクトです。

```json
{}
```

### `set_review_diff`

Unified Diffを設定し、決定的な候補グループを同期解析します。

```json
{
  "diff": "diff --git a/src/example.js b/src/example.js\n...",
  "title": "Example PR",
  "repository": "owner/repository",
  "pullRequestNumber": 123,
  "language": "ja"
}
```

`diff` は必須です。最大サイズは3MBです。

### `update_review_sections`

エージェントが生成したストーリー要約をグループへ反映します。`groups` を使用し、`filePaths` は現在の差分に存在するファイルだけを指定してください。

```json
{
  "replaceAll": true,
  "groups": [
    {
      "id": "group-example",
      "filePaths": ["src/example.js"],
      "title": "認証境界の追加",
      "role": "security",
      "summary": "リクエスト処理の前に認証を追加します。",
      "impact": {
        "level": "high",
        "reason": "未認証アクセスの挙動に影響します。"
      },
      "evidence": [
        {
          "file": "src/example.js",
          "lineStart": 12,
          "lineEnd": 18,
          "reason": "認証呼び出しの追加"
        }
      ],
      "uncertainty": "既存の別経路については差分だけでは確認できません。"
    }
  ]
}
```

受け付けるストーリーフィールドは `id`、`filePaths`、`title`、`role`、`summary`、`impact`、`evidence`、`relatedGroups`、`uncertainty`、`detail` です。図、依存関係、status、notes、reviewQuestionsは受け付けません。

`replaceAll` を省略すると指定したグループだけを既存状態へマージします。空の `replaceAll` は現在のグループを消去せず、エラー状態として保持します。

## ローカルHTTPインターフェース

Canvasを開くと、拡張はインスタンスごとに `127.0.0.1` の一時ポートでHTTPサーバーを起動します。

| メソッド | パス | 用途 |
| --- | --- | --- |
| `GET` | `/` | Canvas HTMLを返す |
| `GET` | `/api/state` | 現在のレビュー状態を返す |
| `GET` | `/events` | Server-Sent Eventsで状態更新を配信 |
| `POST` | `/api/load` | Unified Diffを解析して保存 |

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

保存時には90日以上更新されていないレビュー状態を削除し、保存済みレビューが100件を超えた場合は古いものから削除します。

## 制限事項

- GitHub PR、ブランチ、コミットを自動取得しない
- GitHubアクセストークンや認証情報を使用しない
- 解析は静的なヒューリスティックであり、コードの正しさや脆弱性を保証しない
- 参照関係は差分に含まれるファイル間のimport / requireなどに限定される
- すべてのプログラミング言語やimport形式を網羅しているわけではない
- 差分の最大サイズは3MB
- グループIDと候補の並び順は、同じ差分に対して安定するように生成される

## インストール場所とGit管理

このリポジトリでは、拡張をprojectスコープで共有・Git管理します。

```text
.github/extensions/pr-review-lens/
├── extension.mjs       # SDKへの登録を行うエントリポイント
├── canvas.mjs          # Canvas定義とエージェント向けアクション
├── server.mjs          # CanvasごとのローカルHTTPサーバー
├── state.mjs           # レビュー状態の保存、更新、SSE配信
├── analysis.mjs        # Unified Diffの解析とグループ・証拠の生成
├── review-input.mjs    # 入力値の検証とAI更新の正規化
├── renderer.mjs        # CanvasのHTML/CSS/ブラウザ側UI
├── constants.mjs       # 定数と表示ラベル
└── utils.mjs           # 共通ユーティリティ
```

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
