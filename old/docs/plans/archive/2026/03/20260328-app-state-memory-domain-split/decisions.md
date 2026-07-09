# Decisions

- `app-state.ts` の first split は Memory domain を優先する
- runtime 挙動は変えず、型定義と helper の配置だけを移す
- background activity は Memory と一緒に切ることで、`Session Memory` / `Character Reflection` / right pane projection の shared dependency を整理する
