# Codex CLI と Codex SDK の機能対応

- 作成日: 2026-03-11
- 対象: `@openai/codex-sdk` / `codex` CLI
- 目的: WithMate で `Codex CLI` 相当の体験をアプリ実装へ持ち込むため、CLI の機能を SDK でどこまで再現できるかを整理する

## 結論

`Codex SDK` は `codex exec --json` 相当の非対話実行エンジンを TypeScript から利用するためのラッパーであり、プロンプト実行・継続スレッド・ストリーミングイベント・構造化出力・画像入力・ワークスペース内ファイル操作までは高い再現性がある。

一方で、CLI 全体に含まれる以下は SDK の直接責務ではない。

- 認証の開始 / ログアウト / 状態確認
- MCP サーバー定義の追加 / 削除 / ログイン管理
- `review` `apply` `completion` `sandbox` `debug` `cloud` などの専用サブコマンド
- TUI と対話 UI のふるまいそのもの

したがって WithMate の実装方針は、`Codex SDK` を中心に `exec` 相当のコア実行を担わせ、CLI の周辺運用機能はアプリ側機能または外部 CLI 呼び出しで補完する、という分離が妥当。

## 情報源の扱い

- `Direct`: SDK API として直接公開されている
- `Composed`: SDK の戻り値やアプリ側ロジックの組み合わせで実現できる
- `CLI-only`: 現時点では SDK 直公開が見当たらず、CLI 管理機能として扱う

## 対応表

| CLI/体験項目 | CLI での形 | SDK での再現 | 判定 | 根拠 / メモ |
| --- | --- | --- | --- | --- |
| 単発実行 | `codex exec [PROMPT]` | `thread.run(prompt)` | Direct | SDK 公式 README と SDK ページに記載 |
| 継続会話 | 同一セッションへの追加入力 | 同じ `Thread` に対して `run()` を再実行 | Direct | `run()` の再呼び出しが README に記載 |
| セッション再開 | `codex resume [SESSION_ID]` / `codex exec resume` | `codex.resumeThread(id)` | Direct | `~/.codex/sessions` の再開方法が README に記載 |
| ストリーミングイベント | `codex exec --json` | `thread.runStreamed()` | Direct | JSONL イベント列と SDK の `AsyncGenerator` が対応 |
| 構造化出力 | `--output-schema` | `thread.run(prompt, { outputSchema })` | Direct | JSON Schema 指定を README と CLI docs が記載 |
| 画像入力 | `--image` | `thread.run([{ type: "text" }, { type: "local_image" }])` | Direct | README に記載 |
| 作業ディレクトリ指定 | `--cd` | `startThread({ workingDirectory })` | Direct | README と型定義に記載 |
| Git リポジトリチェック回避 | `--skip-git-repo-check` | `startThread({ skipGitRepoCheck: true })` | Direct | README と CLI docs が対応 |
| モデル指定 | `--model` | `startThread({ model })` | Direct | CLI docs と型定義が対応 |
| サンドボックス指定 | `--sandbox read-only/workspace-write/danger-full-access` | `startThread({ sandboxMode })` | Direct | CLI docs と型定義が対応 |
| 追加書き込みディレクトリ | `--add-dir` | `startThread({ additionalDirectories })` | Direct | CLI docs と型定義が対応 |
| 承認ポリシー | `--ask-for-approval` | `startThread({ approvalPolicy })` | Direct | CLI docs と型定義が対応 |
| Web 検索 | `--search` | `startThread({ webSearchMode, webSearchEnabled })` | Direct | CLI docs と型定義が対応 |
| Reasoning 強度 | `-c model_reasoning_effort=...` | `startThread({ modelReasoningEffort })` | Direct | 型定義に `minimal/low/medium/high/xhigh` が存在 |
| ネットワークアクセス | `-c sandbox_workspace_write.network_access=true` | `startThread({ networkAccessEnabled: true })` | Direct | 型定義に公開、SDK は内部で `--config` 化する |
| グローバル設定 override | `-c key=value` | `new Codex({ config })` | Direct | SDK README と `CodexOptions` に記載 |
| 環境変数の受け渡し | CLI 実行環境そのもの | `new Codex({ env })` | Direct | SDK README と `CodexOptions` に記載 |
| API 接続先 / API key 差し替え | CLI の実行環境依存 | `new Codex({ baseUrl, apiKey })` | Direct | `CodexOptions` に公開 |
| ファイル操作 | モデルが shell / patch を使って編集 | `workspace-write` または `danger-full-access` で再現 | Composed | 実測で新規ファイル作成成功。`file_change` も取得 |
| コマンド実行ログ取得 | `--json` でイベント観測 | `runStreamed()` / `turn.items` の `command_execution` | Composed | 型定義に `command_execution` がある |
| MCP ツール利用結果取得 | `--json` でイベント観測 | `runStreamed()` / `turn.items` の `mcp_tool_call` | Composed | 型定義に `mcp_tool_call` がある |
| Web 検索イベント取得 | `--json` でイベント観測 | `runStreamed()` / `turn.items` の `web_search` | Composed | 型定義に `web_search` がある |
| Todo / plan 監視 | `--json` でイベント観測 | `runStreamed()` / `turn.items` の `todo_list` | Composed | 型定義に `todo_list` がある |
| Skills の利用 | CLI がインストール済み skill を読み込んで実行 | 専用 API はないが、SDK 経由で起動した CLI が skill discovery できれば再現可能 | Composed | 実測で `~/.codex/skills` の一時 skill を明示指定して応答成功 |
| Review 専用サブコマンド | `codex review` | 専用 API なし。レビュー用 prompt と出力整形で近似 | CLI-only | SDK 公開 APIは `Codex` / `Thread` 中心で review ヘルパーなし |
| `apply` サブコマンド | `codex apply <TASK_ID>` | 専用 API なし | CLI-only | SDK は既にワークスペース編集を直接実行できるが、`git apply` 的後適用は別機能 |
| 認証開始 / 状態確認 | `codex login`, `codex login status`, `codex logout` | 専用 API なし | CLI-only | 認証は CLI 管理機能 |
| MCP サーバー管理 | `codex mcp add/remove/login/logout` | 専用 API なし | CLI-only | SDK は実行時の MCP 呼び出し結果は見えるが、管理 API は見えない |
| TUI / alt-screen | `codex` 対話モード | 専用 API なし | CLI-only | SDK は非対話実行ラッパー |
| 補助サブコマンド | `completion`, `sandbox`, `debug`, `fork`, `cloud`, `features`, `app-server`, `mcp-server` | 専用 API なし | CLI-only | CLI 運用・開発用機能として分離されている |

