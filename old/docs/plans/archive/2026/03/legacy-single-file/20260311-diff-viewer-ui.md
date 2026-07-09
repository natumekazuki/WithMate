# Diff Viewer UI 実装計画

- 作成日: 2026-03-11
- 対象: `Turn Summary` の折りたたみとアプリ内 Diff Viewer

## Goal

`Turn Summary` を常時展開せず、必要なときだけ読めるようにする。  
あわせて `Open Diff` ボタンから、別ウインドウではなくアプリ内のエディタ風オーバーレイで差分を確認できるようにする。

## Task List

- [x] `Turn Summary` 折りたたみと Diff Viewer の方針を設計ドキュメントへ反映する
- [x] React モックで `Turn Summary` の開閉 state を追加する
- [x] 変更ファイルごとのダミー diff データを追加する
- [x] `Open Diff` ボタンとエディタ風 Diff Viewer オーバーレイを追加する
- [x] 関連ドキュメントを更新する
- [x] `npm run typecheck` と `npm run build` を実行する

## Affected Files

- `docs/plans/20260311-diff-viewer-ui.md`
- `docs/design/agent-event-ui.md`
- `docs/design/ui-react-mock.md`
- `src/App.tsx`
- `src/styles.css`

## Design Check

以下を更新する。

- `Turn Summary` の既定状態を折りたたみにする方針
- `Open Diff` の導線位置
- Diff 表示を別ウインドウではなくアプリ内オーバーレイにする理由

## Risks

- 折りたたみ導線が弱いと、summary 自体の存在に気づかれにくい可能性がある
- Diff Viewer を作り込みすぎると、モック段階の範囲を超える可能性がある
- 実データ接続時には unified diff 生成元を別途決める必要がある

## Notes / Logs

- 2026-03-11: `Turn Summary` は毎ターン開いたままだと再び情報量が増えるため、折りたたみ前提へ変更する。
- 2026-03-11: `Open Diff` は別ウインドウではなく、同一ウインドウ内の editor-like overlay として実装する。
- 2026-03-11: `npm run typecheck` と `npm run build` を実行し、モック更新後も通過を確認した。
