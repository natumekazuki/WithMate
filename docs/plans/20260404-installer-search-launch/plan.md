# Plan

- task: installer から検索起動しやすい設定を追加する
- date: 2026-04-04
- owner: Codex

## 目的

- Windows のスタートメニュー検索から WithMate を起動しやすくする
- 既存の `electron-builder` / NSIS 設定に不足している shortcut と AppUserModelID を補う

## スコープ

- `package.json`
- `src-electron/main.ts`
- `docs/design/distribution-packaging.md`

## 進め方

1. packaging 設定へ Start Menu shortcut 名を追加する
2. Main Process 起動時に `AppUserModelID` を設定する
3. packaging doc を current 設定に同期する
4. `npm run build` で退行を確認する

## チェックポイント

- [ ] Windows installer 設定に shortcut 名を追加する
- [ ] Main Process で `AppUserModelID` を設定する
- [ ] 配布 doc を同期する
- [ ] build を通す
