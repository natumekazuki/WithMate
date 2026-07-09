# 20260329 WithMate Window API Surface Review Result

## 状態

- completed

## 概要

- `WithMateWindowApi` の public surface は維持したまま、domain interface に分割して見通しを上げた
- `preload-api.ts` も同じ domain 単位の型で返り値を整理した
- current public API のキー集合は変えていない

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/preload-api.test.ts scripts/tests/renderer-withmate-api.test.ts`

## コミット

- `8107e06` `refactor(ipc): split withmate window api domains`
