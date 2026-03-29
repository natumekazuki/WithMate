# Worklog

## 2026-03-29

- review findings remediation 向け repo plan 4 ファイルの構成を揃えた
- issue 1〜8 の remediation 計画を `plan.md` に整理した
- same-plan / follow-up の切り分け理由を `decisions.md` に整理した
- issue 3 の `sandbox` 方針をユーザー判断で固定し、`sandbox: true` spot-check を第一候補に更新した
- issue 8 は現仕様採用で判断確定し、`openPath` 非 allowlist 方針と `AddDirectory` の位置づけを plan に反映した
- validation baseline を `npm run build` success 維持、`npm run typecheck` baseline fail 非悪化で記録した
- `README.md`、`docs/design/electron-window-runtime.md`、`docs/design/window-architecture.md` を更新候補として整理し、`.ai_context/` は更新不要判定にした
- `vite.config.ts` は user 固有絶対 path の再現は無かったが、`process.cwd()` 依存を避けるため `import.meta.url` 基準の repo path 解決へ寄せた
- `index.html` / `session.html` / `character.html` / `diff.html` に、Vite dev server と build 配信の両方を許容する meta CSP を追加した
- `src-electron/main.ts` の BrowserWindow を `sandbox: true` に更新し、preload が `contextBridge` / `ipcRenderer` の薄い橋渡しで完結する前提を design doc に反映した
- `src-electron/session-runtime-service.ts` の `reset()` で in-flight `AbortController` を abort し、pending approval も deny するように修正した
- `src-electron/session-storage.ts` で破損 JSON を session 単位で検知し、一覧では skip + `console.error`、単体取得では throw するように修正した
- `package.json` の `typescript` / `tsx` を `devDependencies` へ移し、`npm test` script を追加した
- `README.md` と `docs/design/electron-window-runtime.md` を remediation 内容に合わせて更新した
- issue 8 について、`openPath` / `openSessionTerminal` の現仕様採用 rationale を design doc に反映した
- `scripts/tests/session-runtime-service.test.ts` と `scripts/tests/session-storage.test.ts` を追加し、runtime reset / 破損 JSON 対応の回帰テストを補強した
- `scripts/tests/session-runtime-service.test.ts` の型エラーを解消した
- 実装本体がコミット `76ea6efd59025e18f79936009c65b7a5013f8612` `fix(runtime): レビュー指摘を是正` として確定していることを記録した

## 完了

- remediation 実装完了を確認した
- `npm test` 成功を確認した
- `npm run build` 成功を確認した
- `tsc -p tsconfig.electron.json --noEmit --pretty false` 成功を確認した
- `tsc --noEmit --pretty false` は fail 継続（67 errors / 27 files の既存 baseline）で、今回追加した `scripts/tests/session-runtime-service.test.ts` / `scripts/tests/session-storage.test.ts` に型エラーがないことを確認した
- issue 9（`src-electron/main.ts` 巨大化）は別 plan に切り出す前提を維持した
- renderer/test 側の既存型エラー baseline は別タスクに切り分けた
- plan を `docs/plans/archive/2026/03/20260329-review-findings-remediation/` へ archive した
- コミット `76ea6efd59025e18f79936009c65b7a5013f8612` `fix(runtime): レビュー指摘を是正` を最終記録へひも付けた

## 検証メモ

- `npm test`: success
- `npm run build`: success
- `tsc -p tsconfig.electron.json --noEmit --pretty false`: success
- `tsc --noEmit --pretty false`: fail 継続（67 errors / 27 files の既存 baseline。主例: `scripts/tests/audit-log-service.test.ts`, `scripts/tests/aux-window-service.test.ts`, `scripts/tests/character-memory-retrieval.test.ts`）
- 今回変更した `scripts/tests/session-runtime-service.test.ts` / `scripts/tests/session-storage.test.ts` は型エラーなし
