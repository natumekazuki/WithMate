# Codex Approval Research

## Goal

- WithMate から `@openai/codex-sdk` を使うときの `Approval` 境界を整理する
- `approvalMode=on-request` でもコマンドが動くように見える理由を、CLI / SDK / WithMate 実装に分けて整理する
- CLI の `"/"` コマンドを SDK 経由でどう扱うべきかの設計前提を残す

## Scope

- Codex CLI / Codex SDK の approval 関連仕様
- `@openai/codex-sdk` ローカル実装の確認
- WithMate の `src-electron/codex-adapter.ts` における mapping 確認
- slash command 対応の論点整理

## Sources

### Official

- OpenAI Developers: Codex SDK
  - <https://developers.openai.com/codex/sdk>
- OpenAI Developers: Agent approvals & security
  - <https://developers.openai.com/codex/agent-approvals-security>
- OpenAI Developers: Slash commands
  - <https://developers.openai.com/codex/cli/slash-commands>
- ローカル package: `node_modules/@openai/codex-sdk/README.md`
- ローカル package: `node_modules/@openai/codex-sdk/dist/index.d.ts`
- ローカル package: `node_modules/@openai/codex-sdk/dist/index.js`
- GitHub Docs: Getting started with Copilot SDK
  - <https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started>
- GitHub Docs: About Copilot CLI
  - <https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli>
- GitHub Docs: Automating tasks with Copilot CLI and GitHub Actions
  - <https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/automate-with-actions>
- GitHub Docs: Using hooks with Copilot CLI for predictable, policy-compliant execution
  - <https://docs.github.com/copilot/tutorials/copilot-cli-hooks>

### Supplementary

- Qiita: Codex config.toml 設定項目一覧
  - <https://qiita.com/nogataka/items/5c6ca10914a97cdb9844>
- Qiita: Codex CLIことはじめ
  - <https://qiita.com/oga_aiichiro/items/303da2779ea26b173947>
- Zenn: OpenAI Codex CLI: Execution Policy Rules 完全ガイド & ベストプラクティス
  - <https://zenn.dev/kohei_miki_im8/articles/509707dd64a868>
- GitHub issue: Slash commands for `codex exec`
  - <https://github.com/openai/codex/issues/4108>

## Confirmed Facts

### 1. SDK は独自 runtime ではなく CLI wrapper

- OpenAI 公式の SDK ページは `@openai/codex-sdk` を「local Codex agents を programmatically control する TypeScript library」と説明している
- ローカル package の `node_modules/@openai/codex-sdk/README.md` には、SDK が `@openai/codex` の CLI を wrap し、`stdin/stdout` で JSONL event をやり取りすると明記されている
- したがって WithMate から見た `Approval` 挙動の一次的な実体は、SDK 独自仕様ではなく Codex CLI 側にある

### 2. SDK の `approvalPolicy` は CLI `approval_policy` に渡される

- `node_modules/@openai/codex-sdk/dist/index.d.ts` では `approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted"` が `ThreadOptions` に定義されている
- `node_modules/@openai/codex-sdk/dist/index.js` では `args.approvalPolicy` があると `--config approval_policy="..."` を CLI に渡している
- つまり SDK 側で Approval を別実装しているのではなく、CLI 設定へ転送しているだけである

### 3. WithMate も approval mode をそのまま SDK へ渡している

- `src-electron/codex-adapter.ts` では `mapApprovalPolicy(session.approvalMode)` を通して `approvalPolicy` を作り、`client.startThread()` / `client.resumeThread()` の `ThreadOptions` に渡している
- 同ファイルでは `sandboxMode` を現状 `workspace-write` 固定で渡している

### 4. 公式 docs の approval は「毎回確認」ではなく policy + sandbox の組み合わせ

- OpenAI Developers の `Agent approvals & security` には、`--ask-for-approval never` と `--sandbox` を組み合わせて autonomy を調整するとある
- 同ページの例では `approval_policy = "untrusted"` と `sandbox_mode = "read-only"` の設定例、および profile 例として `approval_policy = "on-request"` と `sandbox_mode = "workspace-write"` が示されている
- 同ページでは `workspace-write + untrusted` を「untrusted commands を走らせる前に approval を求める」例として説明している

## Interpretation For WithMate

### 1. `on-request` は「すべてのコマンドを都度確認」ではない

- 公式 docs は `on-request` を「毎コマンド確認」とは説明していない
- SDK も CLI へ `approval_policy` を渡すだけなので、WithMate 側で追加の prompt gating をしていない限り、CLI 側が approval 不要と判断した操作はそのまま進みうる
- 特に WithMate は `workspace-write` 固定なので、workspace 内の編集や CLI が trusted 扱いする command は `on-request` でも即実行に見える可能性がある

