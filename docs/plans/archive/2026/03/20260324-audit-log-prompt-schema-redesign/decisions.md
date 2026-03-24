# Audit Log Prompt Schema Redesign Decisions

## Decision 1

- 決定: prompt 監査は `logical prompt` と `transport payload` の 2 層に分ける
- 理由:
  - 人間が読みたい論理指示と、provider 実装が実際に受けた payload は責務が違う
  - Copilot `systemMessage` 化後も無理なく表現できる

## Decision 2

- 決定: provider ごとの専用列は増やさず、汎用 JSON 列にする
- 理由:
  - Copilot / Codex 以外が増えても schema を増殖させない
  - UI も `summary + labeled fields` の共通表示に寄せられる

## Decision 3

- 決定: 旧 `system_prompt_text / input_prompt_text / composed_prompt_text` は write path の正本から外す
- 理由:
  - 今回は後方互換より現仕様の一貫性を優先する
  - 旧列へ意味を残すと、新旧の真実源が二重化する
