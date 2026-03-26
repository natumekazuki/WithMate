# Decisions

- trigger は `outputTokens` を主条件にする
- threshold は provider ごとに 1 つ持つ
- `Codex` と `Copilot` のどちらも initial trigger は `outputTokens threshold` に揃える
- `compact 前` と `session close 前` は threshold に関係なく強制 trigger とする
- Settings では統計や mode 切替を持たず、数値入力だけにする
