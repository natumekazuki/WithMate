# Mate アイコン path を renderer で表示可能な path に materialize する

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P1
- Type: Bug
- Related:
  - `src-electron/mate-storage.ts`
  - `src-electron/main.ts`
  - `src-electron/mate-profile-paths.ts`
  - `src/ui-utils.tsx`
  - `src/home/HomeRightPane.tsx`
  - `src/mate/MateSetupPanel.tsx`
  - `docs/error.log`

## Summary

Mate アイコン画像を選択すると、userData 配下の `mate/avatar.png` へコピーはされるが、renderer には相対 path のまま渡る。  
`CharacterAvatar` は絶対 path / `file://` / `data:` を前提に描画するため、相対 path の `mate/avatar.png` は `file:///mate/avatar.png` として解釈され、画像が表示されない。

## Current behavior

- `src-electron/mate-storage.ts` の `createMate()` / `setMateAvatar()` は avatar を userData 配下の `mate/avatar.png` に保存する
- 同メソッドと `getMateProfile()` は `avatarFilePath` に DB の相対 path (`mate/avatar.png`) を返す
- `src/mate/MateSetupPanel.tsx` と `src/home/HomeRightPane.tsx` はその値を `CharacterAvatar` へそのまま渡す
- `src/ui-utils.tsx` の `toAssetPath()` は相対 path を app の asset としては解決せず、結果として実ファイルに到達できない

## Problem

- Mate アイコンは保存済みでも UI に反映されない
- Home の Mate カード、Mate プロフィール編集画面、Mate から起動した session icon に波及する
- DB の正本は相対 path でも、renderer 向け projection が materialize されていない

## Expected behavior

- persistence 層は相対 path を保持してもよいが、renderer に返す `MateProfile.avatarFilePath` は表示可能な path へ解決される
- 画像選択直後の即時プレビューと再起動後の再表示の両方でアイコンが見える

## Proposed scope

1. renderer 向け `MateProfile` 返却時に avatar path を userData 基準の絶対 path へ materialize する
2. `createMate` / `updateMate` / `setMateAvatar` / `getMateProfile` の返却値を揃える
3. persistence 層の DB / file 保存形式は変えず、projection だけを直す
4. 回帰 test を追加する

## Acceptance criteria

- [ ] Mate アイコン選択直後にプレビューへ反映される
- [ ] Home の Your Mate 表示でもアイコンが見える
- [ ] renderer に返る `MateProfile.avatarFilePath` が表示可能な path になる
- [ ] DB の `mate_profile.avatar_file_path` は既存どおり相対 path を維持する

## Notes / open questions

- 恒久対応としては shared state 上で「relative persisted path」と「materialized runtime path」を分離した方が明確
- ただしローカル検証の暫定対応としては、main process で renderer 向け返却値だけ materialize するのが最小

