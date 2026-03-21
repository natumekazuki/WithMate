# Worklog

## Timeline

### 0001

- 日時: 2026-03-22
- チェックポイント: Plan 作成
- 実施内容: agent / skill command の共通化方針を整理する plan を作成した
- 検証: 未実施
- メモ: 次は provider docs で agent / skills の性質を確認する
- 関連コミット:

### 0002

- 日時: 2026-03-22
- チェックポイント: agent / skill command 設計の docs 化
- 実施内容:
  - Codex の `/agent` と skills docs、Copilot の `/agent` / skills docs を確認した
  - `docs/design/skill-command-design.md` を新規作成した
  - `/agent` は provider 専用、`/skill` は共通 picker + provider 別 injection とする方針を整理した
  - `docs/design/slash-command-integration.md` と `docs/design/provider-adapter.md` に反映した
- 検証:
  - OpenAI Developers `Slash commands in Codex CLI`, `Agent Skills`
  - GitHub Docs `Invoking custom agents`, `CLI command reference`, `About agent skills`
- メモ:
  - Codex の `/agent` は thread switch で、Copilot の custom agent selector と同一視しない
  - skill は両 provider で open standard 寄りなので picker 共通化がしやすい
- 関連コミット:

## Open Items

- Copilot 側で explicit skill directive の文面をどこまで定型化するか
- skill picker の metadata source をどう統合するか
