# 目的

- `Character Editor` から character 保存ディレクトリをエクスプローラーで開けるようにする
- `character.md`、`character-notes.md`、`character.png`、instruction file、skill file を直接確認しやすくする

# スコープ

- `src/CharacterEditorApp.tsx` に `Open Folder` button を追加する
- 必要なら関連する IPC / preload 経路を追加する
- 必要なら `docs/design/character-management-ui.md` と `docs/design/desktop-ui.md` を current に合わせて更新する

# 非スコープ

- `Character Memory` の Editor 表示
- `UpdateSession` 一覧 UI
- `Character Update Session` の導線変更

# 進め方

1. `Character Editor` の action row に `Open Folder` button を追加する
2. button から character 保存ディレクトリを OS のエクスプローラーで開く
3. UI 文言と design doc を current に合わせる
4. `npm run build` で確認する

# 完了条件

- 既存 character の `Character Editor` から保存ディレクトリを開ける
- 既存の `Save`、`Reload`、`Open Update Workspace`、`Delete` の導線を壊さない
- `UpdateSession` 一覧は current task に混ぜず、別 task として扱う
