# Workspace snapshot index incremental refresh plan

- 作成日: 2026-04-24
- Plan tier: repo plan
- 対象: `docs/optimization-roadmap.md` の `Workspace snapshot / diff pipeline`

## 目的

`command_execution` が頻繁に発生する turn でも、after snapshot が毎回 workspace 全走査へ戻らないようにする。snapshot capture を `全走査で本文を読む処理` から、cache 済み workspace index を incremental refresh する処理へ段階的に移す。

## Scope

- `src-electron/snapshot-ignore.ts`
  - snapshot index 型と作成 API を追加する。
  - directory mtime / ignore file 状態が変わっていない場合、既存 snapshot を再利用して候補ファイルだけ refresh する API を追加する。
  - ignore file 変更・directory 構造変化・不確定状態では full rebuild へ fallback する。
- `src-electron/codex-adapter.ts`
  - session workspace ごとの snapshot index cache を持つ。
  - turn 開始時は index snapshot を before として使う。
  - turn 終了時は explicit file change と command / MCP の有無に応じて incremental refresh する。
- `scripts/tests/codex-adapter.test.ts`
  - snapshot index refresh の単体テストを追加する。
- `docs/design/provider-adapter.md`
  - artifact snapshot / diff の現行仕様を更新する。

## Out of Scope

- fs watcher 導入
- Git native diff への置換
- CopilotAdapter の artifact 生成経路変更
- renderer UI 変更

## Checkpoints

- [x] snapshot index の public 型と API を追加する
- [x] ignore / directory validation による full fallback 条件を実装する
- [x] CodexAdapter が before / after を index cache 経由で扱う
- [x] targeted capture の既存挙動を index API に統合する
- [x] docs-sync を実施する
- [x] Electron typecheck / build を通す
