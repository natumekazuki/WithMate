# Companion Mode MVP 実装 Result

- status: 完了
- started: 2026-04-26
- completed: 2026-04-26

## 結果

- Home launch dialog に `Agent / Companion` toggle を追加した。
- Companion mode では Git repo root、HEAD、target branch を検証し、Git repo でない directory や detached HEAD を拒否する。
- `companion_groups` / `companion_sessions` を追加し、既存 `sessions` table へ相乗りしない保存経路を実装した。
- CompanionSession 作成時に repo root、focus path、target branch、companion branch 予定名、worktree path 予定値、provider / model / approval / sandbox / character snapshot を保存する。
- Home で CompanionSession summary を購読し、active CompanionSession の最小一覧を表示する。
- `docs/design/database-schema.md` と `docs/design/companion-mode.md` を current MVP 実装に合わせて更新した。

## 対象外として残したもの

- snapshot commit / internal ref 作成
- shadow worktree 実体作成
- provider を shadow worktree で実行する処理
- Companion Review Window
- selected files merge / discard
- sibling check

## 検証

- `npx tsc -p tsconfig.electron.json --noEmit`
- `npx tsx --test scripts/tests/companion-storage.test.ts scripts/tests/companion-git.test.ts scripts/tests/home-launch-state.test.ts scripts/tests/main-ipc-deps.test.ts scripts/tests/main-bootstrap-deps.test.ts scripts/tests/main-ipc-registration.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts`
- `npm test`

## コミット

- `c1bc19e` feat(companion): Companion Mode の初期作成導線を追加