### 2. 「都度確認したい」に近い感覚は `untrusted` のほう

- 公式 docs 上で「approval before running untrusted commands」と明示されているのは `untrusted`
- したがって現ユーザー期待が「shell command 実行前は基本確認してほしい」に近いなら、`on-request` の UI ラベルは期待に対して弱い
- この点は WithMate UI 文言の見直し候補になる

### 3. granular approval は CLI にはあるが、SDK surface は薄い

- `Agent approvals & security` には `approval_policy = { granular = { ... } }` の例がある
- ただし `node_modules/@openai/codex-sdk/dist/index.d.ts` の `approvalPolicy` は string union だけで、granular object を直接受ける型にはなっていない
- そのため TypeScript SDK 0.114.0 時点では、granular policy を使うなら `approvalPolicy` ではなく global `config` override 経由で CLI 設定を注入できるかを別途検証する必要がある

## Slash Command Findings

### 1. SDK 公式 docs に slash command API は見当たらない

- OpenAI Developers の SDK ページは `startThread()`, `resumeThread()`, `run()`, `runStreamed()` を中心に説明している
- 同ページ内では slash command を SDK API として扱う記述は確認できなかった

### 2. CLI / IDE の slash command は UI 機能として扱うほうが安全

- OpenAI Developers には CLI / IDE 用の slash command ページが別に存在する
- 一方で SDK docs は thread と turn を programmatic に扱う説明に留まる
- この差から、slash command は generic agent API というより Codex CLI / IDE の interaction layer 機能として扱うのが自然である

### 3. headless parity も限定的と見るべき

- GitHub issue `#4108` では `codex exec` で slash commands が使えない、という要望が上がっている
- これは公式仕様そのものではないが、少なくとも slash command parity がすべての実行形態で自明ではないことを示す補助根拠にはなる

## GitHub Copilot SDK / CLI Findings

### 1. Copilot SDK も CLI 接続前提の wrapper

- GitHub Docs の `Getting started with Copilot SDK` では、SDK 利用前提として Copilot CLI の install / auth を要求している
- 同ページでは `CopilotClient()` を「Copilot CLI への connection を管理する client」と説明している
- したがって Copilot 側も WithMate から見れば SDK 独自 runtime というより CLI front-end と見るのが自然である

### 2. Copilot CLI の approval は tool allowlist / ask-user 前提

- `About Copilot CLI` では、programmatic mode で CLI を使う場合に `--allow-tool` などの approval option を付けるよう案内している
- `Automating tasks with Copilot CLI and GitHub Actions` では、`--allow-tool`, `--allow-all-tools`, `--no-ask-user` を使い、非対話環境では prompt しない運用を明示している
- つまり Copilot CLI では Codex の `approval_policy` のような抽象 policy というより、許可する tool と非対話実行フラグの組み合わせで制御する色が強い

### 3. Copilot SDK docs からは app-level approval callback は読み取れない

- `Getting started with Copilot SDK` にある event 例は `assistant.message_delta` や `session.idle` で、approval request / approve / deny の callback は確認できなかった
- 少なくとも公開 getting-started の範囲では、SDK が app 側へ「この tool 実行を許可するか」を問い合わせる API は見えていない

### 4. Copilot CLI は CLI 側の policy enforcement を持つ

- `Using hooks with Copilot CLI for predictable, policy-compliant execution` では `preToolUse` hook で tool call を inspect し、block できると説明している
- したがって Copilot 側で厳密な承認や制限をしたい場合、SDK callback より CLI allowlist / hook を使う設計が本筋に近い

## Cross-Provider Comparison

| 項目 | Codex SDK | Copilot SDK |
| --- | --- | --- |
| 実体 | Codex CLI wrapper | Copilot CLI connection wrapper |
| 公式 docs 上の承認設定 | `approval_policy` + sandbox | `--allow-tool` / `--allow-all-tools` / `--deny-tool` / `--no-ask-user` |
| SDK docs で見える event | `thread.started`, `item.*`, `turn.*`, `error` | `assistant.message_delta`, `session.idle` など |
| SDK docs 上の app approval callback | 確認できず | 確認できず |
| 非対話実行の考え方 | CLI policy に委譲 | 事前 allowlist と `--no-ask-user` に寄せる |

## UI Implication For WithMate

### 1. provider 生仕様をそのまま UI に出さない

