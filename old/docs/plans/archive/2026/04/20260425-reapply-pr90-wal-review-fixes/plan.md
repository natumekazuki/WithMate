# Reapply PR90 WAL review fixes

- 作成日: 2026-04-25
- 種別: session plan
- status: 完了

## Goal

revert / pull 後の current code に合わせて、PR #90 の追加 WAL review 修正を再適用する。

## Scope

- `truncateAppDatabaseWal` の checkpoint 前 connection 設定を補強する
- WAL truncate 失敗を close / recreate に伝播させない
- interval maintenance の busy timeout を短くする
- review 指摘に対応する tests / docs を current code に合わせて戻す

## Checkpoints

- [x] current code を確認する
- [x] WAL helper / lifecycle / interval を修正する
- [x] tests / docs を更新する
- [x] 型チェックを実行する

## Verification

- 成功: `npx tsc -p tsconfig.electron.json --noEmit`
- 未実行: `tsx` / `node:test` 系はこの sandbox の `spawn EPERM` 制約が既知のため、非 sandbox 環境で再実行する
