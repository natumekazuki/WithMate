# CP1 Runtime / Persistence Foundation Plan

- 作成日: 2026-07-12
- parent roadmap: `docs/plans/20260712-withmate-rebuild-roadmap/plan.md`
- plan tier: repo plan
- 状態: active
- 現在地: S6進行中、B2a Provider Binding resolution完了
- questions status: 質問なし

## Task Brief

Goal: SQLiteを単一ownerが管理し、上位層へtransaction-safeなrepository APIだけを公開するruntime foundationを完成させる。
Scope: stack選定、project scaffold、schema bootstrap、Persistence Worker、repository read / write、contract test、shutdown / fault検証。
Out of scope: Provider process接続、Application Service / CLI operation、Character / Memory、Multi-Agent operation、GUI、packaging完成。
Done when: CP1 Gateをすべて満たし、CP2がSQLiteやWorker transportを意識せずrepository APIを利用できる。
Risks: native SQLite packaging、Worker crash、write競合、schema drift、transaction責務漏れ、巨大payload複製、早すぎるpublic API固定。

## 完了状態

CP1完了時、次が成立している。

- rootに新実装のpackage / TypeScript / test scaffoldがある。
- schema version 1を新規DBへbootstrapし、identity、version、definition hash、connection PRAGMAを検証できる。
- SQLite connectionをPersistence Workerだけが所有する。
- writeはWorker内で直列化し、domain transaction単位でcommit / rollbackされる。
- readは一貫したsnapshotとbounded responseを返し、BLOBを暗黙hydrateしない。
- repository APIがSession / Message / Run、Provider相関、Run output、Multi-Agent persistenceの基礎commandを提供する。
- schema、repository、concurrency、crash、shutdownのcontract testが自動実行される。

## 責務境界

| Component | 所有するもの | 所有しないもの |
| --- | --- | --- |
| Main process runtime | Worker起動・監視、request routing、live state | SQLite connection、SQL transaction |
| Persistence Worker | SQLite connection、bootstrap、query、transaction、maintenance request | Provider process、GUI state、domain workflow判断 |
| Repository API | persistence command / query、DBで表現できないcommit前不変条件 | CLI / IPC response envelope、Provider protocol |
| Schema artifacts | DDL、schema identity / version、definition manifest | runtime migration policy判断、domain operation |
| Contract tests | storage不変条件、failure mode、concurrency | Provider runtime E2E、GUI behavior |

DBで表現できるFK、CHECK、UNIQUEはSQLiteを最終防衛とする。role、同一Session所属、許可状態遷移、idempotency response参照などcross-row / workflow条件はRepository commandがtransaction内で検証する。

## Slice一覧

| Slice | 名称 | 状態 | 主な成果 | 依存 |
| --- | --- | --- | --- | --- |
| S1 | Stack / Driver / Transport Decision | 完了 | runtime version、package manager、SQLite driver、Worker transport、test runner決定 | CP0 |
| S2 | Project Scaffold | 完了 | package、TypeScript、lint / format方針、test runner、module boundary | S1 |
| S3 | SQLite Bootstrap / Schema Verification | 完了 | DB分類、fresh bootstrap、manifest検証、非対応DB拒否 | S2 |
| S4 | Persistence Worker Lifecycle | 完了 | Worker起動、request protocol、write queue、read、shutdown、crash処理 | S3 |
| S5 | Repository Read Model | 完了 | Session / timeline / Run / output / child resultのbounded query | S4 |
| S6 | Repository Write Transactions | 進行中（B2a完了） | admission、terminal、output、binding / dispatch、delivery、delete | S4、S5 |
| S7 | Contract / Concurrency / Fault Tests | 未着手 | schema test統合、競合、rollback、crash、shutdown、payload検証 | S3〜S6 |
| S8 | CP1 Integration Gate | 未着手 | public API review、dependency guard、full CP1 validation、docs同期 | S7 |

## S1: Stack / Driver / Transport Decision

### 目的

CP1以降の実装・test・packagingを支えられる最小stackを、公式supportとprobe結果から決定する。

### 調査対象

