# Decisions

- `CharacterRuntimeService` は storage と session 同期の bridge に限定し、window registry の正本は `main.ts` に残す
- delete 時の editor close は callback 注入で service 内に閉じ込める
