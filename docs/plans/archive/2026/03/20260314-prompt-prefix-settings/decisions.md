# Decisions

## Summary

- `System Prompt Prefix` は app 設定として SQLite に保存する
- audit log には `systemPrompt / inputPrompt / composedPrompt` を分けて残す
- Settings overlay で prefix を編集し、次の turn から反映する

## Decision Log

### 0001

- 日時: 2026-03-14
- 論点: prefix を character 側へ持つか app 設定へ持つか
- 判断: app 設定へ持つ
- 理由: キャラ定義と独立した実行制御指示として扱いたいため
- 影響範囲:
  - `src-electron/app-settings-storage.ts`
  - `src/HomeApp.tsx`
  - `src-electron/codex-adapter.ts`

### 0002

- 日時: 2026-03-14
- 論点: audit log の prompt 表示をどう分けるか
- 判断: `system / input / composed` の 3 区分で保存し、UI でも同じ区分で見せる
- 理由: 実行時に SDK へ 1 本で渡していても、監査上は役割ごとに読める方が分かりやすいため
- 影響範囲:
  - `src-electron/audit-log-storage.ts`
  - `src/App.tsx`
  - `docs/design/audit-log.md`