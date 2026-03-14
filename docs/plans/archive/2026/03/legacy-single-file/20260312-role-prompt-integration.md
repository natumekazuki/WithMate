# Role Prompt Integration Plan

## Goal
- `Description` は Home 一覧用メタとして維持する。
- `Role` を `character.md` の正本として扱い、Codex 実行時に system prompt 合成の入力へ使う方針を固定する。
- Character Editor から markdown 編集面を切り出し、長文の `Role` を編集しやすくする。

## Task List
- [x] `Role` と system prompt 合成の責務を design doc に明文化する。
- [x] Character storage / character management docs を更新し、`Description` と `Role` の役割を整理する。
- [x] Character Editor を `metadata form` と `markdown editor` に分割する UI 案を React モックへ反映する。
- [x] `Role` を保存するフィールド名を見直し、必要なら `promptNotes` から意味の通る名前へ変更する。
- [x] Codex 実行時に `character.md` を prompt 合成へ流す adapter 境界を設計に追加する。
- [x] 関連 docs と plan を更新し、型チェックとビルドを通す。

## Affected Files
- `docs/plans/20260312-role-prompt-integration.md`
- `docs/design/character-storage.md`
- `docs/design/character-management-ui.md`
- `docs/design/product-direction.md`
- `docs/design/ui-react-mock.md`
- `docs/design/` 配下の prompt composition 関連 doc（新規想定: `prompt-composition.md`）
- `src/CharacterEditorApp.tsx`
- `src/app-state.ts`
- `src-electron/character-storage.ts`
- `src/styles.css`
- 必要なら `src/App.tsx` と adapter 関連ファイル

## Risks
- `Role` をそのまま system prompt と呼ぶと、将来の固定システム指示との責務分離が曖昧になる。
- フィールド名変更は Home / Session / storage / IPC に広く波及する。
- markdown editor を重く作りすぎると、今の最小 UI 方針から外れる。

## Design Check
- このタスクは prompt composition と editor 構造の変更を含むため、design doc 更新が必須。
- 新規または更新対象:
  - `docs/design/prompt-composition.md`
  - `docs/design/character-management-ui.md`
  - `docs/design/character-storage.md`

## Notes / Logs
- 2026-03-12: ユーザー要望として `Description` は維持する。
- 2026-03-12: `Role` は Codex に投げるキャラクター定義の正本に寄せたい。
- 2026-03-12: 長文編集しやすさのため、Character Editor から markdown editor の切り出しを検討する。
- 2026-03-13: `promptNotes` は意味が曖昧なため `roleMarkdown` に改名し、`character.md` の本文と一致させた。

