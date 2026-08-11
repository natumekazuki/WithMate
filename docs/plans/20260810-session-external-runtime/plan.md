# Plan

- 作成日: 2026-08-10
- タスク: Session External Runtime の実装
- 状態: Complete

## Goal

- 通常SessionをGUIと同じapplication boundary上でCLIまたはMCPから操作できるようにする
- executionをSession、Turn監査record、Messageとは独立したidentityとして永続化する
- `turn.run`の即時実行と`turn.enqueue`のSession単位FIFO queueを、再起動後も一貫する契約として提供する

## Accepted Contract Anchors

- `docs/adr/021-session-cli-mcp-application-boundary.md`
- `docs/design/session-external-runtime.md`
- 2026-08-10のユーザー合意: queueはSession単位、待機中executionは最大10件、active/running executionは上限へ含めない

exact request、response、error、状態遷移、limitは、実装時に追加するshared type、validator、storage contract testを正本とする。

## Scope

- executionのshared typeとpublic projection
- execution、FIFO queue、idempotency recordのSQLite永続化
- Session application serviceへの`turn.run`、`turn.enqueue`、`turn.get`、`turn.list`、`turn.cancel`統合
- process restart時のexecution reconciliation
- Session専用loopback runtime、discovery、credential
- CLI adapterとMCP adapter
- 関連するtargeted test、typecheck、build

## Out Of Scope

- GUI composerからのqueue投入
- scheduleによる将来実行
- terminal failureの自動通知
- binary upload
- MCP Tasks capabilityへの投影
- 異なるSessionを横断するglobal queueまたは固定並列数上限

## Pre-Implementation Closure Plan

- Gate: `ready`
- Canonical owner: Electron Main ProcessのSession application serviceとexecution storage
- Sibling entries: GUI IPC、Session CLI、Session MCP
- Persistence strategy: `session_turns_v6`を拡張せず、executionとidempotencyの専用tableを追加する
- Migration strategy: additive `CREATE TABLE IF NOT EXISTS`を`ensureV6Schema`のsavepoint内で適用する。既存rowのbackfillは不要
- Failure projection: application error codeをshared contractで定義し、transport adapterは意味を変更せず変換する

### Invariant Matrix

| ID | Invariant | Scope / owner | Failure mode | Consumer impact | Direct verification |
| --- | --- | --- | --- | --- | --- |
| Q-01 | 一つのSessionが保持できる待機中executionは最大10件で、active/runningは数えない | execution storageのenqueue transaction | 10件存在時に11件目を永続化する、またはidempotency effectだけ残す | callerが`QUEUE_FULL`後に存在しないはずのexecutionを観測する | storage contract testで10件成功、11件目`QUEUE_FULL`、execution/idempotency件数不変を確認 |
| E-01 | 一つのSessionでactive executionは最大1件で、`turn.run`はbusy時にqueueへ変換しない | Session application serviceとadmission transaction | sibling入口の競合で二重dispatchする | 同一Sessionの履歴とprovider side effectが競合する | concurrent admission testとservice testで一方のみrunning、他方`SESSION_BUSY`を確認 |
| E-02 | `queued`から`running`へのadmissionを永続化してからproviderへdispatchする | execution registry | dispatch後もqueuedのまま残り再dispatchされる | provider side effectが重複する | dispatch spyとstorage read-backで順序を確認 |
| E-03 | 起動時にadmit済み非terminal executionを`interrupted(runtime_restarted)`へ収束してからFIFOを再開する | startup reconciliation | 不明なprovider effectを自動再実行する | 重複実行またはqueue停止 | recovery testでrunningを再dispatchせずinterruptedへ収束し、次のqueuedのみadmitすることを確認 |
| I-01 | idempotencyはoperationとkeyで分離し、同一fingerprintはcanonical result、異なるfingerprintはconflictへ収束する | application serviceとidempotency storage | retryで別executionを作る、またはrun/enqueueを混同する | callerが重複side effectを起こす | operation別retry、fingerprint conflict、restart後retryのcontract test |
| P-01 | public projectionはexecutionの追跡情報だけを返し、credential、provider raw payload、private pathを含めない | shared response typeとadapter | internal rowやErrorのspreadでprivate fieldが漏れる | CLI/MCP callerへsecretまたは内部情報が露出する | projection unit testとCLI/MCP response contract test |
| C-01 | cancelはSession ID、execution ID、現在stateを組で検証し、queuedはterminal canceled、runningはabort requestへ移る | application service | 別Sessionのexecutionをcancelする、terminalを再変更する | unrelated executionの停止または履歴破壊 | owner mismatch、queued cancel、running cancel、terminal replayのservice test |
| A-01 | Session runtimeはloopbackだけでlistenし、CLI/MCP別credentialとruntime identity challengeの両方を検証してからoperation bodyをapplication serviceへ渡す | Session loopback runtimeとdiscovery | staleまたは差し替え済みruntimeへmutation bodyを送る、別adapterのcredentialで操作する | 意図しないprocessまたはauthorityでSession操作が実行される | loopback host制約、challenge、adapter credential分離、service未呼出しをHTTP contract testで確認 |
| B-01 | loopback JSON request bodyはUTF-8で8 MiBをhard maximumとし、超過時はparseとapplication service呼出し前に拒否する | Session HTTP server | caller指定で上限を拡張する、または巨大bodyをserviceへ渡す | memory pressureまたは意図しない副作用が発生する | 境界値と超過bodyのHTTP contract testで413、`not_applied`、service未呼出しを確認 |
| V-01 | 公開operationはversioned validatorでobject shape、required field、unknown field、response modeとpagination limitをservice呼出し前に検証する | shared Session runtime contract | malformed inputをinternal castで受理する、`turn.enqueue`へresponse modeを渡す、limitを暗黙に丸める | adapter間で異なる入力が受理される、または副作用開始後にvalidation failureとなる | operation別validator testとHTTP contract testでstable error、service未呼出しを確認 |
| P-02 | public success/error projectionはallowlistで構築し、request、credential、raw Error、stack、database detail、private pathを含めない | shared response contractとSession HTTP server | internal objectやErrorをspreadして返す | CLI/MCP callerへsecretまたは内部情報が露出する | success/error projection testで許可fieldだけを確認 |
| L-01 | discoveryはSession専用schemaとcredentialでatomicに公開し、startup failureとstopは自分のgenerationだけを除去して新しいruntimeの公開を壊さない | Session runtime lifecycle | 部分公開、Memory discoveryとの共有、旧runtime停止による新runtime discovery削除 | CLI/MCPが不完全、誤domain、または停止済みruntimeへ接続する | publication failure cleanup、owner-safe cleanup、Memory discoveryとのpath/schema分離をruntime testで確認 |

