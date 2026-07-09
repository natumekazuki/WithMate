# 20260329 IPC Boundary Test Hardening Result

## 状態

- completed

## 概要

- `preload-api` の public shape と payload unwrap を test で固定した
- `main-ipc-registration` の current invoke channel 登録を domain 横断で固定した
- IPC boundary refactor 後の regression を早めに検知できる状態にした

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/preload-api.test.ts scripts/tests/main-ipc-registration.test.ts`

## コミット

- `a5fb3e1` `test(ipc): harden preload and registration boundaries`
