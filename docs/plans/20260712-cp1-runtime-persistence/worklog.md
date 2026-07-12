# Worklog

## 2026-07-12: CP1 Plan作成

- parent roadmapのCP1を`進行中`へ変更した。
- CP1をS1〜S8へ分割した。
- 現在地をS1着手前とした。
- S1でstack、SQLite driver、Worker transport、test runnerを比較して確定する。
- 旧`package.json`は比較証拠に限定し、現行stackとして採用していない。
- S1開始を止めるuser回答待ちはない。

## 2026-07-12: S1 Stack / Driver / Transport Decision完了

- 旧実装のnpm、ESM、TypeScript、tsx、Node.js test runnerを基礎stackとして踏襲した。
- production runtimeをElectron 42最新patch、standalone runtimeをNode.js 24.16以上24系とした。
- SQLite driverを`node:sqlite` `DatabaseSync`とし、Persistence Workerだけがconnectionを所有する方針を確定した。
- transportを`worker_threads`とし、BLOB chunkは専有`ArrayBuffer`をtransferする方針を確定した。
- `scripts/probe-runtime-persistence.mjs`をNode.js 22.22.0で実行し、transaction rollback、backup、16 MiB transfer、Worker crash検出が成功した。
- target Electron / Node.js 24での再実行とpackaged Worker起動はS2以降のGateへ残した。
- S1の質問5件を確認済みにし、現在地をS2着手前へ更新した。

## 2026-07-12: S2 Project Scaffold完了

- rootへ`package.json`と`package-lock.json`を追加し、direct dependencyをexact versionで固定した。
- TypeScript project referenceで`src/shared`、`src/main`、`src/persistence-worker`、testを分離した。
- persistence protocol version 1の最小envelope型とschema artifact resolverを追加した。
- Main / sharedからSQLite ownershipが漏れないmodule boundary validatorを追加した。
- npm scriptsとしてbuild、typecheck、lint、format、test、runtime probeを追加した。
- `npm ci`、typecheck、test、build、format check、schema validatorが成功した。
- Node.js 24.18.0とElectron 42.5.2同梱Node.js 24.17.0でruntime persistence probeが成功した。
- docs-syncは`workspace-only`と判定した。S2は既存の責務決定をscaffoldへ反映した段階であり、新しい長期設計契約はD1-011へ記録済みのため、`docs/design/`は追加更新していない。
- 別視点reviewで、test用`.tsbuildinfo`のroot漏出、schema validatorの`npm test`未統合、MJSを検査対象に見せる無効なTypeScript includeを検出した。
- `.tsbuildinfo`を`dist/.tsbuildinfo`へ移し、Python 3 resolver経由でschema validatorを`npm test`へ統合し、MJSは`node --check`で検証するよう修正した。
- 現在地をS3 SQLite Bootstrap / Schema Verification着手前へ更新した。
