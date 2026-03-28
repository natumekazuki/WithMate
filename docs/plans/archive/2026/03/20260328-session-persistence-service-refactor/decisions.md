# Decisions

## Decision 1: first target は CRUD + upsert に限定する

- `replaceAllSessions()` は migration / rollback / reset と結びついていて責務が広い
- 先に `createSession / updateSession / deleteSession / upsertSession` を service に寄せる
- `replaceAllSessions()` は follow-up slice で扱う

## Decision 2: session persistence service は session 関連の副作用同期を持つ

- `Session Memory`
- `Project Scope`
- `Character Scope`
- provider 変更時の telemetry clear
- delete 時の background activity / reflection checkpoint clear

これらは current 実装では session 保存に従属しているため、service の責務としてまとめる

## Decision 3: storage と broadcast は service の境界内に置く

- `main.ts` 側で `sessions` の再読込と `broadcastSessions()` を繰り返すと責務が戻る
- service が storage 書き込み、in-memory list 更新、broadcast まで持つ
