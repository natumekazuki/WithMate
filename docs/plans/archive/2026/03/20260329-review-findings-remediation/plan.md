# Plan

## Goal

- 元レビュー指摘の remediation 実装順序と decision を固定する
- issue 1〜8 の remediation 計画を repo plan として整理する
- cleanup task と混在させず、実装着手前に pending decision と validation 前提を確定する

## Status Update

- issue 1〜8（issue 8 は rationale 整理中心）の same-plan 実装を反映済み
- issue 1 は user 固有絶対 path の再現は無かったため no-op にはせず、`process.cwd()` 依存を減らす `import.meta.url` 基準の path 解決へ寄せた
- issue 3 は preload / IPC の current 構成と build/test の spot-check を前提に `sandbox: true` を採用した
- remediation 実装本体はコミット `76ea6efd59025e18f79936009c65b7a5013f8612` `fix(runtime): レビュー指摘を是正` で確定済み
- 検証結果は `npm test` / `npm run build` / `tsc -p tsconfig.electron.json --noEmit --pretty false` success、`tsc --noEmit --pretty false` は 67 errors / 27 files の既存 baseline fail 継続で完了判定とする
- 本 plan は完了扱いで archive 対象とする

## Scope

- issue 1: `vite.config.ts` のレビュー指摘再確認と remediation 要否判定
- issue 2: `index.html` / `session.html` / `character.html` / `diff.html` の CSP 対応方針
- issue 3: `src-electron/main.ts` の `sandbox` 設定見直し方針
- issue 4: `src-electron/session-runtime-service.ts` の `reset()` abort 対応方針
- issue 5: `src-electron/session-storage.ts` の破損 JSON 防御方針
- issue 6: `package.json` の `typescript` / `tsx` 区分是正方針
- issue 7: `package.json` の `test` script 追加方針
- issue 8: `src-electron/open-path.ts` / `src-electron/open-terminal.ts` の現仕様採用方針
- 関連 docs の更新候補整理

## Out Of Scope

- issue 9: `src-electron/main.ts` 巨大化への構造改善
- cleanup task の再整理・再実施
- review findings remediation と直接関係しない大規模 refactor
- remediation 実装そのもの

## Issue Grouping

### Group A: renderer / security 境界

- issue 1: `vite.config.ts`
- issue 2: `index.html` / `session.html` / `character.html` / `diff.html`
- issue 3: `src-electron/main.ts`

補足:
- issue 1 は現行再現有無の確認を起点にする
- issue 2 と issue 3 は renderer / preload / BrowserWindow 境界の確認としてまとめて扱う

### Group B: runtime / persistence 堅牢化

- issue 4: `src-electron/session-runtime-service.ts`
- issue 5: `src-electron/session-storage.ts`

補足:
- 実行中 state の終了処理と破損データ復旧方針を同一フェーズで整理する

### Group C: package / validation 整備

- issue 6: `package.json`
- issue 7: `package.json`

補足:
- 依存区分の是正と test script 追加は package metadata 見直しとして同時に扱う

### Group D: local path operation

- issue 8: `src-electron/open-path.ts` / `src-electron/open-terminal.ts`

補足:
- security 懸念と現仕様の運用前提を切り分けて扱う

## Decision Points

### issue 3

- 第一候補は `sandbox: true` 採用とする
- 先に `sandbox: true` の spot-check を行い、Codex SDK / GitHub Copilot SDK の実行と主要 preload / IPC に影響がないかを確認する
- spot-check 成功時は `sandbox: true` を有効化する
- spot-check で影響が確認された場合のみ、`sandbox: false` 維持へフォールバックし、理由を `src-electron/main.ts` 近傍または `docs/design/electron-window-runtime.md` などの security/runtime 境界 doc に明記する
- 確認対象:
  - `src-electron/main.ts`
  - `src-electron/preload.ts`
  - `src-electron/preload-api.ts`
  - BrowserWindow 起動 smoke check
  - 主要 preload API / IPC 利用確認
  - Codex SDK / GitHub Copilot SDK 実行影響の有無

### issue 8

- 方向性 B を採用済みとする
- 決定内容:
  - `openPath` は任意の target を受け取れる現仕様を維持する
  - 現時点では path allowlist を `openPath` 自体へ強制実装しない
  - `AddDirectory` は許可対象ディレクトリを制御できる既存機能として扱うが、`openPath` の強制ガードそのものではないことを明記する
  - `openSessionTerminal` は session の `workspacePath` を開く用途に限られているため、現時点では追加 block の優先度を上げない
  - issue 8 は脆弱性 fix 実装ではなく、現仕様の採用判断と必要時の rationale / docs 整理として扱う

## 実施順

1. baseline を固定する
   - `npm run build` success 維持
   - `npm run typecheck` は baseline fail 前提で悪化させない
2. issue 1 の現行再現有無を確認する
3. issue 2 と issue 3 の renderer / security 方針を確定する
   - issue 3 は `sandbox: true` spot-check の成功条件に Codex SDK / GitHub Copilot SDK 実行影響なしを含める
4. issue 4 と issue 5 の runtime / persistence remediation 方針を確定する
5. issue 6 と issue 7 の package remediation 方針を確定する
6. issue 8 の採用方針を plan / rationale へ反映する
7. docs 更新対象と validation 手順を最終固定する

## Affected Docs

- `README.md`
  - test script 追加や運用変更がある場合のみ更新候補
- `docs/design/electron-window-runtime.md`
  - security/runtime 境界の更新候補
- `docs/design/window-architecture.md`
  - window ごとの制約説明が必要になった場合の更新候補
- `.ai_context/`
  - current repo に存在しないため更新不要判定

## Validation

- `npm run build` success 維持
- `npm run typecheck` は baseline fail 前提で、悪化させない
- 必要に応じて追加の targeted test / manual check を行う
  - BrowserWindow 起動確認
  - preload API 利用確認
  - Codex SDK / GitHub Copilot SDK 実行影響確認
  - `reset()` の in-flight run 終了確認
  - 破損 JSON の挙動確認
  - issue 8 の利用導線説明と plan 記述の整合確認

## Risks

- issue 1 は現行コードで再現しない可能性があり、元レビュー指摘との突合が必要
- issue 3 は `sandbox: true` が preload / IPC や Codex SDK / GitHub Copilot SDK 実行前提を崩す可能性がある
- issue 5 は fallback を強くしすぎると破損検知が弱くなる
- issue 8 は allowlist 未強制の意図が誤解されると、`AddDirectory` を強制ガードと誤認される可能性がある
- issue 7 の `test` script 追加時に `typecheck` baseline fail と役割が混同される可能性がある

## Follow-up

- issue 9 として扱う `src-electron/main.ts` 巨大化は follow-up に分離する
- issue 8 が将来の policy 再設計へ広がる場合のみ dedicated follow-up を切る
- issue 3 で preload / IPC 再設計が必要になった場合は same-plan からの切り出しを再判定する
