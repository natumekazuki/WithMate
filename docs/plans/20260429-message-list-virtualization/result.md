# Result

## Status

- status: completed
- outcome: 実装完了

## Summary

`SessionMessageColumn` の message-list 全件描画を、既存 `src/virtual-list.ts` の `calculateVirtualListWindow` を使う windowed rendering へ置き換えた。

元配列 index に基づく `artifactKey` を維持しつつ、描画対象 message は virtual window 範囲に限定する。pending row、live approval、live elicitation、未読 follow banner は windowed message の外に維持し、既存の追従・未読表示との連携を保った。

レビュー指摘を受けて、viewport 高さ変更時の `ResizeObserver` 再計測、artifact 内 fold の controlled state、artifact / pending / live の static render coverage を追加した。

## Validation

- `npx tsx --test scripts/tests/session-message-column.test.ts`
  - Red phase では 100 件全件描画のため期待どおり失敗。
- `npx tsx --test scripts/tests/session-message-column.test.ts scripts/tests/virtual-list.test.ts scripts/tests/message-rich-text.test.ts`
  - Green phase とレビュー修正後に成功。
- `npm run build:renderer`
  - 成功。
- `npm run build:electron`
  - 成功。
- `git diff --check`
  - 成功。
- `npm test`
  - 成功。494 tests / 71 suites pass。

## Manual Validation Checklist

- 大量履歴で初期表示が破綻しない: static render test で大量 message の windowing を確認。
- 末尾追従中に新着が来ると末尾へ移動する: 既存 `messageListRef` と scroll signature の連携を維持。
- 手動スクロールで追従解除され、新着時に未読バナーが表示される: `message-follow-banner` の static render を確認。
- `末尾へ移動` で末尾へ復帰し、未読状態が解除される: 既存 callback と表示構造を維持。
- artifact 展開と折りたたみが windowing 後も維持される: artifact static render と controlled fold state を追加。
- diff open が対象 artifact に対して動作する: 元配列 index に基づく `artifactKey` を維持。
- pending approval、pending elicitation、live approval、live elicitation が表示される: static render test で確認。
- Markdown 内リスト表示が message-list 用 CSS の影響を受けない: message column 専用 class へ分離し、`message-rich-text` test を通過。

## Follow-up

- `Message` 安定 id と `artifactKey` 安定化。
- 可変高実測 virtualizer。
- DOM client test harness。
- 大量履歴 fixture を使ったスクロール追従 E2E。

## Archive Readiness

- archive destination: `docs/plans/archive/2026/04/20260429-message-list-virtualization/`
- close 条件:
  - 実装結果と検証結果をこのファイルへ記録する。
  - `worklog.md` にコミット対応を記録する。
  - `questions.md` が `質問なし` または `確認済み` である。
