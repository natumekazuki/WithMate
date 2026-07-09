# Copilot SessionNotFound 復旧

## Tier

session plan

## 目的

Copilot で一定時間メッセージを送らない後に `SessionNotFound` が発生するケースで、通常送信時にも stale session として再接続・再試行できるようにする。

## 作業

- [x] Copilot / runtime 側の stale session 判定を確認する
- [x] `SessionNotFound` 表記ゆれを retry 対象に含める
- [x] 関連テストを追加する
- [x] 対象テストと typecheck を実行する

## Docs Sync

- `docs/design/provider-adapter.md` は既に stale thread/session と Copilot `SessionNotFound` retry 方針を記載済みのため更新不要。
- `.ai_context/` は存在しないため更新不要。
- README の入口や公開仕様は変わらないため更新不要。

## 検証

- `npx tsc -p tsconfig.electron.json --noEmit`: 成功
- `npm run test -- scripts/tests/copilot-adapter.test.ts scripts/tests/session-runtime-service.test.ts`: sandbox の子プロセス起動制限で `spawn EPERM`
- `npx tsx scripts/tests/copilot-adapter.test.ts`: sandbox の esbuild 起動制限で `spawn EPERM`
- `npx tsx scripts/tests/session-runtime-service.test.ts`: sandbox の esbuild 起動制限で `spawn EPERM`
