# Companion Merge Readiness 実装 Plan

- status: completed
- started: 2026-04-26

## 目的

Review Window と merge 実行時に target branch drift、target worktree dirty、merge simulation の結果を確認し、安全でない merge を事前に止められるようにする。

## スコープ

- Review snapshot に merge readiness を追加する。
- target branch が base snapshot parent から進んでいる場合は blocker にする。
- target workspace が base snapshot commit から変わっている場合は blocker にする。
- selected files の merge simulation を追加し、target に触らず一時 index 上で反映可能性を確認する。
- Review Window に readiness / blockers / warnings を表示する。
- merge 実行時にも同じ readiness 判定を使って安全でない merge を止める。
- 対象テストと design doc を更新する。

## 対象外

- hunk 単位 merge。
- full merge conflict editor。
- sibling CompanionSession check。
- checks / CI integration。
- group-level lock の永続化。

## チェックポイント

1. [x] readiness 型と Review snapshot への追加。
2. [x] target branch drift / target workspace dirty 判定の追加。
3. [x] selected files merge simulation の追加。
4. [x] Review Window UI と merge 実行時 blocker の接続。
5. [x] design doc と検証を更新する。
6. [x] archive、commit。
