# Decisions

## Summary

- Skill picker は最小実装を先に入れ、skill 選択と prompt 挿入に責務を絞る

## Decision Log

### 0001

- 日時: 2026-03-22
- 論点: skill の最小実装をどこまでに絞るか
- 判断: provider root + workspace の skill 一覧化、picker、composer 挿入までに絞る
- 理由: skill 利用の価値検証を先に行いたく、skill 管理 UI や実行可否検証まで広げると初手が重くなるため
- 影響範囲: `docs/design/skill-command-design.md`, `docs/design/slash-command-integration.md`

### 0002

- 日時: 2026-03-22
- 論点: workspace 側で skill をどこから探索するか
- 判断: `skills`, `.github/skills`, `.copilot/skills`, `.codex/skills`, `.claude/skills` の標準 roots に限定する
- 理由: workspace 全体の recursive 探索は初回実装として重く、標準配置だけで価値検証には十分なため
- 影響範囲: `src-electron/skill-discovery.ts`, `docs/design/skill-command-design.md`

### 0003

- 日時: 2026-03-22
- 論点: skill 選択後の composer 挿入形式をどうするか
- 判断: Codex は `$skill-name`、Copilot は explicit skill directive を挿入する
- 理由: skill picker UI は共通化したい一方、provider ごとの explicit invocation 形式は一致しないため
- 影響範囲: `src/App.tsx`, `docs/design/skill-command-design.md`, `docs/design/provider-adapter.md`

### 0004

- 日時: 2026-03-22
- 論点: skill 選択 UI を slash command と dropdown のどちらに寄せるか
- 判断: 初回出荷は Session composer 上部の `Skill` dropdown のみとし、textarea 内の `/skill` parse は持たない
- 理由: skill 名を記憶させる UX が弱く、textarea 入力中の special handling は通常入力を阻害しやすいため
- 影響範囲: `src/App.tsx`, `src/settings-ui.ts`, `docs/design/skill-command-design.md`, `docs/design/slash-command-integration.md`, `docs/manual-test-checklist.md`
