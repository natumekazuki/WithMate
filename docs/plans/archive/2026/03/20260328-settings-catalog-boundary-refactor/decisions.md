# Decisions

## Decision 1: persistence と normalize を分ける

- `app-settings-storage.ts` と `model-catalog-storage.ts` は永続化に寄せる
- `normalize` や fallback 解決は orchestration / service 側へ寄せる

## Decision 2: renderer の draft 構築も整理対象に含める

- `HomeApp.tsx` の設定画面は provider ごとの draft 構築が厚い
- main 側だけでなく renderer 側の view model 境界も今回の対象に含める
