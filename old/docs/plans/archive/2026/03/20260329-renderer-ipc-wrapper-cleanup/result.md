# 20260329 Renderer IPC Wrapper Cleanup Result

## 状態

- completed

## 概要

- `withWithMateApi` helper を追加した
- `HomeApp` の open/pick/create 系 wrapper と `CharacterEditorApp` の save/delete を helper 経由へ寄せた
- 過剰 abstraction は避け、effect 内の `withmateApi` ローカル変数は維持した

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/renderer-withmate-api.test.ts`

## コミット

- `2291b05` `refactor(renderer): simplify withmate api wrappers`
