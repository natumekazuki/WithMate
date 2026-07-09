# v3 以前から v4 への明示的 upgrade / import パスを定義する

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P2
- Type: Feature / Migration
- Related:
  - `scripts/migrate-database-v1-to-v2.ts`
  - `scripts/migrate-database-v2-to-v3.ts`
  - `docs/design/mate-storage-schema.md`
  - `docs/design/database-schema.md`

## Summary

v1 -> v2、v2 -> v3 の migration script はあるが、v4 への移行 path は見当たらない。  
一方で 4.0 系 schema は runtime に入り始めており、old data をどう持ち上げるかが未整理に見える。

## Current behavior

- `scripts/migrate-database-v1-to-v2.ts` と `scripts/migrate-database-v2-to-v3.ts` は存在する
- `docs/design/mate-storage-schema.md` は「4.0.0 は後方互換なし / 暗黙 migration なし」を前提にしている
- runtime 側では v4 schema を扱う storage がすでに存在する

## Problem

- user data continuity をどう扱うかが不明確
- 4.0 runtime へ上げる時に、既存 session / audit / memory / mate data をどこまで引き継ぐのか判断できない
- 暗黙 migration をしないなら、明示 import / reset / backup policy が必要

## Proposed scope

- v4 への supported path を 1 つ決める
  - one-shot import to `withmate-v4.db`
  - explicit migration script
  - fresh start + selective import
- backup / rollback / failure report の扱いを決める
- runtime と docs の両方で unsupported path を明示する

## Acceptance criteria

- [ ] v4 へ上げる supported path が 1 つ以上、文書と code の両方で定義される
- [ ] migration / import 前に backup 戦略が明示される
- [ ] 失敗時に中途半端な DB 状態を残さない
- [ ] fixture を使った migration / import test が用意される

## Notes / open questions

- 4.0 を「破壊的な新規開始」にするなら、その UX と messaging を app 内に出す必要がある
- session / audit / memory / mate のどこまでを移行対象にするかで実装量が大きく変わる


