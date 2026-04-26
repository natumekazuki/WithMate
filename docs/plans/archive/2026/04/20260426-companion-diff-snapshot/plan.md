# Companion Diff Snapshot 永続化 Plan

- status: completed
- started: 2026-04-26

## 目的

CompanionSession の merge / discard 後も read-only Review Window で diff 本文を確認できるように、完了時点の diff snapshot を `companion_merge_runs` に保存する。

## スコープ

- `companion_merge_runs` に diff snapshot 用の JSON column を追加する。
- merge / discard 完了前に active Review と同等の `ChangedFile[]` を保存する。
- terminal read-only Review Window は latest merge run の diff snapshot を優先して表示する。
- storage / review service の対象テストと design doc を更新する。

## 対象外

- timeline item ごとの diff 切り替え UI。
- failed / blocked merge attempt の snapshot 保存。
- file contents そのものの永続化。
- snapshot サイズ上限や pruning policy。

## チェックポイント

1. [x] merge run に diff snapshot を保存・読込できる。
2. [x] merge / discard 完了時に diff snapshot を作る。
3. [x] terminal Review が diff snapshot を表示する。
4. [x] 対象テストと design doc を更新する。
5. [x] commit、result / worklog 更新、archive。
