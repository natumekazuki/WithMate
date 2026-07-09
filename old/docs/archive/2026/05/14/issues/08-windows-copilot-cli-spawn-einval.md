# Windows 開発環境で Copilot CLI が .cmd fallback に落ちて spawn EINVAL になる

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P1
- Type: Bug
- Related:
  - `docs/error.log`
  - `src-electron/copilot-adapter.ts`
  - `src-electron/provider-binary-paths.ts`
  - `scripts/tests/copilot-adapter.test.ts`
  - `scripts/tests/provider-binary-paths.test.ts`

## Summary

Windows の開発環境で Copilot provider を使うと、native Copilot binary ではなく `node_modules\.bin\copilot.cmd` に fallback し、その起動で `spawn EINVAL` が発生する。  
結果として quota telemetry と Mate Memory generation の両方が失敗し、Copilot provider の動作確認ができない。

## Current behavior

- `docs/error.log` に `withmate:get-provider-quota-telemetry` / Mate Memory generation の `spawn EINVAL` が出る
- `cliPath` は `node_modules\\.bin\\copilot.cmd` になっている
- `src-electron/provider-binary-paths.ts` の `resolveDevelopmentProviderBinaryPath()` は `@github/copilot-win32-x64/package.json` を `require.resolve()` しようとする
- current `@github/copilot-win32-x64` package は `./package.json` を exports しておらず、`ERR_PACKAGE_PATH_NOT_EXPORTED` になる
- その結果 `src-electron/copilot-adapter.ts` の `resolveCopilotCliPath()` が development native binary を見つけられず `.cmd` fallback に落ちる

## Problem

- optional native package は install されているのに、resolution 戦略の不整合で使われない
- Windows では `.cmd` fallback が `spawn EINVAL` を起こしうるため、Copilot provider の主要経路が壊れる
- quota telemetry と background structured prompt の両方で同じ bootstrap failure が波及する

## Expected behavior

- Windows 開発環境では、installed な `@github/copilot-win32-x64` native binary を優先して使う
- package exports で `./package.json` が非公開でも native binary 解決が壊れない
- native binary が利用可能な環境で `.cmd` fallback に落ちない

## Proposed scope

1. development native binary の解決を `package.json` subpath 依存にしない
2. Copilot package が root export だけ公開している場合でも binary path を解決できるようにする
3. `resolveCopilotCliPath()` の回帰 test を追加する
4. `resolveDevelopmentProviderBinaryPath()` の provider-level test を追加する

## Acceptance criteria

- [ ] `@github/copilot-win32-x64/package.json` が `ERR_PACKAGE_PATH_NOT_EXPORTED` でも native Copilot binary を解決できる
- [ ] Windows 開発環境で `resolveCopilotCliPath()` が `node_modules\\.bin\\copilot.cmd` ではなく native binary を返す
- [ ] Copilot binary resolution の回帰 test が追加される
- [ ] provider binary resolution の回帰 test が追加される

## Notes / open questions

- native Copilot binary 自体が無いケースでは `.cmd` fallback が残る
- Windows で `.cmd` fallback を今後も許容するか、別の起動戦略へ寄せるかは別 issue で整理してよい

