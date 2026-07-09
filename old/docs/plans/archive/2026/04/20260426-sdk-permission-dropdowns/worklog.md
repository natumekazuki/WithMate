# Worklog

## 2026-04-26

- repo plan を作成した。
- 既存の Session Composer、session state、SQLite session storage、CodexAdapter / CopilotAdapter の approval 周辺を確認した。
- `approvalMode` の正本を SDK policy 値へ寄せ、legacy 値は read-path normalize で吸収する方針にした。
- Codex sandbox mode の型、provider-specific runtime option helper、SQLite カラム、Codex ThreadOptions 反映を追加した。
- Session Composer の Approval を dropdown 化し、Codex provider のときだけ Sandbox dropdown を表示するようにした。
- Reasoning depth の UI label を SDK 値そのままにした。
- `docs/design/` と `README.md` を更新した。
- 検証:
  - `npx tsc -p tsconfig.electron.json --noEmit --pretty false`: 成功。
  - `npx tsc --noEmit --pretty false`: 既存の `src/session-components.tsx` 型エラーなどで失敗。
  - `node --import tsx --test scripts/tests/codex-adapter.test.ts scripts/tests/session-state.test.ts scripts/tests/home-settings-view-model.test.ts`: sandbox の `spawn EPERM` で起動前に失敗。
