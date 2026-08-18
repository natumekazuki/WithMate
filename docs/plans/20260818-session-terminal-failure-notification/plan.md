# Session終端失敗通知 実装計画

## Goal / scope / authority

- `turn.run`と`turn.enqueue`で、明示した通常Session一件へ`failed`／`interrupted`通知Turnを既存FIFO queue経由で一度だけ登録する。
- public input、binding authority、source request snapshot、delivery persistence、terminal ordering、retry、public/GUI projection、CLI/MCP schema、migration、lifecycle、文書を一つの論理変更で整合させる。
- GUI composerからの設定、completed/canceled通知、複数target、暗黙target、自由入力prompt、専用provider/queue、Auxiliary/Companion、実provider接続は対象外とする。
- task/feature branchへのlocal編集、検証、通常commitまでを行う。pushとPR作成は行わない。

## Sources of truth

- ユーザーが提示した`TERMINAL-NOTIFY-01` accepted contractと添付Issue。
- `docs/adr/021-session-cli-mcp-application-boundary.md`と`docs/adr/021-agent-runtime-binding-authority-boundary.md`。
- `docs/design/session-external-runtime.md`、`docs/design/session-turn-storage-v6.md`、`docs/design/session-run-lifecycle.md`。
- shared type/runtime validator、SQLite schema/storage、execution/interaction/queue service、CLI/MCP schema、既存executable contract。

ADR 021の「terminal failureを別Sessionへ自動enqueueする機能は初期surfaceに含めない」は今回のaccepted contractより古い決定である。暗黙targetや専用queueを導入せず、明示設定されたfailed/interruptedだけを既存`turn.enqueue`へ接続する後継契約として、ADR本文を同じ論理変更で更新する。

## Closure Plan

### TN-AUTH-01 explicit input and authority

- Accepted contract / exact anchor: public inputはoptionalな`terminalFailureNotification.targetSessionId`だけを受け、binding actor、caller、parent、sourceから補完しない。同一source/target、target不存在・非対応、source snapshot解決不能を副作用前に拒否する。canonical replayは再解決より先に行う。
- Scope / semantic owner: shared runtime contractと`SessionExternalApplicationService`の`turn.run`／`turn.enqueue` mutation boundary。
- Failure mode / consumer impact: adapter差異、暗黙target、caller由来sender、replay後のcurrent state再検証によりCLI/MCP/HTTP callerが別executionまたは誤宛先を観測する。
- State transitions / failure timing: raw input validation → replay → current source/target/snapshot resolution → execution create。
- Direct verification: shared parser、application service integration、HTTP/CLI/MCP schema testでunknown field、pre-effect rejection、same/different target replayを観測する。
- Independent review trigger: binding authorityと複数adapterへ波及するためcomplete-diff review対象。
- Gate: ready。

### TN-SNAPSHOT-02 source request and recursion boundary

- Accepted contract / exact anchor: 新規source execution requestへtargetとsource Session character snapshotを保存し、通知executionには設定を付けない。legacy/GUI/設定なしへ推測しない。
- Scope / semantic owner: execution request parser/validatorとtrusted notification enqueue。
- Failure mode / consumer impact: source rename/delete後のsender変化、actor/target identityの誤使用、再帰notification storm。
- State transitions / failure timing: create → load → dispatch/retry → GUI message projection。
- Direct verification: request round-trip、invalid tuple rejection、snapshot保持、notification execution request absence、notification failure後のdelivery非生成を観測する。
- Independent review trigger: sender authorityと再帰防止をtargeted lensに含める。
- Gate: ready。

### TN-TERM-03 terminal commit ordering and observer isolation

- Accepted contract / exact anchor: failed/interrupted terminal commit後だけ配送を開始し、callbackはwake-upに留める。completed/canceledは`not_triggered`。notification failureでsource state/result/errorとinteraction expiryを巻き戻さない。
- Scope / semantic owner: `SessionExecutionService` terminal siblingsとnotification dispatcher reconciliation。
- Failure mode / consumer impact: commit前enqueue、callback lossで未配送、observer例外でterminal caller/interaction cleanup/queue drainが失敗する。
- State transitions / failure timing: running/queued → terminal commit → observer isolation → delivery reconcile → queue drain。restart/shutdown interruptを含む。
- Direct verification: normal failure、queue admission failure、restart/shutdown interrupt、callback loss、observer throw、interaction expiry独立性をservice/storage integrationで観測する。
- Independent review trigger: terminal orderingとshutdown interactionをcomplete-diff review対象にする。
- Gate: ready。

