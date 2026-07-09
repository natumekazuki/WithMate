# Result

## 状態

- 完了

## current output

- review findings remediation 専用の repo plan 4 ファイルを作成・更新した
- Goal / Scope / Out Of Scope / decision points / 実施順 / validation を固定した
- issue 1 では、現行 `vite.config.ts` に user 固有絶対 path は残っていないことを確認したうえで、`process.cwd()` 依存を避ける `import.meta.url` 基準の repo path 解決へ置き換えた
- issue 2 では、`index.html` / `session.html` / `character.html` / `diff.html` に meta CSP を追加し、current の Vite dev server (`http://localhost:4173`, `ws://localhost:4173`) と build 配信を両立する範囲に絞って許可した
- issue 3 では、preload が `contextBridge` / `ipcRenderer` のみを使い、Codex SDK / GitHub Copilot SDK が main process 側に留まる current 構成を前提に `sandbox: true` を有効化した
- issue 4 では、`src-electron/session-runtime-service.ts` の `reset()` が in-flight run の `AbortController` を abort し、pending approval も deny するように修正した
- issue 5 では、`src-electron/session-storage.ts` の破損 JSON を session 単位で検知し、一覧取得では正常 row の利用を継続しつつ `console.error` を出し、単体取得では throw するようにした
- issue 6 では、`package.json` の `typescript` / `tsx` を `devDependencies` へ移した
- issue 7 では、既存 `node:test` ベースの test 群を起動する `npm test` script を追加し、`README.md` にも開発コマンドを追記した
- issue 8 は方向性 B を採用し、`openPath` 非 allowlist 維持と `AddDirectory` の非強制ガード性を `docs/design/electron-window-runtime.md` に明記した
- 追加テストとして `scripts/tests/session-runtime-service.test.ts` と `scripts/tests/session-storage.test.ts` を整備した
- `scripts/tests/session-runtime-service.test.ts` の型エラーを修正し、今回追加したテストでは型エラーを残さない状態にした
- docs 更新候補を以下に整理した
  - `README.md`
  - `docs/design/electron-window-runtime.md`
  - `docs/design/window-architecture.md`
  - `.ai_context/` は current repo に存在しないため更新不要判定
- validation baseline を以下で固定した
  - `npm run build`: success 維持
  - `tsc -p tsconfig.electron.json --noEmit --pretty false`: success
  - `tsc --noEmit --pretty false`: baseline fail、悪化させない
- 実装本体コミット `76ea6efd59025e18f79936009c65b7a5013f8612` `fix(runtime): レビュー指摘を是正` を本 plan の完了記録へ反映した
- plan 一式を `docs/plans/archive/2026/03/20260329-review-findings-remediation/` へ archive し、旧 `docs/plans/20260329-review-findings-remediation/` を廃止した

## validation

- `npm test` : success
- `npm run build` : success
- `tsc -p tsconfig.electron.json --noEmit --pretty false` : success
- `tsc --noEmit --pretty false` : fail 継続（67 errors / 27 files の既存 baseline。主例: `scripts/tests/audit-log-service.test.ts`, `scripts/tests/aux-window-service.test.ts`, `scripts/tests/character-memory-retrieval.test.ts`）
- 今回変更した `scripts/tests/session-runtime-service.test.ts` / `scripts/tests/session-storage.test.ts` は型エラーなし

## follow-up

- issue 9: `src-electron/main.ts` 巨大化は別 follow-up として扱う
- cleanup task は今回の repo plan に混在させない
- renderer/test 側の既存型エラー baseline は別タスクとして扱う
