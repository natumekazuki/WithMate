# 20260328 Main IPC Deps Domain Split Decisions

## 初期判断

- domain grouping は `window / catalog / settings / sessionQuery / sessionRuntime / character`
- `registerMainIpcHandlers()` の deps 形は当面維持し、builder 側で grouped input を吸収する
