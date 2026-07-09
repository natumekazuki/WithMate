# Questions

## Status

質問なし

## Round 1

### Q1

- question: なし
- answer: root 暫定判断により、今回の実装方針は確定済み。

## Confirmed Assumptions

- DB/schema や `Message` id 追加には踏み込まない。
- `artifactKey` は現行 `${sessionId}-${index}` を維持し、append-only 前提で扱う。
- 行高は固定推定高で先行し、可変高実測は follow-up とする。
- DOM client test harness 導入は follow-up とする。
- `renderToStaticMarkup`、pure function test、build/test、手動確認項目で担保する。
