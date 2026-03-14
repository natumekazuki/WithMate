# Character Editor Finalization Plan

## Goal
- Character storage からサンプル自動投入を完全に外す。
- Character Editor を、WithMate 専用ディレクトリ上の character file を編集する実用レベルの UI として成立させる。
- Home から empty state / create / edit / delete の導線が自然につながる状態にする。

## Task List
- [x] `docs/design/character-storage.md` と `docs/design/character-management-ui.md` を更新し、サンプル非投入と final editor scope を明文化する。
- [x] Main Process の character storage から初回サンプル投入を削除し、empty storage をそのまま扱えるようにする。
- [x] Home に character empty state を追加し、キャラ未作成状態でも意味が分かるようにする。
- [x] Character Editor は `character.md` と icon だけを編集する最小構成に整理する。
- [x] Character Editor に画像 picker を追加し、手入力なしで icon を選べるようにする。
- [x] Character Editor の create / update / delete 後の挙動を整理し、保存後の再読込や空状態遷移を安定させる。
- [x] Session / New Session 側で character 0 件時の縮退挙動を整える。
- [x] `Tone` / `Stream` の個別項目を撤去し、キャラクター性は `character.md` に一本化する。
- [x] 関連 docs と plan を完了状態へ更新する。

## Affected Files
- `docs/design/character-storage.md`
- `docs/design/character-management-ui.md`
- `docs/design/ui-react-mock.md`
- `docs/plans/20260312-character-editor-finalization.md`
- `src-electron/character-storage.ts`
- `src-electron/main.ts`
- `src-electron/preload.ts`
- `src/withmate-window.ts`
- `src/HomeApp.tsx`
- `src/CharacterEditorApp.tsx`
- `src/app-state.ts`
- `src/styles.css`
- 必要なら `src/App.tsx`

## Risks
- character 0 件を許容すると、New Session の起動導線が未整備だと Home で詰まる。
- 画像 picker の API を足すと preload と Main の IPC 境界を広げる必要がある。
- `Role` 本文が長いと editor の縦方向密度が高くなるため、画像とメタ項目の配置バランスに注意が必要。

## Design Check
- このタスクは character storage / character editor の振る舞いを変更するため、`docs/design/character-storage.md` と `docs/design/character-management-ui.md` の更新が必須。

## Notes / Logs
- 2026-03-12: ユーザー要望により、サンプル character はすべて撤去し、最終的な character editing workflow まで実装する方針へ変更。
- 2026-03-12: 当初は `character-notes.md` も editor 範囲に含めていたが、system prompt として使わないため MVP では不要と判断し撤去した。
- 2026-03-12: browser fallback に残っていた旧サンプル session / character も legacy id を基準に除外するよう更新。
- 2026-03-12: `Tone` / `Stream` も `character.md` と責務が重複するため、MVP のキャラ正本から撤去した。

