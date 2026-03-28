# Slash Command Integration

## Position

- 状態: review note
- current 実装では slash command 吸収は未着手であり、本書は将来の統合判断メモとして扱う
- current provider 実装の正本は `docs/design/provider-adapter.md`

## Goal

- Codex と GitHub Copilot CLI の `"/"` コマンドを整理する
- SDK 経由では provider-native slash command をそのまま実行できない前提を明確にする
- WithMate 側でどの command をどの層に実装するかを決める

## Sources

### Codex

- OpenAI Developers: Slash commands in Codex CLI
  - <https://developers.openai.com/codex/cli/slash-commands>
- OpenAI Developers: Codex SDK
  - <https://developers.openai.com/codex/sdk>

### GitHub Copilot

- GitHub Docs: CLI command reference
  - <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>
- GitHub Docs: Using GitHub Copilot CLI
  - <https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli>
- GitHub Docs: Getting started with Copilot SDK
  - <https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started>

## Findings

### 1. Codex の slash command は CLI interactive UI の機能

Codex CLI docs では、built-in slash command として少なくとも次が案内されている。

- `/permissions`
- `/sandbox-add-read-dir`
- `/agent`
- `/apps`
- `/clear`
- `/compact`
- `/copy`
- `/diff`
- `/experimental`
- `/feedback`
- `/init`
- `/logout`
- `/mcp`
- `/mention`
- `/model`
- `/fast`
- `/plan`
- `/personality`
- `/ps`
- `/fork`
- `/resume`
- `/new`
- `/review`
- `/status`
- `/debug-config`
- `/statusline`
- `/quit`, `/exit`

補足:

- `/approvals` は alias として残っている
- `/plan` は task 実行中には使えない
- docs 上の説明は CLI の popup / picker / transcript 更新を前提にしている

### 2. Copilot CLI の slash command も interactive UI の機能

GitHub Docs の command reference では、少なくとも次が interactive slash command として列挙されている。

- `/add-dir`
- `/agent`
- `/allow-all`, `/yolo`
- `/clear`, `/new`
- `/compact`
- `/context`
- `/cwd`, `/cd`
- `/delegate`
- `/diff`
- `/exit`, `/quit`
- `/experimental`
- `/feedback`
- `/fleet`
- `/help`
- `/ide`
- `/init`
- `/list-dirs`
- `/login`
- `/logout`
- `/lsp`
- `/mcp`
- `/model`, `/models`
- `/plan`
- `/plugin`
- `/rename`
- `/reset-allowed-tools`
- `/resume`
- `/review`
- `/session`
- `/share`
- `/skills`
- `/terminal-setup`
- `/theme`
- `/usage`
- `/user`

補足:

- `Ctrl+X` の後に `/` で slash command を開ける
- `?` と `/help` がヘルプ導線として案内されている
- interactive CLI と programmatic CLI option が同じ docs に併記されている

### 3. SDK docs には slash command API が見えない

- Codex SDK docs は `Codex`, `startThread()`, `run()`, `resumeThread()` を中心に説明している
- Copilot SDK docs は `CopilotClient`, `createSession()`, `sendAndWait()`, `assistant.message_delta`, `session.idle` を中心に説明している
- どちらも SDK docs には slash command の専用 API や `runSlashCommand()` に相当する surface が確認できない

結論:

- provider-native slash command は SDK API ではなく CLI interactive layer の機能として扱う
- WithMate から SDK 経由で `/model` や `/compact` をそのまま送る設計は採らない

## Command Classification For WithMate

WithMate では slash command を 3 層に分ける。

### A. App Command

WithMate 自身が処理する command。provider に依存しない。

- `/new`
- `/resume`
- `/diff`
- `/review`
- `/status`
- `/help`

想定実装:

- Renderer で slash command を parse
- Main Process へ app command として IPC
- session store / diff window / review flow / UI help を直接更新

### B. Session Setting Command

WithMate の session metadata を更新し、次 turn 以降の provider 実行条件を変える command。

- `/model`
- `/plan`
- `/approval` または `/permissions`
- `/cwd` 相当
- `provider = copilot` 時の `/agent`

想定実装:

- Renderer で command parse
- Main Process が session metadata を更新
- adapter は次回 `runSessionTurn()` で更新済み metadata を読む

補足:

- provider-native 名は UI alias として扱ってよい
- 実際の保存値は WithMate の共通 state を使う

### C. Provider-only / Out of Scope

CLI interactive 特有で、WithMate では最初から再現しない command。

- Codex: `/statusline`, `/copy`, `/experimental`, `/sandbox-add-read-dir`, `/logout`, `/apps`, `/mcp`
- Copilot: `/plugin`, `/skills`, `/theme`, `/terminal-setup`, `/user`, `/lsp`, `/list-dirs`, `/share`, `/delegate`, `/fleet`

扱い:

- 初期実装では非対応
- 必要なら個別 feature として app UI に置き換える
- text prompt として provider に送らない

## Routing Policy

### Parse Timing

- composer 送信前に、WithMate が先に slash command を解釈する
- slash command に一致した場合は通常 prompt として provider に送らない
- 非対応 command は `unknown slash command` として UI で返す

### Layer Responsibility

- Renderer
  - slash command parse
  - 引数整形
  - 補完 UI
- Main Process
  - app command 実行
  - session metadata 更新
  - 実行可否判定
- Provider Adapter
  - slash command 自体は解釈しない
  - metadata 更新結果を provider-native option へ変換する

## Initial Command Set

最初に WithMate が実装候補として持つ command は次を優先する。

- `/new`
- `/resume`
- `/model`
- `/plan`
- `/approval`
- `/diff`
- `/review`
- `/status`
- `/help`

条件付き:

- `/agent`
  - `provider = copilot` のときのみ

理由:

- 既存 UI の主要操作と整合する
- Codex / Copilot の双方に意味対応を持たせやすい
- CLI 依存の terminal 管理 command を避けられる

### Shipped Minimal Behavior

skill の最小実装では次を行う。

- Session composer 上部の `Skill` dropdown で picker を開く
- candidate は Main Process が provider root + workspace 標準 roots から列挙する
- picker で選んだ skill を provider ごとの snippet へ変換して composer 先頭へ挿入する
- textarea に `/skill` を入力しても、現時点では slash command としては解釈しない

## Alias Policy

- provider-native command 名は互換 alias として受けてよい
  - 例: `/permissions` -> `/approval`
  - 例: `/models` -> `/model`
- `/skills` は将来の `/skill` alias を入れる場合でも別物として扱う
- WithMate の canonical command は app 側で固定する
- docs / UI では canonical command を優先して表示する

## Recommendation

- slash command は provider SDK へ passthrough しない
- WithMate の command grammar と canonical command を先に定義する
- adapter は command 実行層ではなく metadata translation 層に留める
- skill picker の詳細は `docs/design/archive/2026/03/skill-command-design.md` を参照する
