# Decisions

## 2026-03-23

- Copilot の top-level `assistant.message` は 1 turn 内で複数回来る前提で扱う
- chat UI / audit `assistant_text` は、top-level assistant message を arrival 順に空行区切りで連結した canonical text とする
- `parentToolCallId` がある tool 配下メッセージは本文へ混ぜない