### Failure Timing Coverage

- enqueue validation前、queue admission transaction中、commit直後、response loss後のretry
- `queued` commit後かつadmission前のcrash
- `running` commit後かつprovider dispatch前または実行中のcrash
- cancelとadmissionの競合
- terminal persistenceと次queue admissionの間のfailure
- Session削除時のexecutionとidempotency cleanup

### Public Surface Coverage

- shared TypeScript typeとruntime validator
- application service result/error
- loopback JSON endpoint
- CLI JSON/text outputとexit code
- MCP tool schema、structured result、tool error mapping

### Review Gates

- Persistence、concurrency、resource limit、public APIを変更するため`contract-closure`対象とする
- storage slice完了後、Q-01、E-01、E-02、I-01をtargeted checkで直接検証する
- startup reconciliation完了後、E-03を含むpersistence/concurrency lensの独立targeted reviewを行う
- public runtimeとadapter完了後、P-01を含むauthority/projection lensの独立targeted reviewを行う
- Slice 4はA-01、B-01、V-01、P-02、L-01を同じpublic boundary Candidateとして固定し、HTTP/runtimeのdirect check後にauthority/projection lensの独立targeted reviewへ渡す
- Full-review gateは統合後のcross-subsystem interactionを直接検証できない場合に限り`run`とし、それ以外は`skip`とする

## Slices

1. [完了] execution shared contract、SQLite schema、storageを追加し、Q-01とI-01の直接testを通す
2. [完了] execution registryとSession application serviceを追加し、E-01、E-02、C-01を直接testで閉じる
3. [完了] startup reconciliationをcomposition rootへ統合し、E-03とFIFO継続を直接testで閉じる
4. [完了] loopback runtime、discovery、credential、public validatorを実装する
5. [完了] CLI adapterを実装し、JSON contractとexit codeを検証する
6. [完了] MCP adapterを実装し、tool schemaとstructured resultを検証する
7. [完了] typecheck、関連test、build、必要なsmoke、contract closure、review gateを完了する

各sliceはsource、適用可能なexecutable contract、targeted checkが揃うまで完了扱いにしない。

## Validation