1. Node.js、Electron、TypeScriptのsupported combination。
2. package managerとlockfile policy。
3. SQLite driver候補のtransaction API、BLOB streaming / incremental read、backup API、extension / compile option、Electron native rebuild要否。
4. `worker_threads`、Electron utility process、child processのownership、crash isolation、serialization、packaging差。
5. test runner、TypeScript実行 / build、coverageの最小構成。

### 比較軸

- SQLite transactionとdeferred FKを正しく扱える。
- backup APIまたは整合snapshotを提供できる。
- WorkerからMainへ16 MiB BLOBを一括複製せずchunking可能である。
- Windows / Electron packagingのnative dependency運用が明確である。
- graceful shutdown、forced termination、request cancellationをtestできる。
- current LTS / supported releaseで保守できる。
- provider binary stagingやCP8 packagingを不必要に難しくしない。

### 成果物

- `decisions.md`のstack / driver / transport決定。
- 必要に応じて`docs/investigations/`の小規模probeと結果。
- `questions.md`のQ1-01〜Q1-05を確認済みに更新。
- S2で作成するfile / package構成の確定。

### Gate

- 候補ごとの採用 / 不採用理由がある。
- native module、Electron ABI、Windows build、packagingのリスクを確認している。
- transaction、backup、BLOB、Worker crashの最低1つずつをAPIまたはprobeで確認している。
- user判断が必要なtrade-offがあれば実装前に`回答待ち`へ切り替える。

## S2: Project Scaffold

### 目的

設計・DDLだけのrootへ、新実装の最小build / test基盤と責務境界を追加する。

### 作業

- package manifest、lockfile、runtime version policy
- TypeScript configとmain / worker / sharedのmodule boundary
- unit / contract test runner
- schema artifactをruntime / testから安全に解決する方法
- lint / format / typecheck / test script
- generated fileとruntime dataのignore policy

### Gate

- clean checkoutでinstall、typecheck、testが実行できる。
- `old/`のsourceやdependencyをcompile対象へ含めない。
- Main / Worker / shared contract間の循環依存がない。
- schema validatorが新test runnerから呼べる準備がある。

## S3: SQLite Bootstrap / Schema Verification

### 目的

`docs/design/sqlite-schema-lifecycle.md`をruntime bootstrapへ実装する。

### 作業

- DB pathと旧DBからの分離
- file不存在、空DB、中断初期化、現行、future / unknown DBの分類
- `schema/sqlite/v1.sql`適用
- application ID、user version、definition hash、table / index / trigger集合の検証
- encoding、foreign keys、secure delete、WAL、busy timeout、checkpoint設定のread-back
- bootstrap error codeと安全なdiagnostic
- migration runner interface。version 1ではmigration artifactを持たない

### Gate

- fresh DBを作成し、2回目の起動でDDLを再適用しない。
- identity mismatch、unknown schema、future versionをfile無変更で拒否する。
- bootstrap途中failure後に中途半端なschemaをcurrent扱いしない。
- Python validator相当の検証をproduction runtimeとtest runnerで再現できる。
- 旧DBを候補pathとして開かない。

## S4: Persistence Worker Lifecycle

### 目的

SQLite connectionとwrite ownershipをMain processから分離し、request lifecycleを確立する。

### 作業

- Worker start / ready / failed / closing / closed state
- version付きrequest / response protocol
- request ID、timeout、cancel、late response破棄
- single connectionまたはread / write connection構成の決定実装
- write queueとtransaction wrapper
- bounded read concurrency
- graceful shutdown、checkpoint要求、timeout後forced termination
- Worker crash時のin-flight request失敗と再起動policy

### Gate

- Main process / Renderer / CLIからSQLite driverをimportできないdependency guardがある。
- write順序がdeterministicで、同時writeがtransaction境界を跨がない。
- Worker crash時にin-flight requestを成功扱いしない。
- shutdown後に新規requestを受けず、未完了requestを明示失敗へ収束させる。
- large payload responseに上限とchunk / stream経路がある。

## S5: Repository Read Model

### 目的

CP2が必要とするreadを、N+1と巨大hydrateを避けたbounded queryとして提供する。

### Query候補

- Session header / keyset list
- Message timeline / ordinal cursor
- Run header、active / latest導出
- RunEvent follow / ordinal cursor
- RunOutput category count / summary page
- payload preview / chunk metadata
- child handle / delivery availability / result参照
- ProviderBinding / Attempt / Dispatch recovery projection

