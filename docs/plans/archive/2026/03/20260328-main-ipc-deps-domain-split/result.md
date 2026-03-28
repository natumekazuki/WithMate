# 20260328 Main IPC Deps Domain Split Result

## 状態

- completed

## 概要

- `src-electron/main-ipc-deps.ts` の IPC registration builder 入力を domain ごとの grouped object に整理した
- `src-electron/main-bootstrap-deps.ts` と `src-electron/main.ts` も同じ grouping で wiring する形に揃えた
- preload / IPC registration / bootstrap builder の test を grouped input 前提へ更新した
- renderer / electron 内部 import も `withmate-window` public entry 依存から目的別 module 依存へ寄せた
- 対応コミット: `2a1282d` `refactor(ipc): split preload and registration boundaries`

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/main-bootstrap-deps.test.ts scripts/tests/main-ipc-deps.test.ts scripts/tests/main-ipc-registration.test.ts scripts/tests/preload-api.test.ts`
