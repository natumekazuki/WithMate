# Decisions

## Status

- 進行中

## Entries

- 2026-04-01: 初期作成。未決事項は default を `300_000` にするか、それより保守的な値にするか。
- 2026-04-01: issue `#27` の文面に合わせ、default `outputTokensThreshold` は `300_000` を採用することにした。
- 2026-04-01: default より低い `100_000` clamp は不整合なので、normalize 上限は `1_000_000` へ拡張することにした。