- Codex は `approval_policy`、Copilot は tool allowlist と ask-user で考え方が異なる
- そのため WithMate の UI は provider native wording をそのまま見せるより、共通の approval intent を先に定義したほうがよい

### 2. 共通 UI は `approval request` event 依存ではなく app 制御を基本にする

- 現時点で確認できる SDK surface では、Codex / Copilot どちらも「承認待ち event を受けて app が approve を返す」形が明確ではない
- したがって 2 provider で同じ UI にしたいなら、provider 側の native prompt を待つより WithMate 側で preflight confirmation と policy mapping を持つほうが安定する

### 3. 内部モデルは provider-neutral に切る

WithMate では少なくとも次の内部モードに寄せると扱いやすい。

- `confirm-dangerous-actions`
- `allow-workspace-safe-actions`
- `allow-listed-tools-only`
- `full-auto`

これを provider ごとに次のように変換する。

- Codex:
  - `approval_policy`
  - `sandbox_mode`
  - 必要なら `config` override
- Copilot:
  - `--allow-tool`
  - `--deny-tool`
  - `--allow-all-tools`
  - `--no-ask-user`
  - 必要なら hook

## Design Implication For WithMate

### Approval

- `approvalMode` は CLI policy の thin wrapper である、と設計上明記する
- `on-request` を「毎回承認」相当の文言で説明しない
- 実際にどこで止まるかは `sandboxMode`, rules, command trust 判定, MCP elicitation を含む複合結果として扱う
- 「都度確認」の UX が必要なら、SDK / CLI 仕様に依存せず WithMate 側で preflight confirmation を足すかを別判断する

### Slash Commands

- WithMate は CLI の `"/"` コマンドを SDK がそのまま提供すると期待しない
- slash command を入れる場合は次のどれかとして扱う
  - renderer 側の UI command
  - main process 側の app command
  - adapter で prompt / config 変換する app-specific shortcut
- unknown slash input をそのまま SDK へ渡す設計は避ける
  - CLI parity が不明なため
  - 将来の SDK 差分で意味が変わるリスクがあるため

## Recommended Validation

WithMate で approval を仕様確認するなら、少なくとも次の matrix を実測する。

- `approvalMode=never`
  - workspace 内 read command
  - workspace 内 write command
  - workspace 外参照 attachment あり
- `approvalMode=on-request`
  - `rg`, `git status`, `npm test` 相当
  - `bash -lc` / PowerShell 複合 command
  - network を伴う command
- `approvalMode=untrusted`
  - trusted / untrusted の分岐確認
- `approvalMode=on-failure`
  - sandbox 失敗後に approval へ昇格するケース確認

観測項目:

- 実行前 prompt の有無
- 実行された command 文字列
- live step event の差
- canceled / approved / denied の扱い
- audit log に残る情報

## Open Questions

- Codex CLI における trusted / untrusted 判定の詳細基準はどこまで公開されているか
- SDK の `config` override で granular approval policy を安全に渡せるか
- WithMate がほしい slash command は CLI parity なのか、単に app shortcut なのか

## Current Recommendation

- 短期的には `Approval` を CLI policy の薄い wrapper として扱い、UI 期待値を修正する
- `on-request` を「都度承認」と同義にしない
- slash command は SDK 機能として探すより、WithMate 固有 command layer として切り出す前提で設計する
- Copilot を含めて同じ UI を出したいなら、native approval prompt を UI 基準にせず、WithMate 側の provider-neutral approval model を先に定義する

slash command の詳細整理は `docs/design/slash-command-integration.md` を参照する。

## Adopted WithMate Direction

### Shared Modes

WithMate は approval を次の 3 モードで扱う。

- `allow-all`
- `safety`
- `provider-controlled`

### Why This Shape

- Codex の `never / on-request / untrusted / on-failure` を UI に直接出すと Copilot と揃わない
- Copilot は tool allowlist ベースなので、`confirm all` のような wording とも噛み合いにくい
- app 側で独自 block を持たない前提なら、最も慎重な選択肢も `provider-controlled` のような名称に留めるのが安全

### Mapping Summary

- Codex
  - `allow-all` -> `approval_policy = "never"`
  - `safety` -> `approval_policy = "untrusted"`
  - `provider-controlled` -> `approval_policy = "on-request"`
- Copilot
  - `allow-all` -> `--allow-all-tools`
  - `safety` -> allowlist ベース
  - `provider-controlled` -> provider default / ask-user へ委譲

### Non-Goal

- WithMate は app 側の preflight confirmation や command block を持たない
- `provider-controlled` も「必ず毎回確認」ではなく、provider が最も慎重に扱う設定を指す
