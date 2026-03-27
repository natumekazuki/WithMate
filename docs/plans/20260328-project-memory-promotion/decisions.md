# Decisions

## D-001 昇格判定は rule-based で始める

- LLM による project memory 昇格判定はまだ入れない
- current slice では `Session Memory` の field と文の形から機械的に昇格対象を決める

## D-002 昇格対象は `decisions / notes / openQuestions` に限定する

- `goal` は session 固有の目的なので昇格しない
- `nextActions` は session 継続用 TODO なので昇格しない
- `decisions` は `decision`
- `notes` は `context`
- `openQuestions` は `deferred`

## D-003 exact match 再利用を優先する

- current 実装では既存の exact match reuse だけを使う
- 近似重複統合は follow-up とする