### TN-DELIVERY-04 durable effect, retry, and expiry

- Accepted contract / exact anchor: stable delivery/enqueue identity、durable pending claim、transaction外enqueue、pending/enqueued/failed、24時間deadline、5秒指数backoff最大5分、response loss/settle crash/restart収束、permanent failure分類。
- Scope / semantic owner: notification delivery table/storage/serviceと既存trusted enqueue boundary。
- Failure mode / consumer impact: duplicate Turn、lost notification、in-memory-only retry、deadline超過retry、target削除後の無限retry、source terminal mutation。
- State transitions / failure timing: terminal source → pending → claimed pending → enqueued/failed または released pending。enqueue response loss、settle failure、process restartを区別する。
- Direct verification: storage/service integrationでstable identity、claim、same-key replay、response loss、settle failure、restart claim recovery、queue full、target deletion、deadline、backoff、shutdown cleanupを観測する。
- Independent review trigger: persistence、external side effect、retry lifecycleのためcomplete-diff review対象。
- Gate: ready。

### TN-PROMPT-05 safe projection

- Accepted contract / exact anchor: canonical projectorはpublic source execution projectionと保存済み参照だけを入力とし、許可fieldだけを通知promptへ含める。
- Scope / semantic owner: pure notification prompt projector。
- Failure mode / consumer impact: raw result、stack、credential、system prompt、workspace path、private audit dataがtarget provider/userへ漏れる。
- State transitions / failure timing: durable source read → public projection → prompt → trusted enqueue。
- Direct verification: forbidden sentinelをraw request/resultへ入れ、promptに許可値だけが現れるunit testを置く。
- Independent review trigger: private data disclosure lensをcomplete-diff reviewに含める。
- Gate: ready。

### TN-PROJ-06 public and GUI projection

- Accepted contract / exact anchor: null/armed/not_triggered/pending/enqueued/failedを同じpublic executionへ投影し、run/enqueue/get/list、CLI/MCP/HTTPで一致させる。source terminal error UIに状態を追加し、targetは既存message listとsource snapshotを使い、Session由来queued Turnはcancel不可とする。
- Scope / semantic owner: shared public projector、MCP output schema、GUI execution/message/retry projection。
- Failure mode / consumer impact:入口ごとの状態差、private retry detail漏えい、専用card/badge増殖、sender avatar欠落、GUI cancel可能化。
- State transitions / failure timing: create/terminal/delivery update → public projection/IPC refresh/message list。
- Direct verification: projector/app service/MCP contract、GUI component/projection test、既存queued FIFO/cancel test、分離起動visual check。
- Independent review trigger: public/GUI cross-subsystem interactionをcomplete-diff review対象にする。
- Gate: ready。

### TN-MIGRATE-07 supported V6 migration

- Accepted contract / exact anchor: supported旧DBのempty/populated migration、再実行、途中失敗時のatomicityを維持する。
- Scope / semantic owner: `ensureV6Schema`内のnotification delivery table/index追加とschema validation。
- Failure mode / consumer impact:既存execution消失、partial table/index、再実行失敗、invalid DBをvalid扱いする。
- State transitions / failure timing: old schema → savepoint migration → validation / rollback。
- Direct verification: fresh/empty/populated/repeated ensure、malformed partial schema rejectionとrollback、foreign key/index validationをDB testで観測する。
- Independent review trigger: migration/data-loss lensをcomplete-diff review対象にする。
- Gate: ready。

## Closure Map / Sibling Sweep

| Invariant | Canonical owner | Siblings in scope | Excluded siblings | Material failure points / direct checks |
| --- | --- | --- | --- | --- |
| TN-AUTH-01 | shared parser + application service | run/enqueue、raw HTTP、CLI、MCP、same/different-key replay | GUI composerはconfig作成対象外 | unknown input、same target、missing/unsupported target、snapshot missing、replay-before-resolve |
| TN-SNAPSHOT-02 | execution request contract | create/load/dispatch/retry/message projection | legacy/GUIはabsenceをnotificationなしとして読む | tuple欠落、不正sender、notification executionへの再付与 |
| TN-TERM-03 | execution terminal service | normal complete/fail/cancel、queue admission fail、restart/shutdown interrupt、interaction expiry | provider固有terminal callback | commit前effect、callback loss/throw、queue drain阻害 |
| TN-DELIVERY-04 | delivery storage/service | pending claim、enqueue、settle、response loss、restart、deadline、shutdown | schedule table/stateは別domain | duplicate/loss、stale claim、backoff、permanent/transient分類 |
| TN-PROMPT-05 | pure projector | failed/interrupted、public error/reason/timestamp/ref | completed/canceled、raw request/result/audit/provider | forbidden sentinel disclosure |
| TN-PROJ-06 | shared execution projector | run/enqueue/get/list、CLI/MCP/HTTP、source retry banner、target message/FIFO/cancel | 専用管理画面/card/transport badge | state mismatch、private detail leak、identity/cancel regression |
| TN-MIGRATE-07 | V6 schema owner | fresh、old empty/populated、re-run、rollback、validation | DB major-version migration | data loss、partial schema、invalid acceptance |

