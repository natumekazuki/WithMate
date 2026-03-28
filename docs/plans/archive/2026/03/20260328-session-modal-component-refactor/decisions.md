# Decisions

- `Diff modal` と `Audit Log modal` は state 依存が限定的なので、`App.tsx` の renderer 分離の first slice として扱う
- helper は modal 専用なら component file 側へ閉じる
