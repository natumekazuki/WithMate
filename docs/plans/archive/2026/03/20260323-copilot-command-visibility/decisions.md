# Decisions

## 2026-03-23

- `Latest Command` の目的は「今なにをしているか」が読めることであり、shell command だけに限定しない
- Copilot の provider-native tool は `command_execution` として UI に出しつつ、summary に tool 名と対象を残して区別する
- `rawItemsJson` の slimming は別 task として分離し、この plan では operation / live step の可視化だけを扱う
