# Companion Mode MVP 実装 Worklog

## 2026-04-26

- 実装開始。
- 直近コミット `505bf86` で Companion Mode の正式設計と旧たたき台削除が入っており、作業ツリーが clean であることを確認した。
- `docs/design/companion-mode.md`、`docs/design/database-schema.md`、Home launch / IPC / storage 周辺を確認した。
- Companion 用の shared type、Git eligibility helper、storage、session service を追加した。
- Home launch dialog に `Agent / Companion` toggle を追加し、Companion 作成時は Git repo root を検証して専用 table に保存する導線を追加した。
- Companion session summary の IPC / preload API / Home subscription を追加した。
- `docs/design/database-schema.md` と `docs/design/companion-mode.md` を current MVP 実装に合わせて更新した。
- 検証:
  - `npx tsc -p tsconfig.electron.json --noEmit`
  - `npx tsx --test scripts/tests/companion-storage.test.ts scripts/tests/companion-git.test.ts scripts/tests/home-launch-state.test.ts scripts/tests/main-ipc-deps.test.ts scripts/tests/main-bootstrap-deps.test.ts scripts/tests/main-ipc-registration.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts`
  - `npm test`

## コミット記録

| checkpoint | commit | summary |
| --- | --- | --- |
| CompanionSession 作成 MVP | 未コミット | Home から CompanionSession を作成し、専用 table と Home 一覧に反映できる状態 |
