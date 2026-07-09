# DB 世代を判定できる schema metadata と診断面を追加する

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P1
- Type: Maintenance / Debuggability
- Related:
  - `src-electron/app-database-path.ts`
  - `src-electron/sqlite-connection.ts`
  - `src-electron/main.ts`
  - `docs/design/database-schema.md`

## Summary

現行 runtime は DB 世代を file 名と required table 群から推定しているが、単一の canonical metadata がない。  
そのため「今どの DB を使っていて、schema 的に何世代なのか」を app / log / debug 時に即答しにくい。

## Current behavior

- `PRAGMA user_version` や共通 `schema_meta` table を使っていない
- 世代判定は file 名と `isValidV2Database` / `isValidV3Database` / `isValidV4Database` の組み合わせに依存している
- startup log には `userDataPath` は出るが、active `dbPath` / schema generation / compatibility mode は一意に見えない

## Problem

- debug 時に「今の DB バージョンは何か」を説明しづらい
- mixed-generation 状態を検知しにくい
- 今後 migration や import を追加しても、完了判定を共通化しづらい

## Proposed scope

- DB ごとの canonical metadata を導入する
  - 候補: `PRAGMA user_version`
  - 候補: `app_metadata` / `schema_meta` table
- 起動時に active `userDataPath` / `dbPath` / schema version / compatibility mode を log へ残す
- debug 向けに renderer または IPC から参照できる state を追加する

## Acceptance criteria

- [ ] runtime が active DB の schema version を一意に返せる
- [ ] mixed-generation や unsupported combination を検知して log / UI へ出せる
- [ ] debug 時に `WITHMATE_USER_DATA_PATH` override と active DB path を同時に確認できる
- [ ] migration / import 後の完了判定に同じ metadata を使える

## Notes / open questions

- file 名を version とみなす運用を続けるか、metadata を唯一の正本にするかは先に決めたい
- renderer へどこまで出すかは debug UX の範囲次第だが、最低でも app log と IPC で読める状態は欲しい


