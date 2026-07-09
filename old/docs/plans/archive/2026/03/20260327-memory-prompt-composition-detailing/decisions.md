# Decisions

## 2026-03-27

- coding plane の prompt は `System Prompt Prefix -> character.md -> Session Memory -> Project Memory -> User Input` の論理順序で扱う
- `Session Memory` は固定 section summary として毎 turn 注入する
- `Project Memory` は on-demand retrieval の結果を最大 3 件まで section として挿入する
- `Character Memory` は coding plane prompt に含めない
