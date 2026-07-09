# 保存構造の current docs と regression test を runtime に揃える

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P1
- Type: Maintenance / Docs/Test
- Related:
  - `docs/design/database-schema.md`
  - `docs/design/mate-storage-schema.md`
  - `scripts/tests/app-database-path.test.ts`
  - `scripts/tests/persistent-store-lifecycle-service.test.ts`

## Summary

DB versioning の current doc と runtime の実態がずれて見える。  
bootstrap と migration 方針を決めた後、docs と regression test を同じ正本に揃える必要がある。

## Current behavior

- `docs/design/database-schema.md` は current DB body を主に `withmate.db` / `withmate-v2.db` として説明している
- `docs/design/mate-storage-schema.md` は 4.0 runtime の正本 DB を `withmate-v4.db` としている
- test は path selection や v4 schema validity を一部持つが、「legacy DB を開いても v4 table が増えない」は固定していない

## Problem

- current / future boundary が読み手に伝わりにくい
- 設計意図と runtime がずれた時に差分検知しづらい
- DB bootstrap の回帰が入っても test で拾いにくい

## Proposed scope

- Issue 01, 02, 04 の結論に合わせて design doc を同期する
- regression test を追加し、最低限の storage invariants を固定する
  - fresh install の active DB path
  - invalid empty v4 file が legacy DB を shadow しない
  - legacy open 時に v4 table が増えない
  - supported migration / import 後は expected schema になる

## Acceptance criteria

- [ ] DB current design を読めば active file / legacy fallback / migration policy が分かる
- [ ] runtime と矛盾する future-only 記述が current section に残らない
- [ ] bootstrap / compatibility mode / migration の regression test が揃う
- [ ] bug fix 後の再発を test で検出できる

## Notes / open questions

- docs 先行で現状追認するのか、runtime 修正後に design を同期するのかは順序を決めたい
- `docs/task-backlog.md` へ取り込むかは、GitHub issue 化するタイミングで判断すればよい


