# Companion Read-only Review History 実装 Decisions

## 2026-04-26

- terminal CompanionSession の Review Window は read-only とし、merge / discard 操作はできない。
- cleanup 後の diff rows は復元せず、changed file summary を file list として表示する。
- Home 履歴カードは `companion_merge_runs` の latest run を優先して summary 表示する。
