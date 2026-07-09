# Copilot Character Prompt Surface Survey Worklog

## 2026-03-24

- 調査 plan を作成した
- `src-electron/provider-prompt.ts` を確認し、現状は `systemPromptPrefix + character.roleMarkdown` を `composedPromptText` に直結していることを確認した
- `src-electron/copilot-adapter.ts` を確認し、Copilot 側は `session.send({ prompt: prompt.composedPromptText })` を送っており、`SessionConfig.systemMessage` は未使用であることを確認した
- install 済み `@github/copilot-sdk` の `SessionConfig.systemMessage` と `CustomAgentConfig.prompt` を確認した
- 調査結果として、Copilot では character prompt を main prompt から分離する第一候補は `SessionConfig.systemMessage`、第二候補は custom agent `prompt` と整理した
- コミット: `b892f01` `feat(runtime): 監査ログ構造化と DB 初期化を改善`
