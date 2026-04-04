# result

## status

- 完了

## summary

- provider native package を `resources/provider-binaries/` 配下へ stage して配布する構成へ切り替えた
- `Codex` は staged binary を `codexPathOverride` で使い、`Copilot` は staged binary を `cliPath` で使う
- `npm run dist:dir` で `release/win-unpacked/resources/provider-binaries/` 配下に `codex.exe` と `copilot.exe` が出ることを確認した
- `10f019b` で version を `1.0.2` に上げて本体変更をコミットした
- `npm run dist:win` で `release/WithMate Setup 1.0.2.exe` の生成まで確認した
