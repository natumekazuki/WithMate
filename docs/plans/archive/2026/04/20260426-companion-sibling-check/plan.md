# Companion Sibling Check 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

selected CompanionSession の merge 後に、同じ CompanionGroup の active sibling CompanionSession へ影響する path overlap を warning として user に返す。

## スコープ

- merge result に sibling warnings を追加する。
- 同じ group の active sibling CompanionSession を列挙し、selected files と sibling の changed files の overlap を検出する。
- Review Window に merge 後の sibling warnings を表示する。
- 対象テストと design doc を更新する。

## 対象外

- sibling warning の DB 永続化。
- sibling CompanionSession の自動 rebase / 自動修正。
- hunk 単位 conflict 判定。
- temporary sibling check ref の実体化。

## チェックポイント

1. [x] sibling warning 型と merge result 型を追加する。
2. [x] merge 後 sibling path overlap check を追加する。
3. [x] Review Window に sibling warnings を表示する。
4. [x] 対象テストと design doc を更新する。
5. [x] archive、commit。
