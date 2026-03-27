# Decisions

## D-001 retrieval は keyword match から始める

- current slice では vector / FTS は使わない
- `userMessage` と `Session Memory.goal / openQuestions` から query token を作り、`title / detail / keywords` との lexical match で score を作る

## D-002 Session Memory は常設する

- `Session Memory` は retrieval せず、毎 turn prompt に入れる
- 空の field は section 内で省略する

## D-003 Project Memory は最大 3 件まで注入する

- retrieval hit がある時だけ `# Project Memory` section を出す
- category label は prompt に残す