- storageとapplication serviceのtargeted Node tests
- schema作成、既存V6 databaseへのadditive適用、Session削除cascadeのtest
- restart reconciliationと競合条件のtest
- CLI process contract test
- MCP tool contract test
- `npm run typecheck`
- `npm run build`
- 変更範囲に応じた`npm test`

## Open Questions

- なし。実装中にaccepted contract、owner、scope、consumerが変わる場合は、このplanのGateを再判定する。

## Slice 4 Candidate Evidence

- Candidate: `session-public-runtime-c3`
- Invariants: A-01、B-01、V-01、P-02、L-01
- Direct checks:
  - Session public runtime contract tests and finding regressions: 16 passed
  - Session executionを含むtargeted integration tests: 98 passed
  - `npm run typecheck`: passed
  - `npm run build`: passed
- Structure convergence gate: `ready-unchanged`。Session public contract、HTTP transport、application mapping、discovery lifecycleのsemantic ownerは各moduleへ分離され、canonical boundaryの迂回またはslice間のdecision重複を示すevidenceはない
- Review contract: authority/lifecycle lensはA-01、B-01、L-01、validation/projection lensはV-01、P-02を確認する。CLI/MCP adapter固有の表示、exit code、MCP schemaは後続sliceのscopeとする
- Specialist review on Candidate c2:
  - L-01: Electronの`will-quit`が非同期cleanupを待たない指摘を`current-scope repair`へ分類した。quit barrierでcleanup完了まで終了を抑止し、完了後だけ再度quitする
  - V-01/P-02: application serviceがruntime validationを所有せずunknown operationをcancelへfall throughし得る指摘を`current-scope repair`へ分類した。service入口でversioned envelopeを再検証し、operation分岐を明示的に閉じる
  - A-01/B-01の追加HTTP反例、raw Error projection、symlink rejectionは現行sourceのblocking違反を示す証拠がなく、今回のCandidateを拡張しないvalidation gapとして扱う
  - Candidate c3のtargeted closureで両finding familyをclosedと確認した
- Full-review gate: `skip`。このCandidateのcross-boundary contractはHTTP/runtime/applicationのdirect checkと二つのtargeted specialist lensで直接確認でき、complete-diff holistic reviewを必要とする未確認interactionはない

## Slice 5 Pre-Implementation Closure Plan

- Gate: `ready`
- Canonical owner: `withmate-session` CLI adapterとSession runtime client
- Accepted surface: `turn run|enqueue|list|get|cancel`、`status`、`schema`
- Input: operation commandは`--json`、`--file`、`--stdin`のいずれか一つからoperation input objectを受け取る
- Output: 既定のJSON modeはmachine-readableなversioned JSON documentをstdoutへ一件だけ出力する。`--format text`は人向けの要約だけをstdoutへ返し、どちらにも診断ログやstackを混ぜない

| ID | Invariant | Scope / owner | Failure mode | Consumer impact | Direct verification |
| --- | --- | --- | --- | --- | --- |
| CLI-01 | mutation bodyを送る前にdiscoveryのruntime identity challengeを検証し、mismatchまたは接続不能ではoperation requestをdispatchしない | Session runtime client | staleまたは差し替え済みruntimeへmutationを送る | 意図しないprocessへSession操作が到達する | runtime client contract testでchallenge mismatch時にoperation requestが0件であることを確認 |
| CLI-02 | CLIの既定JSON modeはsuccess、application error、local errorのいずれもstdoutへ一つのversioned JSON documentとして返し、raw Error、stack、credentialを含めない。text modeは同じpublic projectionから人向け要約だけを作る | CLI output adapter | stderrや複数JSONへ機械判定情報が分散する、内部情報をspreadする | agentが結果をparseできない、またはsecretが露出する | CLI process contract testでstdout行数、schema、allowlist、text modeのcredential非露出を確認 |
| CLI-03 | exit codeはsuccess=0、usage/validation=1、runtime未起動またはidentity不一致=2、application error=3、dispatch後transport failure=4へ安定して写像する | CLI exit mapping | message解析またはHTTP statusごとに不定なcodeを返す | callerがretryと入力修正を誤る | CLI contract testで各failure classとexit codeを確認 |

### Slice 5 Candidate Evidence

- Candidate: `session-cli-c4`
- Invariants: CLI-01、CLI-02、CLI-03
- Direct checks:
  - CLI runtime client、process contract、package config tests: 11 passed
  - `npm run typecheck`: passed
  - `npm run build:session-cli`: passed
  - `git diff --check`: passed with line-ending warnings only
