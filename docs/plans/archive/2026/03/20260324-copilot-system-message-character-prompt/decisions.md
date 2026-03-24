# Copilot SystemMessage Character Prompt Decisions

## Decision 1

- 決定: Copilot の第一候補は `SessionConfig.systemMessage` `mode: "append"` を使う
- 理由:
  - SDK の guardrail を残したまま character prompt を main prompt から分離できる
  - `replace` より安全で、`customize` より初手の実装コストが低い

## Decision 2

- 決定: custom agent `prompt` は今回の character prompt 分離には使わない
- 理由:
  - 既存の custom agent selection と責務が競合する
  - character は session metadata 由来、custom agent は user selection 由来でレイヤーが異なる

## Decision 3

- 決定: Copilot だけ provider-specific prompt composition を許容する
- 理由:
  - 現在の共通 `composeProviderPrompt()` は Copilot / Codex で transport 前提が異なる
  - 共通化を維持するより、provider 実態に沿って分けたほうが audit と実装の説明が正確になる

## Decision 4

- 決定: audit では少なくとも `systemPromptText` に character 指示を残す
- 理由:
  - 実際の transport が分離されても、監査時に「どんな persona 指示だったか」を失うと調査性が下がる
