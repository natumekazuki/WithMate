# Worklog

## Timeline

### 0001

- 日時: 2026-03-22
- チェックポイント: Plan 作成
- 実施内容: Codex / Copilot CLI の slash command 調査と WithMate 実装方針整理の plan を作成した
- 検証: 未実施
- メモ: 次は公式 docs で command 一覧と SDK surface を確認する
- 関連コミット:

### 0002

- 日時: 2026-03-22
- チェックポイント: slash command 調査と docs 化
- 実施内容:
  - Codex CLI と Copilot CLI の official slash command 一覧を確認した
  - Codex SDK / Copilot SDK docs を確認し、slash command API が見えないことを整理した
  - `docs/design/slash-command-integration.md` を新規作成し、WithMate の command 分類と routing policy をまとめた
  - `docs/design/provider-adapter.md` に slash command routing 方針を追記した
- 検証:
  - OpenAI Developers `Slash commands in Codex CLI`, `Codex SDK`
  - GitHub Docs `CLI command reference`, `Using GitHub Copilot CLI`, `Getting started with Copilot SDK`
- メモ:
  - slash command は provider SDK へ passthrough しない前提が自然
  - app command / session setting command / out-of-scope の 3 分類で整理した
- 関連コミット:
  - `fbd880d` `docs(research): restore deleted approval and slash command docs`

## Open Items

- canonical command 名を `/approval` にするか `/permissions` alias を前面に出すか
- `/cwd` と workspace 切り替えを本当に同一 command として扱うか