- Structure convergence gate: `ready-unchanged`。runtime discoveryとHTTP exchangeはruntime client、argument parsingとoutput/exit mappingはCLI entry、distributionはbuild scriptとpackage configへ分離され、semantic ownerの分散やcanonical boundaryの迂回を示すevidenceはない
- Review contract: authority lensはCLI-01、projection/adapter lensはCLI-02とCLI-03を確認する。MCP schemaとtool mappingはSlice 6のscopeとする
- Full-review gate: `skip`。CLIとruntimeのinteractionはidentity mismatchと実runtimeへのauthenticated operationをprocess contract testで直接確認でき、complete-diff holistic reviewを必要とする未確認interactionはない
- Specialist review on Candidate c4:
  - identity-security-ipc lensはCLI-01をblocking findingなしでapproveし、独立実行したCLI test 10件もpassした
  - contract-schema-projection-adapter lensはCLI-02とCLI-03をblocking findingなしでapproveした。認証済みruntimeがpublic response contractへ違反した場合のshape rejectionはhardening候補、identity mismatchとtop-level exit 2の組合せおよびtext error表示の個別testはvalidation gapとして現Candidateを拡張しない

## Slice 6 Pre-Implementation Closure Plan

- Gate: `ready`
- Canonical owner: Session MCP adapter。application operationのvalidation、execution状態、public projectionは既存Session application serviceとshared runtime contractを正本とする
- Sibling entries: Session CLI、Session HTTP runtime、GUI IPC
- Failure projection: MCP protocol envelope/schema failureとapplication/tool execution failureを分け、application errorは共通のversioned errorを`structuredContent`へ置いて`isError: true`とする
- Authority: MCP adapter専用generationとcredentialを使い、runtime identity確認後だけoperation bodyをdispatchする。MCP serverはCLI processを起動しない

### Slice 6 Invariant Matrix

| ID | Invariant | Scope / owner | Failure mode | Consumer impact | Direct verification |
| --- | --- | --- | --- | --- | --- |
| MCP-01 | MCP serverはMCP専用discovery generationとcredentialを使い、runtime identity challengeの一致後だけoperation bodyをdispatchする | Session runtime clientとMCP adapter | CLI credentialを流用する、またはstale runtimeへmutation bodyを送る | caller権限の混同または意図しないprocessへの副作用 | MCP client contract testでadapter分離とidentity mismatch時のoperation request 0件を確認 |
| MCP-02 | 公開toolはapplication operationと同じdotted nameとstrict input schemaを持ち、application errorをversioned structured resultかつ`isError: true`へ写像する。terminal `failed` executionは受付済みresultなのでtool errorへ変換しない | Session MCP tool registryとoutput projection | toolごとに入力やerror semanticsが分岐する | agentがprotocol failure、受付失敗、terminal failureを誤判定する | MCP tool contract testでtool schema、success、application error、terminal failed resultを確認 |
| MCP-03 | runtime接続不能またはidentity mismatchは`not_applied`、mutationのdispatch後transport failureだけは`indeterminate`として返し、raw Error、stack、credentialを公開しない | Session MCP transport failure mapping | retry可能性と副作用状態をmessage解析へ依存する、または内部情報を返す | callerがmutationを重複実行する、またはsecretが露出する | MCP contract testでpre-dispatch、post-dispatch、read failureのeffectとallowlistを確認 |

- ADR gate: ADR 021の既存decision内であり追加ADRは不要
- Architecture document gate: 現行設計の操作名とerror mappingを実装する。sourceから復元可能なtool schemaは設計書へ複製しない
- Structure convergence trigger: CLI/MCP間でdiscoveryとexchangeのownerが重複する場合だけ共通runtime clientへ収束する
- Review trigger: MCP-01はauthority boundary、MCP-02/MCP-03はpublic projectionとfailure timingを持つため、implementation-complete Candidateを二つのtargeted specialist lensへ一度渡す
- Candidate c5 specialist finding promotion:
  - MCP-02の文字列schemaが空白だけの値をprotocol validationで拒否せず、shared application validatorまでdispatchする指摘は、accepted contractへの到達可能な違反であり`current-scope repair`に分類する
  - semantic ownerはSession MCP tool schemaのまま変わらず、別subsystemまたはboundary prerequisiteへscopeを広げない
  - MCP文字列schemaをtrim後の非空へ統一し、protocol rejection時にruntime dependencyが呼ばれないdirect testで閉じる

### Slice 6 Candidate Evidence

- Candidate c5:
  - Session MCP contract tests: 7 passed
  - authority specialist: blocking findingなし。MCP専用generation、credential、identity-before-dispatchを確認
  - projection specialist: MCP-02の空白文字列validation parityを`current-scope repair`として指摘。MCP-03はblocking findingなし
