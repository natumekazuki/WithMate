# Decisions

- `app-state.ts` の second split は provider config / app settings を優先する
- runtime 挙動は変えず、型定義と normalize / resolve helper の配置だけを移す
- `AppSettings` 自体も新 module 側を正本にし、`app-state.ts` は re-export に寄せる
