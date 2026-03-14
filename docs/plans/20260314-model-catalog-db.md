# 20260314 Model Catalog DB

## Goal
- model catalog の正本を TS 定数から SQLite へ移し、初回起動時はアプリ同梱 JSON を seed する。
- catalog は provider-aware な JSON フォーマットで扱い、現時点では `codex` provider を同梱する。
- Session Window の model / depth UI は catalog 選択専用にして、自由入力を撤去する。

## Task List
- [x] `docs/design/model-catalog.md` を DB / revision / bundled JSON seed 前提に更新する。
- [x] `docs/design/session-persistence.md` と `docs/design/provider-adapter.md` に catalog revision と provider-aware 解決を反映する。
- [x] アプリ同梱の `public/model-catalog.json` を追加し、versionless JSON schema を定義する。
- [x] SQLite に model catalog revision / provider / model / alias を保存する実装を追加する。
- [x] 初回起動で catalog が空なら bundled JSON を import して active revision を作る。
- [x] Session 型と DB schema に `catalogRevision` と provider-aware model 選択前提を追加する。
- [x] Session Window の model UI を select ベースへ置き換え、自由入力を撤去する。
- [x] CodexAdapter の model/depth 解決を DB catalog ベースへ切り替える。
- [x] `typecheck` / `build` / `build:electron` で検証する。

## Affected Files
- `docs/design/model-catalog.md`
- `docs/design/session-persistence.md`
- `docs/design/provider-adapter.md`
- `docs/design/ui-react-mock.md`
- `docs/plans/20260314-model-catalog-db.md`
- `public/model-catalog.json`
- `src/model-catalog.ts`
- `src/mock-data.ts`
- `src/mock-ui.tsx`
- `src/App.tsx`
- `src/withmate-window.ts`
- `src-electron/model-catalog-storage.ts`
- `src-electron/preload.ts`
- `src-electron/main.ts`
- `src-electron/session-storage.ts`
- `src-electron/codex-adapter.ts`

## Risks
- 既存 session DB に対する schema migration をミスると、保存済み session が読み出せなくなる。
- catalog seed の解決に失敗すると Session Window の model UI が空になる。
- provider-aware 化で `provider` の既存値 (`Codex`) と新しい内部 id (`codex`) の互換を落とすと既存 session が壊れる。

## Design Check
- model catalog の正本と import/seed 方針が変わるため、`docs/design/model-catalog.md` の更新は必須。
- session metadata と provider adapter の依存項目が増えるため、関連 design doc も更新する。

## Notes / Logs
- 2026-03-14: versionless JSON は `public/model-catalog.json` に置き、Electron Main Process が初回 seed に使う形へ統一した。
- 2026-03-14: Session Window は catalog select 専用へ変更し、自由入力の model input は撤去した。
- 2026-03-14: import/export UI まではまだ出していないが、Main Process / preload に catalog import/export API は追加済み。