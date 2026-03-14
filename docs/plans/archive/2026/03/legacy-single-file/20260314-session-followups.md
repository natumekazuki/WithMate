# Goal
`interrupted` セッションを再開しやすくし、Home で実行中/中断中セッションを追いやすくする。あわせて、新規作成ファイルの Diff で内容を閲覧できるようにする。

# Task List
- [x] `interrupted` セッション用の再送 UI を `Session Window` に追加する
- [x] `Home` に実行中/中断中セッションの視認性を上げる表示を追加する
- [x] `CodexAdapter` で新規作成ファイルの diff rows を生成して `Open Diff` で中身を見られるようにする
- [x] 関連 design docs を current 実装へ更新する
- [x] `npm run typecheck` / `npm run build` / `npm run build:electron` を通す

# Affected Files
- `src/App.tsx`
- `src/HomeApp.tsx`
- `src/ui-utils.tsx`
- `src/styles.css`
- `src-electron/codex-adapter.ts`
- `docs/design/session-run-lifecycle.md`
- `docs/design/recent-sessions-ui.md`
- `docs/design/provider-adapter.md`
- `docs/design/ui-react-mock.md`
- `docs/plans/20260314-session-followups.md`

# Risks
- `interrupted` 判定と通常 `idle` 判定が混ざると、再送導線の表示条件が曖昧になる
- 新規作成ファイルの内容取得は workspace 上の最新ファイルを読むため、将来 streaming diff に切り替えると実装を見直す必要がある
- Home の情報を増やしすぎると、最小 UI 方針を崩す可能性がある

# Design Check
- `docs/design/session-run-lifecycle.md` の更新が必要
- `docs/design/recent-sessions-ui.md` の更新が必要
- `docs/design/provider-adapter.md` の更新が必要
- `docs/design/ui-react-mock.md` の更新が必要

# Notes / Logs
- `Session Window` では `runState = interrupted` のときだけ、composer 上に `同じ依頼を再送` ボタンを出す。
- `Home` では `running` と `interrupted` を通常一覧とは別の chip row に分け、再オープン優先の導線にした。
- Diff は `file_change` から直接本文が取れないため、MVP では `add` のときだけ workspace 上の最新ファイル本文を読んで split diff rows を生成する。
- 2026-03-14: `npm run typecheck` / `npm run build` / `npm run build:electron` を実行し、通過を確認した。