- Candidate c6:
  - Session MCP contract tests: 8 passed
  - CLI、MCP、package contract tests: 20 passed
  - `npm run typecheck`: passed
  - `npm run build:session-cli`: passed
  - F-MCP02-WHITESPACE targeted closure: closed。全MCP非空文字列をtrim後の非空schemaへ統一し、protocol rejection時のruntime呼出し0件を確認
  - authority delta non-impact: approved。MCP discovery、credential selection、identity-before-dispatchへ影響なし
- Related Session integration tests: passed
- `npm run build`: passed with existing Vite chunk-size warnings only
- `npm test`: 2358 tests、2357 passed、1 skipped、0 failed
- `git diff --check`: passed with line-ending warnings only
- Structure convergence gate: `ready-unchanged`。CLIとMCPは共通runtime clientへ収束し、tool schemaとtransport projectionはMCP adapterに凝集している。新しいsemantic owner分散、canonical boundary迂回、test couplingのevidenceはない
- Full-review gate: `skip`。MCPのauthorityとprojection/failure timingは二つのspecialist lensで確認し、finding familyはtargeted closure、他lensへのdelta非影響も確認済み。complete diffにtargeted checkで直接検証できない新しいcross-cutting interactionは残っていない
- Non-blocking validation gap: MCP credentialのpositive pathを実HTTP runtimeへ結合した単一testはない。sourceと既存runtime/MCP contract testでcredential分離を確認済みで、現行違反の証拠はないため現Candidateを拡張しない

## Holistic Review Finding Closure Plan

- Gate: `ready`
- Review lifecycle: master merge-baseからのcomplete diffに対するholistic reviewはCandidate `session-external-runtime-holistic-c2-master`で一度実施済み。修正後は新Candidateのdirect checkとfinding family限定のtargeted closureで閉じ、complete diffを再探索しない
- Accepted CLI exit mapping: CLI-03はsuccess=0、usage/validation=1、runtime未起動またはidentity不一致=2、application error=3、dispatch後transport failure=4。旧Review Briefの異なる対応表はaccepted contractではない

| ID | Invariant | Scope / owner | Failure mode | Consumer impact | Direct verification |
| --- | --- | --- | --- | --- | --- |
| RT-01 | 外部turnのmodel、reasoning effort、approval、sandbox指定をprovider実行へ反映し、保存済みSession既定値は変更しない | Session runtime service | validationだけにoverrideを使いproviderへ保存済み設定を渡す | caller指定より広い権限または異なるmodelで実行される | runtime service testでprovider入力と保存値の非変更を確認 |
| ID-01 | 同一operation、key、fingerprintのreplayは現行catalog revision検証より先にcanonical executionへ収束する | Session application serviceとexecution service | catalog更新後のretryをstaleとして拒否する | response loss後のretryが既存結果を取得できない | application service testでcatalog更新後のcanonical replayを確認 |
| ID-02 | `turn.cancel`もoperation、key、fingerprintで永続idempotencyを持つ | execution storageとservice | response loss後のcancel retryが別mutationとして扱われる | callerがeffect certaintyを回復できない | queued/running cancel replay、schema migration、CLI/MCP input contract test |
| LC-01 | quit admissionをstorage closeより先に閉じ、listener停止、discovery cleanup、store closeの順で終了する | app lifecycleとruntime quit barrier | shutdown競合窓で新規dispatchまたはstore再生成が起きる | 終了中にprovider effectまたは永続化破損が起きる | lifecycle、quit barrier、runtime stop orderのtest |
| PG-01 | `turn.list`はstorage keyset paginationを使い、全履歴hydrateとoffset cursorを行わない | execution storageとapplication service | 履歴全件をparseし、並行追加でページ重複または欠落する | 長期利用でresource使用量とpagination不整合が増える | storage page queryとapplication cursor contract test |
| ER-01 | provider dispatch前のSession validation failureはstable domain codeと`not_applied`を返す | Session turn validation errorとapplication mapping | generic runtime unavailable / indeterminateへ潰れる | callerが安全な入力修正とretry判断をできない | domain error mapping test |

### Finding Repair Evidence

