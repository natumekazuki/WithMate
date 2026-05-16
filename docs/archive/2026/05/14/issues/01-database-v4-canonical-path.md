# 4.0 runtime の DB 正本を withmate-v4.db に揃える

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P1
- Type: Bug / Architecture
- Related:
  - `src-electron/main.ts`
  - `src-electron/app-database-path.ts`
  - `src-electron/persistent-store-lifecycle-service.ts`
  - `docs/design/mate-storage-schema.md`

## Summary

4.0 runtime の latest schema は v4 だが、cold start 時の DB 選択は `withmate.db` へ fallback する。  
その結果、4.0 系 storage の正本を `withmate-v4.db` に置く design と、実際の起動 path がずれている。

## Current behavior

- `src-electron/main.ts` は `app.whenReady()` で `resolveAppDatabasePath(app.getPath("userData"))` を使う
- `src-electron/app-database-path.ts` は `withmate-v4.db` / `withmate-v3.db` / `withmate-v2.db` を順に探し、どれも有効でなければ `withmate.db` を返す
- `docs/design/mate-storage-schema.md` は 4.0 runtime の正本 DB を `withmate-v4.db` と定義している

## Problem

- fresh install でも active DB file 名が `withmate.db` になりうる
- 「4.0 runtime の正本は v4 file」という前提が崩れ、support / backup / debug の説明が難しい
- file 名ベースの世代認識と、runtime が実際に使っている schema 群が一致しない

## Proposed scope

- cold start bootstrap を見直し、4.0 runtime の新規作成時は `withmate-v4.db` を canonical path にする
- legacy DB が存在する場合の fallback 条件を明文化する
- `resolveAppDatabasePath` と初回起動時の DB 作成フローを同じ方針に揃える

## Acceptance criteria

- [ ] fresh install で active DB path が `withmate-v4.db` になる
- [ ] 4.0 runtime で新規生成した data が `withmate.db` に保存されない
- [ ] `app-database-path` の test が cold start の canonical path を固定する
- [ ] design doc の current 記述と runtime が一致する

## Notes / open questions

- legacy data を見つけた時に「そのまま legacy を使う」のか「明示 import を要求する」のかは Issue 04 と接続する
- 先に canonical path を決めないと、後続の metadata / migration / debug UI も曖昧なままになる


