# Character Storage Plan

## Goal
- WithMate 専用ディレクトリ配下でキャラクターデータを管理する方式を確定する。
- Character Editor / Home / Session から共通で参照できる character storage の仕様を定義する。
- 現在の in-memory mock を、ファイルベースの実ストレージへ置き換える実装手順を整理する。

## Task List
- [x] `docs/design/character-storage.md` を作成して、保存先・ディレクトリ構成・ファイル責務を定義する。
- [x] Main Process の character loader/save API の責務を設計に合わせて整理する。
- [x] `Home` / `Character Editor` / `Session` が参照する character catalog を file-based source of truth に切り替える。
- [x] Character Editor の保存・削除を、実ファイル更新へ接続する。
- [x] mock fallback と Electron 実装の責務境界を更新する。
- [x] 関連 docs を更新して、character management の現行仕様へ同期する。

## Affected Files
- `docs/design/character-storage.md`
- `docs/design/character-management-ui.md`
- `docs/design/electron-window-runtime.md`
- `docs/design/window-architecture.md`
- `docs/design/ui-react-mock.md`
- `docs/plans/20260312-character-storage.md`
- `src-electron/main.ts`
- `src-electron/preload.ts`
- `src/withmate-window.ts`
- `src/app-state.ts`
- `src/HomeApp.tsx`
- `src/CharacterEditorApp.tsx`
- `src/App.tsx`

## Risks
- 既存 mock データと新しい file-based storage の整合が崩れると、Home / Session の表示が空になる可能性がある。
- 保存先ディレクトリを早い段階で固定しないと、後から import/export や migration がやりづらくなる。
- `character.md` と `meta.json` の責務分離が曖昧だと、Editor と実行時 prompt 合成で二重管理が起きる。

## Design Check
- このタスクは character storage という新しい永続化仕様を追加するため、Design Doc の新規作成が必須。
- 実装前に `docs/design/character-storage.md` を作成し、そこを正本として扱う。

## Notes / Logs
- 2026-03-12: ユーザー要望により、character catalog は `~/.codex/characters` 直読みではなく、WithMate 専用ディレクトリ管理へ切り替える方針に変更。
- 2026-03-12: キャラクター定義はファイルとして管理し、UI 向けの軽量メタデータは別ファイルへ分離する方針を採用。
- 2026-03-12: Electron 実行時は `app.getPath("userData")/characters/` を正本として使用し、初回起動時はサンプル character を自動投入する実装へ更新。

