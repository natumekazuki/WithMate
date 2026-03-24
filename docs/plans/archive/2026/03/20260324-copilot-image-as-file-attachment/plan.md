# Plan

## 背景

- `Copilot` の file / folder context は `attachments` で実装済み
- ただし現在は `kind: "image"` を `CopilotAdapter` が reject している
- renderer 側では `Copilot` 選択時に `Image` ボタンを disabled にする差分が未コミットで残っている

## 目的

- `Image` ボタンは共通 UI のまま残し、Copilot では画像を `file attachment` として送る
- provider 差分は adapter 側に閉じる

## スコープ

- `CopilotAdapter` の image 取り扱い変更
- `scripts/tests/copilot-adapter.test.ts` 更新
- `docs/design/` と `docs/manual-test-checklist.md` の同期

## スコープ外

- Codex 側 image 処理変更
- 新規 UI 文言追加
- commit / archive

## タスク

1. `CopilotAdapter` で image を `file attachment` へ変換する
2. `Image` ボタンの Copilot 専用 disabled を外す
3. テストと docs を更新する
4. build / test で回帰確認する
