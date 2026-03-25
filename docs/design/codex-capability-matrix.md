# Codex Capability Matrix

> 注記: cross-provider の正本一覧は `docs/design/coding-agent-capability-matrix.md` を参照する。  
> 本書は `Codex` 側の current snapshot を詳しく見るための補助 doc として扱う。

## Goal

- WithMate が current 実装で Codex 相手に何をできるかを 1 枚で確認できるようにする
- 「実装済み」「一部対応」「未対応」を分けて、次に潰す task を切りやすくする
- `docs/design/provider-adapter.md`、`docs/design/codex-approval-research.md`、実装コードの差を current snapshot として整理する

## Scope

- current milestone における Codex 対応機能
- Main Process の `CodexAdapter` と Renderer UI が提供している機能
- Codex CLI / SDK parity のうち、すでに WithMate に入っている部分と未着手部分

## Snapshot

- current runtime provider 実装: `CodexAdapter` と `CopilotAdapter`
- provider-neutral な session / approval / skill UI は一部先行している
- `GitHub Copilot CLI` は basic turn 実行の最小 runtime が入り、full parity はこれから

## Capability Inventory

### 1. Provider 実行基盤

- `対応済み`
- Main Process に provider 境界を置き、Renderer からは IPC 経由で session turn を実行できる
- current runtime は `CodexAdapter` と `CopilotAdapter` を shared contract で持つ
- provider ごとの coding credential は Settings から解決し、model catalog の provider selection と合わせて使う

主な実装:

- `src-electron/main.ts`
- `src-electron/codex-adapter.ts`
- `src/model-catalog.ts`

### 2. Session lifecycle

- `対応済み`
- Home から `workspace / provider / character / model / depth / approval mode` を持つ session を作成できる
- session ごとに `threadId` を保持し、次回 turn で `resumeThread()` できる
- `model / depth / coding credential` を変えた session は `threadId` を空に戻して新規 thread へ切り替える
- `run / cancel / interrupted / error / retry` の基本導線がある

主な実装:

- `src-electron/main.ts`
- `src-electron/session-storage.ts`
- `src/HomeApp.tsx`
- `src/App.tsx`

### 3. Prompt composition

- `対応済み`
- turn 実行時に次を合成して Codex へ渡す
  - `System Prompt Prefix`
  - character の `roleMarkdown`
  - user message
- text prompt 側は `# System Prompt` と `# User Input Prompt` を固定フォーマットで結合する
- 実行前の composed prompt は監査ログへ保存する

主な実装:

- `src-electron/codex-adapter.ts`
- `docs/design/prompt-composition.md`

### 4. Attachment / workspace context

- `対応済み`
- textarea 内の `@path` を実行直前に解決する
- workspace 外 `file / folder` は session metadata `allowedAdditionalDirectories` 配下だけを許可し、その許可リストを Codex SDK の `additionalDirectories` へ変換する
- `image` は `local_image` structured input として渡す
- picker で選んだ file / folder / image も、正本は textarea の `@path` に揃えている

主な実装:

- `src-electron/codex-adapter.ts`
- `src/App.tsx`
- `docs/design/provider-adapter.md`

### 5. Skill integration

- `対応済み`
- Settings で provider ごとの `skillRootPath` を保持できる
- workspace 標準 roots と provider root をマージして skill 候補を列挙する
- 同名 skill は workspace 側を優先して dedupe する
- Session composer の `Skill` picker から選んだ skill を Codex 向け `$skill-name` mention として prompt 先頭へ挿入できる

主な実装:

- `src-electron/skill-discovery.ts`
- `src-electron/main.ts`
- `src/HomeApp.tsx`
- `src/App.tsx`
- `docs/design/skill-command-design.md`

制約:

- `/skill` を textarea で解釈する slash command は current 実装で無効
- skill 実行可否の provider-native 検証までは持っていない

### 6. Approval / model / reasoning depth

- `一部対応`
- UI / session persistence の正本は provider-neutral な 3 mode
  - `allow-all`
  - `safety`
  - `provider-controlled`
