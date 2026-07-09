# Decisions

## D-001 Character Memory は関係性記憶に限定する

- 作業知識は `Project Memory` と `Session Memory` に残す
- `Character Memory` はユーザーとキャラの関係性、呼び方、好み、反応傾向、共有体験だけを扱う

## D-002 Character Memory と独り言は共通 trigger にする

- 生成タイミングは分けない
- `character reflection cycle` を 1 つ持ち、その出力として `memory delta` と `monologue` を分ける

## D-003 coding plane prompt には注入しない

- `Character Memory` は main の coding session prompt に戻さない
- 利用先は `独り言` と将来の `character definition update` に限定する

## D-004 trigger は SessionStart と文脈増加ベースに分ける

- `SessionStart` では monologue のみ生成する
- `Character Memory` 更新は通常の `character reflection cycle` に限定する
- v1 の通常 trigger は `charDelta >= 1200` または `messageDelta >= 6`、かつ `cooldown >= 5分`
- `session close` は trigger に使わない