### Gate

- Session listがset queryでexecution stateを返し、N+1にならない。
- timelineがRunOutput payloadをjoinしない。
- summary listがBLOBを暗黙読込しない。
- cursor、limit、authorizationに必要な所属情報を返す。
- representative query planとlarge fixtureでbounded behaviorを確認する。

## S6: Repository Write Transactions

### 目的

設計済みdomain transactionを、型付きcommandと一貫したerrorへ落とす。

### Command group

1. Session create / lifecycle update。
2. Message + Run admission、normal / child / Auxiliary共通部分。
3. Attempt / creating Binding / Dispatch intent。
4. Provider correlation確定、dispatch resolution。
5. supplemental input delivery。
6. Run output item + payload。
7. Run terminal + final Message + child delivery availability。
8. collect delivery、idempotency completion。
9. explicit Session subtree deleteと関連cleanup。
10. startup repair command。

### Internal slice

- A: typed command / decoder / idempotency core、Session create / transition（完了）
- B: Run admission、Attempt / Binding / Dispatch、supplemental input（B1 通常Run admission、B2a Binding resolution完了）
- C: RunOutput、terminal、child result collect
- D: Session subtree delete、startup repair

### Gate

- 各commandのinput、output、domain error、conflict、retryabilityが型で定義される。
- cross-row不変条件を同じtransaction内で再検証する。
- persistence failureでProvider outcomeを別outcomeへ改変しない。
- idempotency keyの同一再送とconflictが一意に収束する。
- stored output itemとpayloadが同一commitになる。
- deleteがnon-terminal Runを検出した場合は全rollbackする。

## S7: Contract / Concurrency / Fault Tests

### 目的

正常系より先に、CP1が壊してはいけないstorage contractとfailure modeを自動化する。

### Test group

- schema / PRAGMA / definition drift
- FK、CHECK、partial unique、deferred cycle
- role、同一Session所属、ordinal、state transition
- admission / terminal / output / collect atomicity
- duplicate request / idempotency / response ref
- concurrent admission / write serialization
- payload quota / reserve / redaction / stored atomicity
- Worker crash、timeout、late response、shutdown
- bootstrap interruption、future / unknown DB refusal
- repair convergenceとambiguous dispatch非再送

### Gate

- `scripts/validate-sqlite-schema.py`の検証がtest runnerへ統合されるか、同等以上のTypeScript contract testへ置換される。
- failure injectionが未commit row、false success、double dispatchを残さない。
- testごとに一時DBを分離し、順序依存がない。
- snapshot更新でschema driftを黙認しない。

## S8: CP1 Integration Gate

### 目的

CP2へ渡すfoundationのpublic contractと運用可能性を最終確認する。

### 確認

- repository API review
- Main / Worker dependency boundary
- clean install test
- typecheck、lint、unit、contract、fault test
- Windows smoke test
- DB file / WAL / backupのcleanupとtest artifact確認
- performance baseline
- design docs、roadmap、questions、worklog同期

### CP1完了Gate

- parent roadmapのCP1 Gateをすべて満たす。
- materialなcorrectness / data-loss findingがない。
- 未実行testと残リスクがCP2の責務を変えない。
- `questions.md`が`質問なし`または`確認済み`である。
- CP2が利用するrepository APIとerror contractが文書化されている。

## Critical Path

```text
S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8
```

- S5のquery設計とS6のcommand型設計はS4のprotocol確定後に一部並行できる。
- S7のschema test統合はS3完了後に先行できるが、concurrency / crash testはS4〜S6を待つ。
- Persistence Worker / repositoryの責務変更が必要になった場合は、実装を広げる前に`docs/design/persistence-worker-repository.md`を作成または更新する。

## Plan運用

- slice開始時に本表と`worklog.md`を更新する。
- 実装前判断は`decisions.md`へ、user判断が必要なものは`questions.md`へ残す。
- 小さな実装sliceごとの追加Planは作らず、会話内checklistで進める。
- slice完了は成果物ではなくGateと検証結果で判定する。
- CP1完了時にparent roadmapをCP2へ進める。
