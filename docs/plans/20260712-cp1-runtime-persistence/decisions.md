# Decisions

## D1-001: CP1を8 sliceに分割する

- date: 2026-07-12
- status: accepted

技術選定、scaffold、bootstrap、Worker、read、write、fault test、integration Gateの順に進める。stack未決定のまま具体pathやpackage APIを固定しない。

## D1-002: SQLiteの単一ownerをCP1の中心契約とする

- date: 2026-07-12
- status: accepted

SQLite connection、transaction、schema lifecycleはPersistence Workerだけが所有する。Main process、Renderer、CLI、Provider AdapterはSQLite driverを直接利用しない。

## D1-003: Repository APIとApplication Serviceを分離する

- date: 2026-07-12
- status: accepted

CP1はstorage不変条件とtransaction commandを実装する。use case orchestration、CLI response envelope、Provider workflowはCP2以降の責務とする。

## D1-004: 旧stackは比較材料に限定する

- date: 2026-07-12
- status: accepted

`old/package.json`と旧実装は必要要件やfailure modeの参考にできるが、version、dependency、module構成、Worker方式をそのまま採用しない。

## D1-005: CP1完了前にfault testを必須とする

- date: 2026-07-12
- status: accepted

正常CRUDだけではwrite ownershipの安全性を証明できない。concurrent admission、transaction rollback、Worker crash、shutdown、bootstrap interruptionをCP1 Gateに含める。

## D1-006: 旧実装の基礎stackを更新して踏襲する

- date: 2026-07-12
- status: accepted

package managerはnpm、lockfileは`package-lock.json` v3、module systemはESM、TypeScriptは6.0系、実行時の最低targetはES2022とする。testはNode.js組み込みtest runnerを`tsx --test`から実行する。

旧実装のpackage構成とtest運用は実績があり、CP1で別toolchainへ移行する利益が小さい。一方、direct dependencyはS2で互換性を確認したexact versionへ固定し、lockfile外のcaret更新へ依存しない。Vite、React、electron-builderなどrenderer / packaging固有dependencyは、それぞれCP7 / CP8まで固定を延期する。

## D1-007: production runtimeをElectron 42系、開発Node.jsを24系とする

- date: 2026-07-12
- status: accepted

productionはElectron 42の最新patchを正本とする。S1時点の最新stableは42.5.2で、Node.js 24.17.0を同梱する。standalone test / CLIはNode.js `>=24.16 <25`を要求し、productionとのmajor差を作らない。Electron、TypeScript、tsxの具体patchはS2のlockfile生成時にexact versionで記録する。

Node.js 24.16以降を最低値とした理由は、`node:sqlite`のbackupに加えてserialize / deserializeを利用可能な検証基準へ揃えるためである。現在の開発shellはNode.js 22.22.0のため、S2のclean install / test GateはNode.js 24環境でも実施する。

## D1-008: SQLite driverに`node:sqlite`の`DatabaseSync`を採用する

- date: 2026-07-12
- status: accepted

SQLite connectionはPersistence Worker内だけで`DatabaseSync`として開く。transactionは明示的な`BEGIN` / `COMMIT` / `ROLLBACK`、backupは`node:sqlite`の`backup()`、BLOB readはSQLの範囲取得と上限付きchunk responseで実装する。extension loadingは無効のままとする。

採用理由は、Electron同梱Node.jsだけで動き、native addon rebuild、Electron ABI差、Windows toolchain、asar unpack対象を追加しないためである。旧実装のdriverとPRAGMA知見は踏襲するが、Main processや複数storage classによるconnection所有は踏襲しない。

不採用候補は次のとおり。

- `better-sqlite3`: APIは適合するが、native addon rebuildとElectron ABI / packaging管理が増える。
- `sqlite3`: native addonに加えcallback / async APIがWorker内の直列transaction境界を複雑にする。
- WASM SQLite: file locking、WAL、backup、Electron filesystem統合を別途構築する必要がある。

`node:sqlite`はNode.js 24時点でrelease candidateであり、CP8までNode / Electron patch更新時のcontract testを必須とする。incremental BLOB handleは前提にせず、巨大payloadを一括hydrateしないrepository contractで補う。

## D1-009: Persistence Worker transportに`node:worker_threads`を採用する

- date: 2026-07-12
- status: accepted

Main processとPersistence Workerはversion付きrequest / responseを`postMessage`で交換する。BLOB chunkは専有`ArrayBuffer`をtransfer listへ渡し、送信後のdetachを前提とする。Workerの`error`と非zero `exit`を監視し、in-flight requestを明示失敗へ収束させる。