- Candidate `session-external-runtime-final-c3`のtargeted closureで、次の二件を`current-scope repair`として追加確認した
  - ID-02: Sessionごとのlockだけでは、異なるSessionから同一cancel keyを並行使用した際に両方のabort effectが先行できた。`turn.cancel`のoperation+key lockをsession lockの外側へ置き、異なるfingerprintの要求をabort前にconflictへ収束させる
  - LC-01: 外部application admissionだけを閉じても、running completion後のqueue drainが次のprovider dispatchを開始できた。execution serviceのdispatch admissionを同時に閉じ、completion drainと`resumeQueue()`の両入口で新規admissionを止める
- 上記の直接反例としてcross-Session cancel競合、shutdown後のqueued non-admission、SQLite keyset page query、terminal cancel replayをexecutable contractへ追加した
- Finding regression set: 112 passed、0 failed
- `npm run typecheck`: passed
- `npm test`: 2368 tests、2367 passed、1 skipped、0 failed
- `npm run build`: passed。既存のVite pseudo-element warningとchunk-size warningのみ
- `git diff --check`: passed with line-ending warnings only
- Structure convergence gate: `ready-after-consolidation`。application mappingがruntime service実装へerror typeのためだけに依存する逆向き境界を、`session-turn-validation-error.ts`のstable ownerへ移した。移動後にfinding regression setとtypecheckを再実行してGreenを確認した
- Hardening exclusions: stale discovery pointerの条件付き削除とCLI runtime client response body上限は、現行accepted contractへの到達可能な違反が確認されていないため本修正へ含めない
- Remaining validation gaps: `npm run dist:win`、インストール済みalias、live ElectronでのCLI/MCP E2Eは未実施

## Holistic Review Additional Finding Closure Plan

- Gate: `ready`
- Finding Promotion:
  - A-01の本人確認後に別接続へcredentialとoperation bodyを送る経路は、loopback port差し替えでsecretとmutationが到達する再現証拠があり、同じSession runtime exchange owner内の`current-scope repair`とする
  - RL-01のinline response無制限経路は、ADR 021の上書き不能なhard size limitへ違反し、shared response contract、HTTP server、CLI/MCP共通clientで閉じる`current-scope repair`とする
  - KP-01のdocumentation map分類は、Accepted ADRとActive designの状態に反してcurrent authorityを誤案内するため、同じ設計情報配置scopeの`current-scope repair`とする
- Sibling Sweep: A-01はCLI/MCPが共有するruntime clientとHTTP exchange、RL-01は単一execution projection、list aggregate、HTTP serialization、CLI/MCP受信、KP-01は同じ文書のstatusとmap entryを対象とする。Memory runtime、SessionFolder export、installerは対象外とする

| ID | Invariant | Scope / owner | Failure mode | Consumer impact | Direct verification |
| --- | --- | --- | --- | --- | --- |
| A-01 | Session runtimeは同一HTTP exchange上でruntime identity challengeを証明した後だけcredentialとoperation bodyを送受信し、challenge前または接続切断後にsecret-bearing payloadを再送しない | Session runtime exchange、HTTP server、CLI/MCP共通client | status確認後にport所有者が差し替わり、別接続へcredentialとmutationを送る | API secret、adapter secret、操作本文が意図しないprocessへ漏れる | port差し替え反例でreplacement request 0件、challenge前header/bodyにsecretがないことを確認し、実runtimeへのpositive pathも確認 |
| RL-01 | public inline textとloopback JSON responseはUTF-8で8 MiBの上書き不能なhard maximumを共有し、serverは超過successを`CONTENT_TOO_LARGE`へ置換し、clientは上限超過を全量buffering前に拒否する | shared Session runtime contract、public projection、HTTP server、runtime client | assistant textまたはlist aggregateを無制限にserialize・bufferする | ElectronまたはCLI/MCP processのmemory使用量が入力件数とresult sizeで無制限に増える | projection境界、HTTP aggregate response、client受信上限のcontract testでstable errorとbounded rejectionを確認 |
| KP-01 | documentation mapはAccepted ADR 021とActiveな`session-external-runtime.md`をcurrent source-of-truthとして案内する | `docs/design/documentation-map.md` | active designをFuture Draftとして分類する | maintainerがcurrent contractを非正本と誤認する | status headerとdocumentation map entryの整合をdiffで確認 |

- ADR gate: A-01とRL-01はAccepted ADR 021の既存decisionを実装するため追加ADRは不要
- Architecture document gate: `session-external-runtime.md`のActive statusとexact limitの正本配置は維持し、documentation mapだけをcurrent分類へ修正する
- Review lifecycle: complete-diff holistic reviewは既に一度実施済み。修正後は現Candidateのdirect checkとこのfinding family限定のfresh-context second passで閉じ、二度目のholistic reviewは行わない