Sibling Sweepでは`terminalFailureNotification`、`request_json`、`onExecutionTerminal`、`interruptRunning`、`projectSessionExecution`、`turn.run`、`turn.enqueue`、`listSessionTurnExecutions`、`SESSION_RUNTIME_*_SCHEMA_VERSION`を検索語にし、type/schema/validator/storage/service/adapter/UI/docs/testの同一Invariant familyを確認する。

## Test Design Gate

| Failure mode | Contract / consumer | Canonical owner / observable | Check layer | Distinctness |
| --- | --- | --- | --- | --- |
| target fallbackまたは副作用後validation | TN-AUTH-01 / CLI・MCP・HTTP caller | application serviceのexecution create有無とerror | integration | parserだけではreplay/side effect順を検出できない |
| targetだけ変えたsame-key retry | TN-AUTH-01 / caller | idempotency execution IDまたはconflict | storage/application integration | field validationではfingerprint欠落を検出できない |
| snapshot欠落・再帰設定 | TN-SNAPSHOT-02 / source・target Session | persisted request tuple | parser/storage integration | UI表示だけではcanonical requestを保証できない |
| commit前enqueue/callback loss | TN-TERM-03 / source・target Session | source terminal rowとdelivery/enqueue effect順 | service integration | callback call-countではdurable recoveryを検出できない |
| response loss/settle crash/restart duplicate | TN-DELIVERY-04 / target queue | delivery rowとnotification execution ID | storage/service integration | pure key unit testではeffect収束を検出できない |
| backoff/deadline/permanent分類 | TN-DELIVERY-04 / runtime operator | attempt/nextAttempt/deadline/state/errorCode | fake-clock service integration | real timer testより決定的で直接的 |
| forbidden data disclosure | TN-PROMPT-05 / target Session | generated prompt text | unit | provider mock call-countでは内容漏えいを保証できない |
| public channel mismatch | TN-PROJ-06 / adapter consumer |同じexecutionのprojection | projector/application/MCP contract |各adapter単独fixtureではshared ownerの差を検出しにくい |
| source/target GUI回帰 | TN-PROJ-06 / GUI user | retry banner status、message initiator、FIFO、cancel absence | component/projection + visual | DOM snapshotを使わずsemantic label/controlを観測する |
| migration partial/data loss | TN-MIGRATE-07 / existing install | table/index/FK、既存row、rollback | SQLite integration | fresh schema testだけではupgradeを検出できない |
| timer/listener残留 | TN-DELIVERY-04 / app shutdown | tracked timer clearとpost-shutdown no-attempt | fake timer/service integration | process終了だけではowner leakを特定できない |

各candidateはproduction ownerのno-op、wrong target、unstable key、raw payload混入、settle省略のいずれかで失敗し、rename/helper抽出/内部call順の変更では失敗しないobservableへ置く。

## Validation and review

- Targeted: notification request/storage/service/projector/application、execution terminal siblings、runtime contract、HTTP、CLI、MCP、GUI projection、migration。
- Required: `npm run typecheck`、`npm test`、`npm run build`。
- Visual: `scripts/start-withmate-visual-check.ps1`でsource failureのpending/enqueued/failed、target character表示、busy target FIFOを確認する。実provider接続は行わず、必要ならfailure injection/fixtureで状態を作る。
- Full-review gate: run。public API、binding authority、migration、external enqueue effect、retry lifecycle、GUI projectionのcross-subsystem interactionはtargeted checkだけでは一括反証できない。
- Reviewは実装とrequired checkをcommitした`reviewCommitOid`のclean detached worktreeで一度だけ行う。findingはTN-* Invariant familyへPromotionし、`current-scope repair`だけを修正する。

## Open questions

- なし。ADR 021の旧「初期surface外」記述は今回の後継accepted contractへ更新する。