`worker_threads`はElectron Mainとstandalone Node.js test / CLIで同じprotocolを利用でき、同期SQLite処理をMain event loopから隔離できる。Electron `utilityProcess`はprocess isolationに優れるが`app.ready`以後に限定され、CP2 CLIとcontract testで別transportが必要になるため不採用とする。`child_process`も同様にprocess間protocolとstagingが増え、信頼済みのPersistence codeに対する追加隔離の利益を上回らない。

## D1-010: S1 probeの確認範囲を固定する

- date: 2026-07-12
- status: accepted

`scripts/probe-runtime-persistence.mjs`で、transaction rollback、online backup、16 MiB `ArrayBuffer` transfer、Worker uncaught exceptionの`error` / nonzero `exit`を確認する。2026-07-12にNode.js 22.22.0で全項目が成功した。

これはAPI形状とtransport semanticsの確認であり、target runtimeの代替ではない。Electron 42 / Node.js 24での再実行、packaged app内のWorker起動、chunk単位のquota / cancellationはS2、S4、S7のGateへ残す。

## D1-011: runtime scaffoldをTypeScript project referenceで分離する

- date: 2026-07-12
- status: accepted

新実装は`src/shared`、`src/main`、`src/persistence-worker`を個別のTypeScript projectとしてbuildする。`shared`はrequest / response contract、`main`はWorker lifecycleとrouting、`persistence-worker`はSQLiteとschema artifactを所有する。

Mainとsharedから`node:sqlite`を参照すること、sharedからElectron / Worker固有moduleを参照することを`scripts/validate-module-boundaries.mjs`で拒否する。`old/`はTypeScript include、format、test、buildの対象に含めない。

schema artifactはsource実行時とcompiled実行時で同じrepo root相対位置になる`import.meta.url`基準で解決する。packaged appでの配置とasar境界はCP8で確定する。

## D1-012: S2のformat対象を新runtime scaffoldへ限定する

- date: 2026-07-12
- status: accepted

Prettierはroot JSON、`src/**/*.ts`、`test/**/*.ts`、root `scripts/*.mjs`だけを対象とする。既存design docs、investigation artifact、schema manifest、`old/`を一括整形しない。文書とschema artifactはそれぞれの既存文体と専用validatorを優先する。

## D1-013: schema artifactとbootstrap runtimeの責務を分離する

- date: 2026-07-12
- status: accepted

`schema/sqlite/v1.sql`はtable、index、triggerだけを定義する。header PRAGMA、write transaction、`application_id`、`user_version`、manifest / integrity検証、WAL移行、connection PRAGMAはPersistence Workerのbootstrap runtimeが所有する。

既存DBは元fileを変更せず分類する。sidecarがない場合はimmutable read-only URIを使い、WALまたはrollback journalがある場合はmain DBとsidecarを一時directoryへsnapshotして検査する。snapshot前後でfile identity、size、更新時刻、content hashが変化した場合は`database_busy`として再試行可能な失敗へ収束させる。

新DB pathは呼出側から明示的に受け取り、directory scanや旧DB fallbackは行わない。既知の旧DB path、hardlink、symlinkによる同一file参照はopen前に拒否する。

## D1-014: Persistence Workerを世代付きsingle FIFO actorとする

- date: 2026-07-12
- status: accepted

Persistence Workerはprimary `DatabaseSync` connectionを1本所有し、read、write、maintenanceを有界FIFOで直列実行する。複数read connectionはS5の代表queryで必要性が実測されるまで導入しない。checkpointだけは同じWorkerが短命maintenance connectionを所有し、shutdown時はprimary close後に開く。

protocolは`protocolVersion`、`generationId`、canonical `requestId`、世代内単調`requestSequence`を使う。Workerはsequence high-water markでreplayをO(1) memoryで拒否する。crash後は新generationを明示的に作り、in-flight requestを自動再送しない。

timeout / cancel / crashのfailureは`effect=none | unknown`を返す。実行開始済みwriteのtimeout、crash、forced shutdownはcommit済みの可能性があるため`unknown`とし、Repository commandのidempotency契約またはread-backで収束させる。

payload readはstatelessな最大256 KiB chunk requestとし、専有`ArrayBuffer`をtransferする。1 response受領後に次requestを発行することをack / backpressure境界とする。詳細は`docs/design/persistence-worker-lifecycle.md`を正本とする。
