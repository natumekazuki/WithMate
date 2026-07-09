# Plan

## Goal

- `#24 モデル切り替えバグ` が current 実装で close 候補かを確認できる状態にする
- model / reasoning 変更後の continuity と stale session recovery が連結して機能する根拠を残す

## Scope

- `scripts/tests/copilot-adapter.test.ts` の統合回帰テスト追加
- `docs/task-backlog.md` の `#24` 状態更新
- GitHub issue `#24` への確認コメント

## Out Of Scope

- provider 実機での追加実装
- GitHub issue の close 操作

## Task List

- [x] session plan を作成する
- [x] `#24` の残確認観点を整理する
- [x] 統合回帰テストを追加する
- [x] backlog 状態を更新する
- [x] issue コメントを残す
- [x] 必要な検証を実行する

## Affected Files

- `scripts/tests/copilot-adapter.test.ts`
- `docs/task-backlog.md`

## Validation

- `node --import tsx scripts/tests/copilot-adapter.test.ts`: 成功

## Notes

- GitHub issue `#24` へ 2026-04-01 に確認コメントを追加した
- session plan なので archive は行わない
