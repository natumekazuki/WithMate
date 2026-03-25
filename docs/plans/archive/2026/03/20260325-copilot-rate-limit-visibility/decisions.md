# Decisions

## 2026-03-25

- `Premium Requests` は provider account 単位の shared state として扱う
- `Context Usage` は session 単位の state として扱う
- 第 1 slice の UI は Copilot 限定でよい
- Session Window で常時見せるのは `Premium Requests` の残量だけに絞る
- `Context Usage` は default collapsed の on-demand 表示にする
- telemetry は DB へ保存せず Main Process memory に置く
