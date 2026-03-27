# Decisions

## D-001 schema は変えず prompt だけ調整する

- current 実装で `SessionMemoryDelta` schema は既に接続済み
- 今回は field を増やさず、instruction quality を上げる

## D-002 差分更新を最優先にする

- 既に current memory にある内容を繰り返させない
- 未変更 field は省略を維持する

## D-003 notes は fallback であり durable note だけ tag を付ける

- `notes` は何でも入れる箱にしない
- Project Memory 候補だけ `constraint:` / `convention:` / `context:` / `deferred:` を付ける方針を維持する