### Additional Finding Repair Evidence

- Candidate: `session-external-runtime-final-c7`
- Direct checks:
  - A-01、RL-01、KP-01のtargeted regression set: 40 passed、0 failed
  - `npm run typecheck`: passed
  - `npm run build`: passed。既存のLightning CSS pseudo-element warningとVite chunk-size warningのみ
  - `npm test`: 2402 tests、2401 passed、1 skipped、0 failed
- A-01 closure: identity challengeとsecret-bearing payloadを同一HTTP exchangeへ統合した。port差し替え反例ではreplacement requestが0件で、challenge前のheaderとbodyにAPI secret、adapter secret、operation bodyが含まれないことを確認した
- RL-01 closure: inline text、public response、client受信に共有の8 MiB上限を適用し、single resultとlist aggregateの超過をstable `CONTENT_TOO_LARGE`へ収束させた。clientはdeclared sizeとstreamed sizeの双方を全量buffering前に拒否する
- KP-01 closure: `session-external-runtime.md`をcurrent source-of-truthへ移し、Accepted ADR 021とActive designのstatusをdocumentation map上で一致させた
- Structure convergence gate: `ready-unchanged`。identity challengeとpayload送信はshared exchange、response上限はshared contractと共通client readerへ収束しており、新しいsemantic owner分散、canonical boundary迂回、slice間decision重複を示すevidenceはない
- Candidate c7 targeted closure: A-01とKP-01はclosed。RL-01はlist aggregateの取得境界にblocking findingが残り、Candidate c8の修正対象へ昇格した
- Remaining validation gaps: `npm run dist:win`、インストール済みalias、live ElectronでのCLI/MCP E2E、生成bundle内の第三者依存を含む全行の手動意味reviewは未実施

### Additional Finding Targeted Closure

- Candidate `session-external-runtime-final-c7`のtargeted closureで、A-01とKP-01はclosed、RL-01はlist aggregateのbyte budget適用前に`listPage(limit + 1)`が全recordをhydrateする反例を`current-scope repair`として確認した
- RL-01のsemantic ownerはexecution storageのpage retrievalとapplication projectionのまま変わらず、別subsystemまたはboundary prerequisiteへscopeを広げない
- Candidate `session-external-runtime-final-c8`ではstorage page retrievalをlazy iteratorへ変更し、application projectionがresponse budget超過を検出した時点で後続recordの取得とJSON parseを停止する
- Final direct checks:
  - A-01、RL-01、KP-01とstorage paginationのtargeted regression set: 50 passed、0 failed
  - `npm run typecheck`: passed
  - `npm run build`: passed。既存のLightning CSS pseudo-element warningとVite chunk-size warningのみ
  - `npm test`: 2402 tests、2401 passed、1 skipped、0 failed
- Structure convergence gate: `ready-after-consolidation`。既存のarray page APIは互換用にiteratorから構築し、external application経路だけがlazy iteratorを利用する。pagination owner、public projection owner、shared response limit ownerを移動または重複していない
- Holistic review countは1のまま維持し、二度目のcomplete-diff探索は行わない。Candidate c8はRL-01 finding familyとresulting deltaのtargeted closureだけで閉じる
- Candidate c8 targeted closure: `REV-C8-RL-01`でclosed。Candidate verificationは`verified`、blocking findingなし。独立実行した関連test 33件もpassed
- Targeted closure validation gap: process-level heap計測とSQLite row-step instrumentationは未実施。generator contractがconsumerのshort-circuitを直接検証し、storage sourceがlazy row iterationを所有するためnon-blockingとする
- Residual risk: `nextCursor`判定のためlookahead一件はparseするが、requested page sizeに依存しないbounded memoryであり、指摘されたmulti-gigabyte eager hydration経路は再現しない

## Admission and Pre-Authentication Resource Closure

- Gate: `ready`
- Finding Promotion: settings credential更新とcatalog importのexternal admission競合、未認証HTTP requestによるshutdown停止とresource枯渇、CLI入力のdispatch前unbounded bufferingは、いずれも既存owner内の`current-scope repair`とする
- Sibling Sweep: settingsはcredential変更branchとcatalog import、HTTPはpre-auth/body/socket/shutdown、CLI入力は`--json`、`--file`、`--stdin`とCLI/MCP共通exchange serializationを対象とする。GUI/Auxiliary/Companion run admissionの共通化、新operation、installerは対象外とする

