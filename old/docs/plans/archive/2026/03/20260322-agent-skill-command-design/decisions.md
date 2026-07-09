# Decisions

## Summary

- agent / skill は provider docs を主根拠に整理する

## Decision Log

### 0001

- 日時: 2026-03-22
- 論点: agent / skill command を何を根拠に共通化するか
- 判断: provider 公式 docs を主根拠とし、既存 WithMate design docs と照合して設計へ落とす
- 理由: slash command 名が同じでも provider により意味が異なる可能性があるため
- 影響範囲: `docs/design/skill-command-design.md`, `docs/design/slash-command-integration.md`

### 0002

- 日時: 2026-03-22
- 論点: `/agent` を共通 command にするか
- 判断: 共通化しない。`provider = copilot` のときだけ有効な provider-specific command とする
- 理由: Codex の `/agent` は subagent thread switch、Copilot の `/agent` は custom agent selector で意味が異なるため
- 影響範囲: `docs/design/skill-command-design.md`, `docs/design/slash-command-integration.md`

### 0003

- 日時: 2026-03-22
- 論点: `/skill` をどこまで共通化するか
- 判断: picker UI と skill metadata 表示は共通化し、選択後の injection は provider ごとに分ける
- 理由: skills 自体は両 provider で open standard 寄りだが、明示呼び出し方法は一致しないため
- 影響範囲: `docs/design/skill-command-design.md`, `docs/design/provider-adapter.md`
