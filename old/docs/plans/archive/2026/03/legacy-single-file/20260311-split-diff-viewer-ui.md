# Split Diff Viewer UI 実装計画

- 作成日: 2026-03-11
- 対象: GitHub Desktop 風の左右比較 Diff Viewer

## Goal

現在の unified diff 表示をやめて、`before / after` を左右に並べる split diff へ切り替える。  
コード確認時に、削除行と追加行の対応が視線移動だけで追えるビューアにする。

## Task List

- [x] split diff 方針を設計ドキュメントへ反映する
- [x] ダミー diff データを unified 文字列から左右比較用 row データへ変更する
- [x] Diff Viewer を左右比較レイアウトへ差し替える
- [x] editor-like overlay のスタイルを split diff 用に更新する
- [x] 関連ドキュメントを更新する
- [x] `npm run typecheck` と `npm run build` を実行する

## Affected Files

- `docs/plans/20260311-split-diff-viewer-ui.md`
- `docs/design/agent-event-ui.md`
- `docs/design/ui-react-mock.md`
- `src/App.tsx`
- `src/styles.css`

## Design Check

以下を更新する。

- diff 表示形式を unified ではなく split にする理由
- 行番号と左右カラムの見せ方
- モバイル幅での縮退方針

## Risks

- ダミー row データの作成量が増える
- 変更量が大きいファイルでは、横幅確保の設計が必要になる
- 実データ接続時に unified から split への変換ロジックが必要になる可能性がある

## Notes / Logs

- 2026-03-11: unified diff は読みづらいというフィードバックを受け、GitHub Desktop 風の split diff へ切り替える。
- 2026-03-11: `npm run typecheck` と `npm run build` を実行し、split diff 化後も通過を確認した。