| ID | Invariant | Scope / owner | Failure mode | Consumer impact | Direct verification |
| --- | --- | --- | --- | --- | --- |
| SET-CAT-ADMISSION-01 | Session snapshotを置換するsettings/catalog mutationはsnapshot取得前にexternal admissionを閉じ、既受付operationのdrainとrollback完了まで再開しない | `SettingsCatalogService`、`SessionExecutionAdmissionGate` | 実行中判定後に外部Turnが開始し、古いsnapshotでSession状態を巻き戻す | execution消失、会話履歴・thread metadataの巻き戻り | credential変更とcatalog importの最初のrun状態確認で新規admissionが拒否されることを確認 |
| HTTP-PREAUTH-01 | pre-auth requestは接続数、aggregate retained bytes、absolute deadlineをhard limitし、shutdownはunfinished requestを破棄しつつauthenticated handlerのquiescenceを待つ | Session runtime HTTP server | body未完了socketがquitを無期限停止し、並列接続やbufferでMain process資源を枯渇させる | アプリ終了不能、memory/socket exhaustion、store closeとの競合 | slow body、shutdown、aggregate budget、connection limit、handler drainの直接testで確認 |
| CLI-INPUT-LIMIT-01 | operation inputと最終exchange bodyはUTF-8で8 MiBを上限とし、超過をnetwork dispatch前の`CONTENT_TOO_LARGE / not_applied`へ収束させる | shared Session runtime contract、CLI input reader、CLI/MCP共通client | file/stdinを全量展開した後にだけserver上限を判定する | CLI/MCP processのmemory exhaustion、stable error不一致 | oversized file/stdinとexchange overhead超過でdiscovery/network dispatch前に拒否することを確認 |

- ADR gate: Accepted ADR 021の既存security、lifecycle、resource-limit decisionを実装するため追加ADRは不要
- Architecture document gate: exact limitとcleanup invariantはshared contract、source、executable contractを正本とし、恒久設計文書へ局所実装を複製しない
- Structure convergence gate: `ready-unchanged`。各repairは既存のadmission、HTTP lifecycle、shared request contract ownerへ収束し、新しいsemantic owner分散またはcanonical boundary迂回を作らない
- Review lifecycle: complete-diff holistic reviewは既に一度実施済み。現Candidateでは3 finding familyとresulting deltaに限定したtargeted closureのみ行う

### Direct Evidence

- `SET-CAT-ADMISSION-01`、`HTTP-PREAUTH-01`、`CLI-INPUT-LIMIT-01`のtargeted regression set: 54 passed、0 failed
- `npm run typecheck`: passed
- `npm run build`: passed。既存のLightning CSS pseudo-element warningとVite chunk-size warningのみ
- `npm test`: 2418 tests、2417 passed、1 skipped、0 failed
- `git diff --check`: passed with line-ending warnings only
- Remaining validation gaps: `npm run dist:win`、インストール済みalias、live ElectronでのCLI/MCP E2Eは未実施。GUI/Auxiliary/Companionのrun admissionは今回のexternal admission findingのsupported scope外とする

### Targeted Closure

- Candidate c10のtargeted closureで、`SET-CAT-ADMISSION-01`はblocking findingなしでclosedした
- `CLI-INPUT-LIMIT-01`では、最終exchange超過がpublic CLI境界で`INVALID_INPUT`へ誤投影される反例を確認した。CLI outer boundaryで`SessionRuntimeValidationError`をstable codeへ写像し、8 MiBのraw inputがenvelope追加後に超過する公開CLI regression testを追加した
- `HTTP-PREAUTH-01`では、aggregate budgetとheader未完了socket cleanupの直接contract不足を確認した。複数partial requestの合算超過、reservation解放後の再受付、header未完了socketのshutdown grace内closeをexecutable contractへ追加した
- Candidate c11のHTTP closureで、解放後の正常requestがreservation leak時にも上限内へ収まるtest識別力不足を確認した。保持900 bytes、合算超過200 bytes、後続payloadが124 bytes超となる組へ変更し、disconnect時に900 bytesが解放されなければ必ず後続requestが失敗するdirect contractへ修正した
- Candidate c12では上記識別条件を含むHTTP server test 11件がpassed。production sourceの追加変更はなく、同一finding familyの探索reviewを重ねずdirect checkで最終closure evidenceを揃えた
- Finding Promotionは二件とも既存owner内の`current-scope repair`。新しいpublic contract、semantic owner、subsystemは追加していない
- Holistic review countは1のまま維持し、最終Candidateでは二件のfinding familyとresulting deltaに限定したtargeted closure、およびsettings cellへのdelta非影響確認だけを行う
