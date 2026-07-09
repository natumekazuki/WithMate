# Decisions

## Summary

- approval 調査は公式資料を正本とし、Qiita / Zenn は補足情報として扱う

## Decision Log

### 0001

- 日時: 2026-03-22
- 論点: Codex SDK の approval 調査をどの根拠でまとめるか
- 判断: OpenAI 公式ドキュメントを主根拠とし、Qiita / Zenn などのユーザー記事は実運用上の補助根拠としてのみ使う
- 理由: approval 周りは安全性に直結し、二次情報だけで仕様判断すると実装を誤りやすいため
- 影響範囲: `docs/design/codex-approval-research.md`, `docs/design/provider-adapter.md`

### 0002

- 日時: 2026-03-22
- 論点: `Approval` と slash command 調査結果をどこへ残すか
- 判断: backlog は `docs/design/product-direction.md` と `docs/design/provider-adapter.md` に残し、詳細調査は `docs/design/codex-approval-research.md` として独立させる
- 理由: 候補タスク自体は product / adapter の将来判断に紐づく一方、approval 調査は後から参照したい設計メモとして独立性が高いため
- 影響範囲: `docs/design/product-direction.md`, `docs/design/provider-adapter.md`, `docs/design/codex-approval-research.md`

### 0003

- 日時: 2026-03-22
- 論点: WithMate で `approvalMode=on-request` をどう解釈するか
- 判断: ひとまず CLI `approval_policy` の thin wrapper とみなし、「毎回承認」とは扱わない
- 理由: SDK のローカル実装が `approvalPolicy` を CLI `--config approval_policy=...` に転送するだけであり、独自 gating を追加していないため
- 影響範囲: `docs/design/codex-approval-research.md`, `docs/design/provider-adapter.md`

### 0004

- 日時: 2026-03-22
- 論点: Codex と Copilot の approval UI をどう揃えるか
- 判断: provider native prompt を UI 基準にせず、WithMate 側の provider-neutral approval model を先に定義する
- 理由: Codex は `approval_policy` 中心、Copilot は tool allowlist / ask-user 中心で、SDK surface から見える承認 callback も揃っていないため
- 影響範囲: `docs/design/codex-approval-research.md`, `docs/design/provider-adapter.md`
