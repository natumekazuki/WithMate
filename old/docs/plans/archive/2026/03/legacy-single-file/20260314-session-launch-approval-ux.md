# Session Launch And Approval UX Plan

## Goal
- `New Session` の workspace 選択をフォルダーピッカー中心の導線へ整理する。
- approval mode を日本語ラベルへ置き換える。
- `Session Window` 内で approval mode を変更できるようにする。
- 将来対応として、設定で指定した root 配下に UUID ディレクトリを作って空 workspace から session を始める案を docs に残す。

## Task List
- [x] `docs/design/session-launch-ui.md` を更新し、workspace picker only 方針と将来の empty workspace 作成案を追記する。
- [x] `docs/design/window-architecture.md` または関連 docs に、session 内 approval 変更 UI の責務を追記する。
- [x] `Home Window` の `New Session` dialog から workspace preset 一覧を削除し、Browse + 選択済み path 表示のみに整理する。
- [x] approval mode の表示文言を日本語へ置き換える。
- [x] `Session Window` に approval mode 変更 UI を追加し、session metadata 更新へ接続する。
- [x] `typecheck` と `build` を通す。

## Affected Files
- `docs/plans/20260314-session-launch-approval-ux.md`
- `docs/design/session-launch-ui.md`
- `docs/design/window-architecture.md`
- 必要に応じて `docs/design/product-direction.md`
- `src/HomeApp.tsx`
- `src/App.tsx`
- `src/ui-utils.tsx` または approval 表示ユーティリティを置くファイル
- 必要に応じて `src/app-state.ts`

## Risks
- `Session Window` に approval 変更 UI を足すと、最小 UI 方針とぶつかる可能性がある。
- workspace picker only にすると、browser preview での挙動が分かりにくくなる。
- 将来の empty workspace 作成案を今の実装へ混ぜると、責務が広がりやすい。

## Design Check
- このタスクは新しい UI 操作と session 設定変更を追加するため design doc 更新が必須。
- 更新対象:
  - `docs/design/session-launch-ui.md`
  - `docs/design/window-architecture.md`

## Notes / Logs

- `New Session` の workspace 候補 UI は撤去し、Electron 実行時は OS directory picker、browser preview では簡易 path 入力を使う形にした。
- approval mode は日本語ラベルへ置き換え、`Session Window` の header から変更できるようにした。

