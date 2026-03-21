# Worklog

## Timeline

### 0001

- 日時: 2026-03-22
- チェックポイント: Plan 作成
- 実施内容: Codex SDK の approval 調査と backlog 反映をまとめて扱う plan を作成した
- 検証: 未実施
- メモ: 次は backlog を docs に残し、その後で approval 仕様を公式中心に集める
- 関連コミット:

### 0002

- 日時: 2026-03-22
- チェックポイント: backlog と調査メモの docs 化
- 実施内容:
  - `docs/design/product-direction.md` に backlog candidates を追記した
  - `docs/design/provider-adapter.md` に approval / slash command の open questions を追記した
  - `docs/design/codex-approval-research.md` を新規作成し、公式 docs とローカル SDK 実装、Qiita / Zenn の補助情報を整理した
- 検証:
  - OpenAI Developers の `Codex SDK`, `Agent approvals & security`, `Slash commands` を参照
  - ローカル `node_modules/@openai/codex-sdk` と `src-electron/codex-adapter.ts` を確認
- メモ:
  - 現時点では `approvalPolicy` は CLI `approval_policy` への thin wrapper とみなすのが妥当
  - slash command は SDK API というより app 側 command layer として扱う前提が安全
- 関連コミット:

### 0003

- 日時: 2026-03-22
- チェックポイント: Copilot SDK / CLI の approval 比較追記
- 実施内容:
  - GitHub Docs の Copilot SDK / Copilot CLI / Actions / hooks を確認した
  - `docs/design/codex-approval-research.md` に Copilot 側の approval モデルと Codex との差分を追記した
  - 2 provider で同じ UI を出すなら provider-neutral approval model が必要、という設計含意を追記した
- 検証:
  - GitHub Docs `Getting started with Copilot SDK`
  - GitHub Docs `About Copilot CLI`
  - GitHub Docs `Automating tasks with Copilot CLI and GitHub Actions`
  - GitHub Docs `Using hooks with Copilot CLI for predictable, policy-compliant execution`
- メモ:
  - Copilot 側も SDK callback より CLI allowlist / hook を基準に考えるほうが自然
  - native prompt 依存で 2 provider の UI を揃えるのは難しい
- 関連コミット:

## Open Items

- `Approval` 実測 matrix を別 task として回すか
- slash command を app command として切る場合の UI / adapter 分担
