# Decisions

## Decision 1

- status: confirmed
- decision: current task は repo plan として管理する
- rationale:
  - PR review follow-up で複数 slice を持ち、実装 / 検証 / レビューを複数段階で進める必要があるため
  - stale pending 表示、live-run → audit operations 共通化、success 後の `activeRunningSession` 整合修正を 1 task 内で追跡するため

## Decision 2

- status: confirmed
- decision: 3 finding は separate slices として進めるが、plan は 1 task として管理する
- rationale:
  - finding ごとに変更箇所と検証軸が異なるため、slice を分けた方が進行管理しやすいため
  - 同じ PR review follow-up に属するため、worklog / result / commit tracking は 1 task に集約するため

## Decision 3

- status: confirmed
- decision: owner コメント『送信プロンプトも確定時点で記録したい』は、現時点では追加 slice を切らず確認事項として扱う
- rationale:
  - 現在の実装では running audit row 作成時に logical prompt を保持しているため
  - 今回の fix scope は pending 表示、変換ロジック共通化、`activeRunningSession` 整合修正の 3 finding に限定するため

## Decision 4

- status: confirmed
- decision: docs-sync の初期判断は `docs/design/` / `.ai_context/` / `README.md` いずれも更新不要見込みとする
- rationale:
  - 対応内容が internal runtime / renderer fix と test / refactor に留まるため
  - 公開仕様やユーザー導線を変えないため
