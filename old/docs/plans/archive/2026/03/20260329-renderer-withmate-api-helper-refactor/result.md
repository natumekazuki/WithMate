# 20260329 Renderer WithMate API Helper Refactor Result

## 状態

- completed

## 概要

- `renderer-withmate-api.ts` を追加して `window.withmate` 取得と desktop runtime 判定を共通化した
- `DiffApp`、`CharacterEditorApp`、`HomeApp`、`App` の主要な `window.withmate` 直参照を helper 経由へ寄せた
- helper の最小 regression test を追加した

## 検証

- `npm run build`
- `node --test --import tsx scripts/tests/renderer-withmate-api.test.ts`

## コミット

- `bb0de07` `refactor(renderer): share withmate api access helper`
