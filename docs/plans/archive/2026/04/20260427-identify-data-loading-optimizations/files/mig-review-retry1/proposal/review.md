# Review: mig-review-retry1

## Findings

1. High / same-plan: `--overwrite` の backup 作成と DB open が restore 用 `finally` の外にあり、partial backup / open failure で既存 V2 DB が復旧されない経路がある。
2. Medium / same-plan: write mode が `messages_json`、`stream_json`、`assistant_text`、`operations_json`、`raw_items_json` を全件 `.all()` しており、巨大 detail payload の list read が残っている。
3. Medium / same-plan: V2 detail JSON の検証が不足しており、`logical_prompt_json` / `transport_payload_json` は未検証、`usage_json` は配列も object として通る。

## 判定

ブロッキングあり。すべて現 plan 内で対応する。
