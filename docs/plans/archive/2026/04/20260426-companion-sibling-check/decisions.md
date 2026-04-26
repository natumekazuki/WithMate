# Companion Sibling Check 実装 Decisions

## 2026-04-26

- 初期実装の sibling check は path overlap warning とする。
- sibling warning は merge result として Review Window へ返し、DB 永続化は後続実装に残す。
- overlap は selected files と sibling CompanionSession の changed files の path 一致で判定する。
