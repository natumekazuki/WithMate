# Decisions

## Decision 1

- status: confirmed
- decision: current task は repo plan として管理する
- rationale:
  - review follow-up で実装 / 検証 / レビュー / コミット / archive を伴うため
  - 追加 review follow-up の進行、検証、rollback point を同一 task で追跡できるようにするため

## Decision 2

- status: confirmed
- decision: P1 / P2 は separate slices に分けず、同一 logical change としてまとめて扱う
- rationale:
  - 根本原因が「terminal 化で `runningAuditEntry` の live 監査情報を継承せず、薄い `result` / `partialResult` だけで再構築していること」で共通しているため
  - field priority 整理、terminal 化修正、回帰テストを一体で設計した方が review follow-up の整合が取りやすいため

## Decision 3

- status: confirmed
- decision: terminal row は `runningAuditEntry` を base にしつつ、meaningful な `result` / `partialResult` を優先して上書きする方針で進める
- rationale:
  - live progress 中に蓄積した assistantText / operations / usage / thread 情報を terminal row へ継承できるため
  - 最終結果として意味がある `result` / `partialResult` の値だけを優先すれば、terminal row の完全性と終端時点の正確性を両立しやすいため

## Decision 4

- status: confirmed
- decision: `approval_request` / `elicitation_request` は completed row でも historical trace として保持しうるため、completed row の `operations` は terminal payload を優先しつつ live-only trace を欠落させない merge 方針とする
- rationale:
  - 監査痕跡の欠落防止を優先するため
  - 現行 UI は operation details をパースせず verbatim 表示するため

## Decision 5

- status: confirmed
- decision: docs-sync の最終判断は `docs/design/` / `README.md` は更新不要、`.ai_context/` は repo 内に存在しないため追加更新不要とする
- rationale:
  - 対応は internal runtime fix と test 更新のみで、公開仕様変更を伴わないため
  - terminal audit row の完全性回復であり、ユーザー向け導線や設計文書の再説明を必要としないため
