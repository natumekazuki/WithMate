# Worklog

- 開始: Memory生成 OFF toggle を global setting として追加する
- `AppSettings` に `memoryGenerationEnabled` を追加し、storage / normalize / settings UI を更新
- `MemoryOrchestrationService` で OFF 時に Session Memory extraction / Character Reflection を早期 return するようにした
- `npm run build` と settings / memory orchestration test を実行
- 2026-03-29: `d9f8014` `feat(settings): add memory generation toggle`
  - Memory生成 OFF を global toggle として追加し、background plane の実行 gate に反映
