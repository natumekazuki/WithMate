# Decisions

## D-001 FTS5 はまだ使わない

- current slice では SQLite FTS5 を前提にしない
- 日本語対応の不確実性を避け、app-side の lexical scoring を強化する

## D-002 日本語向けに n-gram を使う

- query と memory entry の両方に対して word token だけでなく 2-gram / 3-gram を使う
- 日本語文でも substring 的な一致を拾いやすくする

## D-003 retrieval 利用時に `lastUsedAt` を更新する

- prompt へ注入した entry は「使った」とみなす
- decay はまだ入れないが、将来の ranking 用 metadata は先に蓄積する
