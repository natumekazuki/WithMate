# Plan

## Goal

- prompt composition を `system prompt` と `input prompt` に分けて扱えるようにする
- `System Prompt Prefix` を app 設定として保持し、固定指示の後ろ・キャラクターロールの前に差し込めるようにする
- Settings overlay から prefix を編集できるようにする

## Scope

- app settings storage 追加
- prompt composition の構造化
- audit log の表示と保存項目見直し
- Settings overlay の編集 UI 追加
- 関連 Design Doc / README / 実機テスト項目表の更新

## Task List

- [x] app settings storage と IPC を追加する
- [x] prompt composition を構造化する
- [x] audit log schema / UI を system/input 分離に合わせて更新する
- [x] Settings overlay に `System Prompt Prefix` 編集を追加する
- [x] docs 同期と検証を行う

## Affected Files

- `src/app-state.ts`
- `src/HomeApp.tsx`
- `src/App.tsx`
- `src/styles.css`
- `src/withmate-window.ts`
- `src-electron/main.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/audit-log-storage.ts`
- `src-electron/app-settings-storage.ts`
- `docs/design/prompt-composition.md`
- `docs/design/settings-ui.md`
- `docs/design/audit-log.md`
- `docs/design/provider-adapter.md`
- `docs/design/electron-session-store.md`
- `docs/design/session-persistence.md`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
- `README.md`

## Risks

- 既存の audit log schema からの移行が雑だと旧データを読めなくなる
- Settings 保存と prompt 実行の参照タイミングがずれると、設定反映が分かりにくくなる
- prompt を分解して見せても、実際に SDK へ渡す composed prompt との対応が崩れると監査用途で使いにくい

## Design Doc Check

- 状態: 更新済み
- 対象:
  - `docs/design/prompt-composition.md`
  - `docs/design/settings-ui.md`
  - `docs/design/audit-log.md`
  - `docs/design/provider-adapter.md`
  - `docs/design/electron-session-store.md`
  - `docs/design/session-persistence.md`
  - `docs/design/desktop-ui.md`
- メモ:
  - system prompt prefix は Settings overlay で管理する
  - audit log には system / input / composed を分けて残す
