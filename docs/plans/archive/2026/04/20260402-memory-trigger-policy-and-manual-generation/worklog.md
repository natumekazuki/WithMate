# Worklog

## 2026-04-02

- plan 作成
- `SessionStart` 独り言の trigger 判定を見直し、前回 reflection 以降に会話増分が無い reopen では skip する実装へ変更
- `Session Window` close 時の自動 `Session Memory extraction` hook を撤去
- main / preload / renderer に手動 `Generate Memory` 導線を追加
- docs/design と checklist / backlog を同期
- コミット: `83f819c` `feat(memory): revise session trigger policy`
- コミット: `0971dba` `docs(plan): archive memory trigger policy and manual generation`
- 検証:
  - `node --import tsx scripts/tests/character-reflection.test.ts`
  - `node --import tsx scripts/tests/session-window-bridge.test.ts`
  - `node --import tsx scripts/tests/main-session-command-facade.test.ts`
  - `node --import tsx scripts/tests/main-ipc-registration.test.ts`
  - `node --import tsx scripts/tests/preload-api.test.ts`
  - `node --import tsx scripts/tests/main-ipc-deps.test.ts`
  - `node --import tsx scripts/tests/session-memory-extraction.test.ts`
  - `node --import tsx scripts/tests/memory-orchestration-service.test.ts`
  - `npm run build`