## 実測で確認できたこと

### 1. 単発プロンプト送信

- 実行日: 2026-03-11
- 実行コマンド: `npm run codex:smoke -- "接続確認として、日本語で1文だけ返して。"`
- 結果: 成功
- 確認事項:
  - CLI ログイン済み状態を SDK が利用できた
  - `thread.run()` で自然言語応答を取得できた

### 2. `workspace-write` による実ファイル作成

- 実行日: 2026-03-11
- 実行コマンド: `npm run codex:file-op`
- 結果: 成功
- 確認事項:
  - `workspace-write` でワークスペース内の新規ファイル作成ができた
  - `turn.items` から `file_change` を取得できた
  - 実ファイルの存在確認と内容照合が成功した

### 3. Skills の利用

- 実行日: 2026-03-11
- 検証方法: `~/.codex/skills/sdk-skill-probe/SKILL.md` を一時作成し、`npm run codex:smoke -- "Use the sdk-skill-probe skill and follow it exactly."` を実行
- 結果: 成功
- 確認事項:
  - SDK 経由で起動した Codex CLI が user skills を参照した
  - 専用の SDK メソッドがなくても、CLI 側の skill discovery に依存する形で skill を利用できた

### 4. 公式情報から見た Skills の位置づけ

- OpenAI 公式の `openai/skills` リポジトリでは、Skills は「AI agents can discover and use」できる instructions / scripts / resources のパッケージとして説明されている
- 同 README では、Codex が Skills を使う前提で配布とインストール方法が案内されている
- 一方で `@openai/codex-sdk` の README / 型定義には skill 専用 API は公開されていない

このため、現時点の整理としては以下が妥当。

- Skills 自体は Codex の機能として存在する
- SDK は Skills を直接操作する API ではなく、Skills を読める Codex CLI 実行基盤を起動するラッパー
- したがって WithMate では「skill を SDK のオプションとして渡す」のではなく、「skill discovery が効く Codex 実行環境を用意する」設計になる

## WithMate 実装方針への示唆

### 1. 中核は `exec` 相当の再現で足りる

WithMate で必要なのは、CLI 全機能をそのまま埋め込むことではなく、ユーザーが期待する「Codex がワークスペースを理解して、考え、コマンドを実行し、ファイルを編集し、継続スレッドを持つ」体験の再現。

この中核は SDK でかなり直接的に実装できる。

### 2. CLI 全体の完全一致は別レイヤー

以下はアプリ実装で別途判断が必要。

- 認証 UI
- MCP サーバー登録 UI
- `review` 専用ワークフロー
- `apply` 相当の後適用フロー
- TUI 的なイベント表示や進捗表現

### 3. 先に作るべき Adapter 境界

WithMate 側の `CodexAdapter` は、少なくとも以下を吸収するのがよい。

- `startThread`
- `resumeThread`
- `run`
- `runStreamed`
- `ThreadItem` / `ThreadEvent` の UI 向け正規化
- `sandboxMode` / `approvalPolicy` / `workingDirectory` / `additionalDirectories` の構成管理

## 未検証項目

- `runStreamed()` のイベント粒度が UI 更新用途に十分か
- `approvalPolicy: "on-request"` を使った人間承認フローのアプリ実装難度
- `webSearchMode` と `networkAccessEnabled` の組み合わせ
- `resumeThread()` と永続化したセッション一覧の統合方式
- `danger-full-access` をアプリで許可するかどうか
- `review` 相当の専用 UX を prompt ベースで十分再現できるか
- project-local skill の探索パスが `~/.codex/skills` 以外でどこまで有効か

## 参考資料

### OpenAI / 公式ドキュメント

- `https://developers.openai.com/codex/sdk`
- `https://developers.openai.com/codex/cli/reference`
- `https://developers.openai.com/codex/noninteractive`
- `https://developers.openai.com/codex/auth`

### OpenAI 公式配布物

- `node_modules/@openai/codex-sdk/README.md`
- `node_modules/@openai/codex-sdk/dist/index.d.ts`
- `node_modules/@openai/codex/README.md`
- `https://github.com/openai/skills`
