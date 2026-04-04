# decisions

## status

- 進行中

## 決定

- provider binary は `resources/provider-binaries/` 配下へ stage して配布する
- `Codex` は `codexPathOverride` を使って stage 済み binary を明示する
- `Copilot` は `cliPath` に stage 済み binary を渡し、見つからない時だけ local `node_modules` fallback を使う
