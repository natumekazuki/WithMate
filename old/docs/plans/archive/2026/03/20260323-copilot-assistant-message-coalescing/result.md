# Result

## Status

- 状態: 完了

## Current Output

- Copilot の top-level `assistant.message` が複数回来ても、chat UI と audit `assistant_text` に到着順の全文が残るようになった
- `assistant.message_delta` で stream しつつ、同内容の final `assistant.message` が来ても二重化しない
- tool 配下の `assistant.message` は本文へ混ぜないまま維持した

## Remaining

- なし

## Related Commits

- `e772e69` `fix(copilot): normalize event handling`
