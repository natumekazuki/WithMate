# 20260328 IPC Boundary Refactor Result

## 状態

- completed

## 概要

- `src/withmate-window.ts` を public entry にして、IPC channel 定数、window bridge type、reset type を別 module へ分離した
- `src-electron/preload-api.ts` を追加し、preload 側の `invoke / subscribe` bridge を domain ごとの helper で構成する形に整理した
- `src-electron/main-ipc-registration.ts` は register group ごとに分割し、window / catalog / settings / session / character の責務を読みやすくした

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/preload-api.test.ts scripts/tests/main-ipc-registration.test.ts scripts/tests/main-ipc-deps.test.ts`