- Codex 実行時には次へ map する
  - `allow-all -> never`
  - `safety -> untrusted`
  - `provider-controlled -> on-request`
- model / depth は catalog から選択し、実行前に provider catalog で検証する

主な実装:

- `src/approval-mode.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/main.ts`
- `docs/design/codex-approval-research.md`

未対応:

- app 側の approve / deny callback UI
- Codex granular approval policy の実装
- `provider-controlled` の実測 matrix 整備

### 7. Streaming / live run 可視化

- `対応済み`
- `runStreamed()` を使い、assistant text・live steps・usage・error を Session Window へ中継する
- message area には会話本文を、右 pane には `Latest Command` を表示する
- command は raw text を優先して 1 件だけ見せ、情報過多を避ける
- pending indicator、retry banner、scroll follow mode も入っている

主な実装:

- `src-electron/codex-adapter.ts`
- `src/App.tsx`
- `docs/design/agent-event-ui.md`
- `docs/design/session-window-layout-redesign.md`

制約:

- full command timeline を常設表示する UI は current 実装では持たない
- `Turn Inspector` 系の濃い詳細表示は後退させている

### 8. Audit log / artifact / diff

- `対応済み`
- turn ごとに `running / completed / canceled / failed` を audit log として保存する
- 次を記録できる
  - `system prompt`
  - `input prompt`
  - `composed prompt`
  - `operations`
  - `raw items`
  - `usage`
  - `partial result`
- assistant message ごとに artifact summary を持ち、`Changed Files` と diff viewer を開ける

主な実装:

- `src-electron/main.ts`
- `src-electron/audit-log-storage.ts`
- `src/App.tsx`
- `src/DiffApp.tsx`
- `src/DiffViewer.tsx`
- `docs/design/audit-log.md`

### 9. Slash command parity

- `未対応`
- current 実装では Codex CLI の slash command を SDK へ passthrough していない
- `/model` や `/permissions` の CLI 互換 parser も未実装
- current shipped behavior では、slash command 相当の操作は主に UI control へ置き換えている
  - model selector
  - approval selector
  - skill picker

関連 docs:

- `docs/design/slash-command-integration.md`

### 10. Codex CLI advanced parity

- `未対応`
- current 実装では次の領域はまだ吸収していない
  - `/agent`
  - `/apps`
  - `/mcp`
  - `/sandbox-add-read-dir`
  - `/permissions` native parity
  - Codex CLI の compact / clear / statusline 的な transcript control

理由:

- SDK 経由では CLI interactive layer と同じ surface が見えていない
- WithMate 側の canonical UI / metadata として切り直したほうが安全なため

## What Is Good Enough Already

現時点の Codex 対応として、次は「未実装だから使えない」ではなく「すでに日常利用に足る」と判断してよい範囲は次。

- session を作る
- workspace と character を切り替える
- prompt を送る
- file / folder / image を添付する
- skill を選ぶ
- model / depth / approval mode を切り替える
- 実行中 command を監視する
- cancel / retry する
- audit log と diff を見る

## Gaps To Track

### High Priority

- `GitHub Copilot CLI` を同じ Session UI で最低限動かす
- approval mode の実測 matrix を取り、`provider-controlled` の説明精度を上げる

### Medium Priority

- slash command を必要最小限だけ WithMate command として吸収する
- Copilot の `/agent` を session metadata に載せる

### Low Priority

- Codex CLI の高度な slash command parity
- Codex native approval / CLI hook 相当の深い吸収

## Suggested Next Slice

Codex capability 棚卸し後の次 task は、次の順で切るのが自然。

1. `GitHub Copilot minimal integration`
   - 同じ Session UI で `run / cancel / audit log` が通るところまで
2. `Approval behavior validation`
   - `allow-all / safety / provider-controlled` の Codex 実測
3. `Minimal slash command absorption`
   - 必要になった command だけ canonical UI alias として入れる

## Related Docs

- `docs/design/provider-adapter.md`
- `docs/design/codex-approval-research.md`
- `docs/design/slash-command-integration.md`
- `docs/design/skill-command-design.md`
- `docs/design/audit-log.md`
