# Decisions

## Summary

- 実機テスト項目表は `docs/manual-test-checklist.md` を正本にする
- 最新化方針は専用 Design Doc と ADR に明記し、README と主要 Design Doc から参照する
- チェックリストは現行実装のみを対象とし、pending 機能は含めない

## Decision Log

### 0001

- 日時: 2026-03-14
- 論点: 実機テスト項目表の配置先をどこに置くか
- 判断: `docs/manual-test-checklist.md` を新規作成し、人間向けの実行入口にする
- 理由: README から辿りやすく、Design Doc と役割を分けたまま運用できる
- 影響範囲:
  - `README.md`
  - `docs/manual-test-checklist.md`

### 0002

- 日時: 2026-03-14
- 論点: 最新化方針をどこに明記するか
- 判断: 専用 Design Doc と ADR を追加し、既存の `desktop-ui.md` と `window-architecture.md` から参照する
- 理由: 現行仕様と意思決定履歴を分けて保持しつつ、実装変更時の更新責務を明確にできる
- 影響範囲:
  - `docs/design/manual-test-checklist.md`
  - `docs/adr/001-manual-test-checklist-policy.md`
  - `docs/design/desktop-ui.md`
  - `docs/design/window-architecture.md`
