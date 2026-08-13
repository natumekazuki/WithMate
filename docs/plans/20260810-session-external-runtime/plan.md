# Plan

- 作成日: 2026-08-10
- タスク: Session External Runtime の実装
- 状態: In Progress（holistic review finding対応）

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

## Accepted Surface Completion Prerequisite

- Gate: `ready`
- Trigger: Active designとADR 021が公開する17操作に対し、`interaction.list`、`interaction.respond`、`transcript.export`と、TurnのSessionFolder attachment、未解決interaction、partial outputの投影が未実装
- Disposition: 単なるadapter追加では永続化、provider continuation、filesystem identity、privacy、resource limitを閉じられないため、独立したboundary prerequisiteを次の順で実装する

### Invariant Matrix

| ID | Invariant | Scope / owner | Failure mode | Consumer impact | Direct verification |
| --- | --- | --- | --- | --- | --- |
| EXT-ATTACH-10 | 外部Turnのattachmentは対象SessionFolder内の明示relative pathだけを最大32件受理し、admission時とdispatch直前にidentityとkindを再検証する | shared Turn contract、composer attachment boundary、provider adapter | symlink/junctionまたは差し替え先へ追従する | 対象Session外fileの読取、誤fileのprovider送信 | absolute、`..`、root、重複、kind mismatch、symlink/junction、dispatch時差し替えのcontract test |
| EXT-INTERACTION-11 | interactionはexecutionに属するdurable stateで、一executionにpendingは最大1件、answer commitとidempotency recordを同一transactionにする | interaction storage/service | response lossで二重resolve、restart後に古いcontinuationへ回答する | provider side effect重複、別executionへの回答 | tuple ownership、replay/conflict、二重応答、commit前後failure、restart/shutdown reconciliation test |
| EXT-OBSERVATION-12 | waitはterminal、pending interaction、timeoutの最初を取りこぼさず、公開partial outputはprovider-neutral textだけをboundedに永続化する | execution observation/public progress owner | subscribe前のinteractionを見失う、private provider payloadを保存する | callerの無期限待機、privacy漏洩 | subscribe-before-read競合、全state projection、1 MiB UTF-8 truncation、restart test |
| EXT-TRANSCRIPT-13 | transcriptはpublic message/turn/interaction projectionだけからversioned JSONを作り、Markdownは同じprojectionから派生させる | transcript projector | raw provider payload、absolute path、elicitation値を出力する | private data漏洩、adapter間不整合 | canonical JSON/Markdown、legacy partial、privacy exclusion test |
| EXT-EXPORT-14 | SessionFolder exportはbounded streamingと同directory atomic publishを使い、response loss/crash後もidempotencyで完成fileへ収束する | transcript serviceとidentity-bound writer | 部分file公開、既存file破壊、rename後のeffect不明 | artifact破損または重複 | inline/folder limit、replace、rename前後crash、replay/conflict、temp cleanup test |

### Dependency Order

1. explicit SessionFolder attachment境界を閉じる
2. durable interaction、execution observation、partial outputを一体で閉じる
3. 1と2のpublic projectionを正本にtranscript inline/SessionFolder exportを閉じる
4. CLI/MCPを17操作へ揃え、operation別request/result schemaとannotation inventoryを検証する

- ADR gate: ADR 021のaccepted decisionを実装するため追加ADR不要
- Architecture document gate: ownerとrestart/atomic orderingへのpointerだけを更新し、exact fieldはtype/schema/testを正本とする
- Review gate: attachmentはfilesystem identity/provider parity、interactionはcontract projection/lifecycle concurrency、transcriptはprojection privacy/identity cleanupのtargeted reviewを各一度行う。統合後は未確認cross-subsystem interactionが残るため`Full-review gate=run`とする

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

## MCP / CLI Integration Slice 1: Runtime Catalog

### Pre-Implementation Closure Plan

- Gate: `ready`
- Goal: current model catalogを共通application境界からread-onlyに公開し、CLIの`runtime catalog`とMCPの`runtime.catalog`を同じoperationへ接続する
- Accepted contract: ADR 021と`withmate-session-mcp-codex-integration-brief.md`が定める、catalog/model候補をcallerが推測せずruntimeから取得する契約
- Knowledge placement: operation名、厳密な空input、public result fieldsはshared type/parserとexecutable contractへ置く。既存ADRのdecisionを実装するため追加ADRは作らない
- Sibling Sweep: shared request contract、application projection、HTTP operation dispatch、CLI command、MCP tool registrationを対象とする。Session CRUD、turn options、interaction、transcript、Session file、managed Skillは後続sliceへ分離する

| ID | Invariant | Scope / owner | Failure mode | Consumer impact | Direct verification |
| --- | --- | --- | --- | --- | --- |
| RUNTIME-CATALOG-01 | `runtime.catalog`は厳密な空objectだけを受け、current revisionとpublicなprovider/model/reasoning候補だけを返す | shared Session runtime contract、external application projection | callerがcatalogをローカル推測する、unknown inputを黙認する、内部metadataを公開する | staleまたは非対応tupleで後続operationを構築する、private stateが漏れる | contract testとapplication testでstrict input、exact projection、execution dependency非呼出しを確認 |
| RUNTIME-CATALOG-02 | CLIとMCPは同じ`runtime.catalog` operationを使い、CLIはinput source不要、MCPはread-only toolとして公開する | CLI/MCP adapter | adapterごとに別契約を持つ、read-only operationをmutation扱いする | automationのschemaとeffect分類がsurface間で分岐する | CLI dispatch test、MCP list/call/annotation testでoperationと空inputのparityを確認 |

- Failure timing: validation failureとtransport failureはいずれも`not_applied`。Session永続化、execution queue、provider dispatchへの副作用はない
- Targeted checks: shared contract、application service、CLI、MCPの各test、typecheck、生成bundle build
- Review gate: public schema/projectionのcross-surface sliceなので、implementation-complete Candidateをcontract/projection lensのtargeted reviewへ一度渡す。complete-diff holistic reviewは統合Brief全sliceの最終Candidateまで行わない

## MCP / CLI Integration Slice 2: Session CRUD

- Status: `completed`

### Task Brief

- Goal: 通常Sessionの`session.create`、`session.list`、`session.get`、`session.rename`を共通application境界へ追加し、CLI/MCPからGUIと同じ永続Sessionを操作できるようにする
- Accepted anchors: ADR 005、ADR 021、`docs/design/session-external-runtime.md`、本sliceで合意した公開projectionとGUI非干渉契約
- Included: strict public schema、Main ProcessでのCharacter random解決、Workspace/SessionFolder作成、CRUD専用永続idempotency、keyset pagination、current Session IDのprovider prompt注入、CLI/MCP adapterと配布bundle、直接test
- Excluded: delete/archive、Character selector、Session kind/model/reasoning/approval/sandboxのcreate入力、generic patch、Windowの作成/表示/focus/close、Turn option、interaction、transcript、Session file API
- Done: sourceとexecutable contractが一致し、migrationのempty/populated/rerun、create/rename replayとconflict、list/get projection、GUIと外部Turnのself identity、Window非生成を直接検証し、triggerしたspecialist reviewを一回ずつ閉じる

### Pre-Implementation Closure Plan

- Gate: `ready`
- Unresolved contract decisions: なし。公開field、Character policy、idempotency ownership、pagination、Window非干渉は本slice開始前の合意とAccepted ADRから確定している
- Canonical owners:
  - public request/result/error: `src/session-external-runtime-contract.ts`
  - Session create/rename orchestrationとGUI共通のprovider/Character/Workspace決定: Main ProcessのSession command/persistence境界
  - durable mutation replay/conflict/cleanupとatomic Session write: V6 Session storage
  - list/get public projectionとcursor: Session CRUD application境界
  - adapter内のidempotency key自動生成: CLI/MCP adapter。明示keyはcross-call recovery用overrideとして維持する
  - current Session self identity: provider prompt composition
- Sibling channels: GUI IPC、Session HTTP runtime、CLI、MCP。GUIだけがcreate成功後にWindowを明示的に開く既存actionを持ち、外部CRUD/Turnはそのactionを通らない
- Trigger matrices: Public API / Validation / Projection、Coupled Invariant / Versioned Selection、Mutation / External Side Effect、Owner / Scope / Projection、Limit / Concurrency / Resource、Migration / Repair / Existing Data
- High-risk axes not selected: auth/secret transportとprocess listener lifecycleは既存runtime境界を変更しない。Session deleteとorphan cleanupは本sliceの公開surface外

### Closure Map

- Accepted contract / exact anchor:
  - ADR 021「操作対象を明示したSession」「mutationをidempotencyで収束」「public projectionを明示的に構成」
  - ADR 005のSession ID発行、exclusive directory作成、insert-only永続化、failure順序
  - `session-external-runtime.md`のSession作成と選択、24時間idempotency、pagination、stable error表
- Supported scope / excluded scope: 通常Sessionの4操作と全normal Session Turnのself identityだけを対象とし、Auxiliary/Companion/Character Authoring、delete/archive、Window lifecycleを除外する
- Coupled invariants / valid combinations:
  - createは`title + provider=codex + catalogRevision + workspace(kind,path?) + operation/idempotencyKey/fingerprint`を一組として扱う
  - Workspaceは`directory`ならcaller pathをMainでcanonicalizeしてlabel/branchを導出し、`session_folder`ならMainがSession IDからpathを作る
  - CharacterはGUIと同じactive/open-window/recency policyで一度だけ解決し、idempotent replayでは再抽選しない
  - renameは`sessionId + title + operation/idempotencyKey/fingerprint`だけをatomic updateし、他metadataを変更しない
- Failure timing:
  - validation、catalog stale、unsupported kind、not found、cursor/limit不正はeffect前に`not_applied`
  - SessionFolder mkdir失敗ではSession/idempotency rowを作らない。DB commit後のresponse lossは同じkeyでcanonical resultへ収束する
  - same operation/keyでfingerprintが異なる場合はeffect前に`IDEMPOTENCY_CONFLICT`
- Consumer impacts / projections:
  - create/getは許可したSession/Character/Workspace/SessionFolder metadataだけを返し、listはabsolute path、runtime snapshot、thread ID、prompt、messageを返さない
  - external create/renameはHome/session listと既存broadcastへ反映するが、SessionWindowを作成、表示、focus、closeしない
  - normal Sessionのprovider promptは実行対象自身のSession IDだけを含み、caller/parent IDを自動注入しない
- Direct verification: shared contract、Session CRUD service/storage、schema migration、Main composition、provider prompt、CLI、MCP、生成bundleのtargeted tests。typecheck、build、full testを主要回帰確認とする

### Invariant Matrix

| ID | Sibling channel / coupled values | State / evidence order | Failure mode / timing | Consumer impact / public projection | Owner / effect certainty | Direct verification | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SESSION-CRUD-SCHEMA-01 | HTTP/CLI/MCPの4 operation、strict input、stable error | adapter normalize後にshared parser、application dispatch | unknown field、stale revision、invalid cursor/limitがeffectへ到達 | surface間の契約分岐、誤retry | shared runtime contract / `not_applied` | raw/shared/CLI/MCP contract tests | covered |
| SESSION-CREATE-IDEMPOTENCY-02 | provider/revision/workspace/random Character/session row/idempotency row | validate→replay/conflict確認→ID→mkdir→Session+record atomic commit→broadcast | retryでCharacter/SessionFolderを再作成、部分commit | Session重複、orphan増加、canonical result喪失 | Main persistence + V6 storage / committed replay | replay/conflict、publication failure、24h cleanup、ADR 005 failure tests | covered。永続化呼出し後のSessionFolder保持はADR 005のanchored exception |
| SESSION-RENAME-ATOMICITY-03 | sessionId/title/idempotencyと不変metadata | resolve→replay/conflict→title+record atomic commit→broadcast | generic updateでprovider/Character/workspaceも変わる | 外部surfaceが不変metadataを破壊 | V6 storage + persistence / committed replay | title-only delta、replay/conflict/not-found、publication failure tests | covered |
| SESSION-PROJECTION-PAGE-04 | list/get、`last_active_at DESC,id DESC`、cursor/filter | bounded summary query→allowlist projection→opaque cursor | full hydrate、offset drift、path/private field leak | 長期利用のresource増加、private情報露出 | Session CRUD query/projection / read-only | limit、tie、page間rename、cursor misuse、allowlist、label衝突 tests | covered |
| SESSION-SELF-IDENTITY-05 | GUI/CLI/MCP起点のnormal Session Turn、execution target ID | provider prompt composition時にtarget Sessionから導出 | caller/parent ID注入、ID不在でCharacter/workspaceから推測 | agentが別Sessionを操作する | provider prompt / read-only context | target-only、normal/non-normal tests | covered |
| SESSION-WINDOW-VISIBILITY-06 | create/rename/turnとHome/Monitor/既存Window broadcast | durable update→cache/broadcast。Window openはGUI actionだけ | CLI/MCPでWindowを勝手に生成/focus/close、またはGUIへ更新が出ない | 操作中断、見えない状態差分 | application composition / storage effectのみ | Window command非依存、broadcast、best-effort publication tests | covered |
| SESSION-CRUD-MIGRATION-07 | empty/populated/current V6、schema rerun、expiry index | additive table/index作成→existing row保持→rerun |既存Session消失、partial schema、cleanup不能 | 起動不能、履歴消失、record無制限増加 | `ensureV6Schema` / atomic schema transaction | populated additive ensure、rerun、expiry cleanup tests | covered |

### Implementation Checklist

- [x] shared Character selection policyとMain CRUD orchestrationを既存GUI/persistence ownerへ収束し、create/rename/list/getのstorage contractを追加する
- [x] shared public contract、application dispatch、CLI/MCP schema/command、生成bundle/runbookを接続する
- [x] provider promptへcurrent Session IDを追加し、ADR 021の`runtime.context`非採用との違いを明確化する
- [x] targeted tests、typecheck、build、full testを実行し、Matrixを`covered`または根拠付きの残状態へ更新する
- [x] Candidateを凍結し、`contract-schema-projection`、`lifecycle-effect-concurrency`、`resource-cleanup-platform`の3 specialist lensへ同時に一度だけ渡す

### Review Convergence

- specialist reviewは1 lensにつき1回、同じCandidateへ最大3名までとする。同じlensへ別reviewerを重ねない
- findingはrootがFinding Promotionを行い、accepted contract違反かつ到達可能な`current-scope repair`だけを本sliceへ戻す
- 修正後は対象familyのdirect checkと一度のtargeted closure、他lensのdelta非影響確認だけを行い、探索reviewを再開しない
- Full-review gateの既定は`skip`。specialistとdirect checkで直接検証できない具体的なcross-cutting interactionが残る場合だけ`run`とし、holistic complete-diff reviewは最大1回とする

### Completion Evidence

- Structural convergence: `ready-unchanged`。Character選択、CRUD orchestration、storage、public projection、adapterのsemantic ownerは一つずつで、追加の構造変更は不要
- Direct checks: CRUD/storage/application/persistence targeted 53件、typecheck、build、全体test 2434件成功、1件skip
- Specialist Candidate: `session-crud-c1`を3 lensで一度ずつ確認。pagination中rename、workspace label衝突、commit後publication error mappingを`current-scope repair`へ分類
- Finding Promotion: SessionFolderの永続化呼出し後failureでdirectoryを保持する指摘は、ADR 005がデータ消失回避のaccepted behaviorとorphan riskを明示するため`accepted risk`。failure injection testで現行境界を固定
- Targeted closure: `session-crud-c2`で`F-PROJECTION-PAGINATION`と`F-PUBLICATION-EFFECT`をそれぞれ一度確認し、blocking findingなしでclosed
- Full-review gate: `skip`。triggerしたmatrix cellはdirect checkとspecialist/targeted closureで閉じ、未確認のcross-cutting interactionを残していない

## Session Files Implementation

### Scope

- 通常Sessionを明示した`session.files.list`、`session.files.read_text`、`session.files.write_text`をshared application boundaryへ追加する
- CLI、MCP、loopback HTTPは同じrequest parser、Session file service、result/error contractを使う
- delete、rename、binary upload、caller workspaceからのcopy、Auxiliary/Companionの個別Folder操作は公開しない

### Pre-Implementation Closure Plan

- Gate: `ready`
- Accepted contract: ADR 021のSessionFolder authority、relative path containment、write idempotency。`docs/design/session-external-runtime.md`のpagination、text byte limit、atomic no-overwrite contract
- Canonical owner: public input/resultは`src/session-external-runtime-contract.ts`、path認可とfile effectは`src-electron/session-file-service.ts`、durable idempotencyは`SessionStorageV6`
- Sibling entries: loopback HTTP、Session CLI、Session MCP。GUI Explorerはabsolute preview capabilityを持つため外部Session filesのownerとして再利用しない
- Failure timing: validationとSession解決後にwrite idempotencyを`pending`へ保存し、同一filesystemのtemp fileをatomic publishしてから`applied`へ更新する。publish後にstorage更新またはresponse deliveryが失敗した場合は、同じkeyとfingerprintのretryでtarget digestを確認しcanonical resultへ収束する
- Knowledge placement: ADR 021を継続利用し、新しい選択肢または不可逆な判断は追加しない。schema/type/testを正本とし、CLI操作だけrunbookへ反映する

### Invariant Matrix

| ID | Sibling channel / coupled values | Failure mode / timing | Consumer impact | Owner / effect certainty | Direct verification | Status |
| --- | --- | --- | --- | --- | --- | --- |
| SF-OWN | sessionId、default Session、SessionFolder | orphan Folderまたは非default SessionをIDだけで参照 | 別owner fileの露出 | Session file service / read-onlyまたはeffect前 | missing/nondefault Session test | covered |
| SF-PATH | root identity、relative path、parent/file identity | absolute、`..`、symlink/junction、検証後差替え | SessionFolder外のfile露出または上書き | Session file service / effect前 | relative path、symlink read/list、identity-bound tests | covered |
| SF-LIMIT | list limit/cursor、UTF-8、read/write maxBytes | aggregate scan、truncate、invalid text、8 MiB超過 | 不完全結果またはresource枯渇 | shared contract + Session file service / effect前 | parser、pagination、bounded read/write tests | covered |
| SF-WRITE | sessionId、relativePath、content digest、replace、operation/key/fingerprint | partial file、response loss後の重複、key conflict | 上書き、canonical result喪失 | Session file service + V6 storage / pending or applied | no-overwrite、replay/conflict、publish後failure recovery tests | covered |
| SF-ADAPTER | HTTP/CLI/MCP operationとstrict input | adapter固有schema、mutation effect誤分類 | surfaceごとのretry分岐 | shared contract + application service / stable envelope | shared/application/CLI/MCP contract tests | covered |

### Review Plan

- Candidate preflight後、`identity-security-ipc`、`contract-schema-projection`、`lifecycle-effect-concurrency`の3 lensを同じCandidateへ一度ずつ適用する
- findingはFinding Promotionで分類し、`current-scope repair`だけを対象familyのdirect checkとtargeted closureへ戻す
- Full-review gateはsecurity、filesystem、SQLite、CLI/MCPを跨ぐinteractionがtargeted checkだけで閉じない場合に`run`、それ以外は`skip`とする

### Structure Convergence Gate

- Result: `ready-after-consolidation`
- Trigger evidence: Candidate c1のidentity reviewで、認可後のroot/parent差替えを通常のpath再解決だけでは防げないことが確認され、Session orchestrationとOS identity-bound write primitiveを同一serviceへ残すとsecurity decisionが分散する具体的なevidenceになった
- Decision: Session ownership、public error/effect、idempotency orchestrationは`SessionFileService`へ残し、認可済みrootからnested parent、stage、publishまでを同一process cwdへidentity-bindするprimitiveを`identity-bound-file-write.ts`へ抽出した。durable replay stateは`SessionStorageV6`、public parser/projectionはshared contractとapplication serviceが引き続き所有する
- Preserved contracts: `SF-OWN`、`SF-PATH`、`SF-LIMIT`、`SF-WRITE`、`SF-ADAPTER`
- Responsibility delta / edit batch: identity-bound writeとcleanupを専用primitiveへ集約し、service内のlexical write helperを除去した。新しいpublic APIまたは別subsystemは追加していない
- Post-gate direct checks: Session file service 12件、review finding横断targeted suite 48件、typecheck、build、全体testがpassed

### Candidate Definition and Evidence Ledger

- Candidate: `session-files-c1`
- Source identity: `candidate_snapshot.py create`のschema version 1 `manifest-digest`で生成した`sha256:9e44d9c794357d2b6f799ea8c6a6f939aa927a1f1a6de9b4a93f437450856214`。production source、adapter、generated Session CLI、runbook、関連test 17 fileを固定し、task-local planは対象外とした
- Candidate preflight: `review_brief.py`のschema version 1 builderで3 specialist Briefとも`ready / verified`。recorded baseは`bc02adf0e2a3cf0bc3d104de3de3ec0613789fe9`、raw diff digestは`sha256:a71e721317486d82a6ef5b859a3cb5cb5bc02582714f9694b1c0d990f65263f8`。未追跡fileはmanifestのexact content digestへ固定し、outside-scope changeはtask-local planだけである
- Accepted contract / matrix: `SF-OWN`、`SF-PATH`、`SF-LIMIT`、`SF-WRITE`、`SF-ADAPTER`
- Current direct evidence:
  - Session file service/storage targeted set: 8 passed、0 failed
  - Session files関連横断targeted set: 126 passed、0 failed
  - `npm run typecheck`: passed
  - `npm run build`: passed。既存のLightning CSS pseudo-element warningとVite chunk-size warningのみ
  - `npm test`: 2468 tests、2467 passed、1 skipped、0 failed
  - `git diff --check`: passed with line-ending warnings only
- Review Brief: 同じCandidateを`identity-security-ipc`、`contract-schema-projection`、`lifecycle-effect-concurrency`へ独立に渡す。各lensは割当matrix cellと現実的な反例に限定し、source編集を行わない。初回の手書きenvelopeは必須field不足でvalidation-onlyとなったため、Candidateとreview contractを維持したtransport retryとしてbuilder発行済みBriefを同じreviewerへ再送した

### Finding Promotion and Candidate c2

- Candidate c1の3 specialist lensで、次をaccepted contract違反かつ現実的に到達可能な`current-scope repair`へ分類した
  - `F-SF-PATH-IDENTITY-WRITE`: 認可後のSessionFolder rootまたはnested parent差替えで外部pathへwriteできる
  - `F-SF-CONTRACT-EFFECT-ANNOTATION-PAGINATION`: publish後のtyped error effect、MCP destructive annotation、Unicode pagination comparatorがpublic contractと一致しない
  - `F-SF-WRITE-LIFECYCLE`: late completionのexpiry、partial temp recovery、fresh no-overwrite collisionがdurable replay contractと一致しない
- いずれも既存のSession file、application adapter、V6 storage owner内で閉じ、新しいsemantic ownerまたはsubsystemを要求しない。CLI response envelopeの追加validationはcurrent finding family外のhardening候補としてsourceへ加えない
- Repair delta:
  - write workerを認可済みrootのcwdへbindし、rootと各nested directoryのidentityをpublishまで検査する。root/nested junction swapをdirect regression化した
  - typed `SessionFileServiceError`のeffectをpublic envelopeへ伝播し、MCP writeをdestructiveとして公開し、list sort/cursorをUTF-8 byte comparatorへ統一した
  - applied expiryをcompletion基準へ更新し、partial tempの安全なrestage/cleanupとpublish proofをreplayへ保持し、fresh no-overwrite collisionはcontent一致でも`FILE_ALREADY_EXISTS`とした
- Candidate: `session-files-c2`
- Source identity: schema version 1 `manifest-digest`の`sha256:62e80aa977ac32cffa2e6213c4c118c8c11edd022316e8fd179cecdae0d9f5bd`。production source、adapter、generated Session CLI、runbook、関連test 18 fileを固定し、task-local planは対象外とした
- Candidate preflight: 3 targeted-closure Briefとも`ready / verified`。recorded baseは`bc02adf0e2a3cf0bc3d104de3de3ec0613789fe9`、raw diff digestは`sha256:660701544b9bc5b8e54aa80cbe389c7c1b5fca77519bf5edcb913ff645750894`
- Current direct evidence:
  - finding横断targeted set: 48 passed、0 failed
  - Session file service identity set: 12 passed、0 failed
  - `npm run typecheck`: passed
  - `npm run build`: passed。既存のLightning CSS pseudo-element warningとVite chunk-size warningのみ
  - `npm test`: 2475 tests、2474 passed、1 skipped、0 failed
  - `git diff --check`: passed with line-ending warnings only
- Targeted closure: c1でfindingを出した3 reviewerへ、Candidate c2のfinding familyとresulting deltaだけを一度ずつ返す。complete diffの新規探索は行わない

### Lifecycle Design Re-entry and Final Candidate

- Candidate c2のidentityとcontract targeted closureはblockingなしでclosedした。lifecycle closureでは、`replace=true`のresumeにpublish proofがなくunrelatedな同digest targetをapplied化できる反例を確認した
- Candidate c3でresume acceptanceをtemp/target同一identity proof必須へ統一し、別writerの同digest targetを再publishする`SF-WRITE-07`を追加した。identity familyへのdelta非影響はblockingなしで確認した
- 同じlifecycle familyの二度目のclosureで、replace publishがtempをrenameで消費するため、completion failure後のretryでproofが残らず再publishする反例を確認した。同じfamilyのreviewはこれ以上反復せず、設計境界へ戻した
- Final design: replace publish後にtargetからowned tempへhard linkを作り、staged inode、target、proof linkのidentity一致を検証する。proof linkはSQLiteのapplied確定まで保持し、成功後にidentity-bound cleanupする。これによりunrelated targetを受理せず、実publish後のretryは同じinode、mtime、canonical resultへ収束する
- Direct closure:
  - `SF-WRITE-07`: pending replaceが別writerの同digest targetを本operationのproofとして受理せず再publishする
  - `SF-WRITE-08`: replace publish後のcompletion failureとretryでinode、mtime、canonical resultが変わらない
  - finding横断targeted set: 51 passed、0 failed
  - `npm run typecheck`: passed
  - `npm run build`: passed。既存のLightning CSS pseudo-element warningとVite chunk-size warningのみ
  - `npm test`: passed。1 skipped、0 failed
- Final Candidate: `session-files-c4`
- Source identity: schema version 1 `manifest-digest`の`sha256:6ce7ce760e87c9a8650e651e53de48506fe2a1daebba27a682a23e3ed8ee709f`。Candidate preflightは`verified`
- Full-review gate: `run`。identity-bound filesystem effect、SQLite durable replay、HTTP/CLI/MCP public effectのcross-cutting interactionは単一targeted checkでは直接反証できないため、fresh reviewerへCandidate c4のcomplete diffを一度だけ渡す

### Holistic Findings and Candidate c6 Closure

- Candidate c4のholistic complete-diff reviewは一度だけ実施し、`SF-WRITE`と`SF-LIMIT`に各1件の`current-scope repair`を確認した。二度目のcomplete-diff探索は行わない
- `F-HOLISTIC-TERMINAL-REJECTED`: `FILE_ALREADY_EXISTS / not_applied / retryable=false`が`pending`に残り、target削除後の同一key再送で成功し得る。V6 idempotency stateへ`rejected`を追加し、canonical errorをcompletion基準で24時間保持・再生・cleanupする。既存tableはSAVEPOINT内のrebuildで行を保持したままCHECK制約を更新する
- `F-HOLISTIC-LIST-SCAN-BUDGET`: public limitが返却件数だけを制限し、directory enumeration、metadata取得、worker outputを制限しない。identity-bound listing workerを`opendir`による上限制御へ変更し、Session file serviceはpage limit由来のaggregate recursive scan budgetを全directoryで共有する
- Finding Promotion: 前者は既存Session file storage/service owner、後者は既存identity-bound listing primitiveとSession file service owner内の`current-scope repair`。GUI Explorerは`maxEntries`未指定の既存挙動を維持し、新しいpublic operationまたは別subsystemを追加しない
- Candidate c5で両finding familyのtargeted closureはblockingなしだった。terminal reviewerが示したmigration validation gapを閉じるため、旧CHECK制約tableへ`pending`と`applied`の既存行を入れた状態でrebuildと二回目の`ensureV6Schema`後にも保持されることをdirect regressionへ追加した。production sourceとlisting familyにはdeltaがない
- Final Candidate: `session-files-c6`
- Source identity: schema version 1 `manifest-digest`の`sha256:567224917d3848daf896d0748972b91552baa535321b6aa36fbe003a21948a49`。Candidate preflightは`verified`。scopeはCandidate c4の18 fileにidentity-bound directory listing source/testを加えた20 file
- Current direct evidence:
  - terminal rejection、既存行入りschema upgrade、bounded listingを含むfocused set: 34 passed、0 failed
  - Session files横断targeted set: 105 passed、0 failed
  - `npm run typecheck`: passed
  - `npm run build`: passed。既存のLightning CSS pseudo-element warningとVite chunk-size warningのみ
  - `npm test`: 2480 tests、2479 passed、1 skipped、0 failed
  - `git diff --check`: passed with line-ending warnings only
- Final closure chain: holistic finding二件はCandidate c5上でfinding familyとresulting deltaに限定したtargeted closureを行い、Candidate c6ではmigration validation gapのclosureとlisting familyへのtest-only delta非影響だけを同じreviewerへ確認する。`SF-OWN`、`SF-PATH`、`SF-ADAPTER`にはproduction deltaがなく、identity-bound helperの既存GUI callerは上限未指定で従来の全件snapshotを維持する
- Candidate c6 targeted closure: `SF-WRITE-TERMINAL/filesystem-storage-lifecycle`と`SF-LIMIT-SCAN/resource-pagination`はいずれもCandidate verification `verified`、blockingなし、期限内approve。前者は既存行入りmigration testでc5のvalidation gapを閉じた。後者はlisting対象4 fileがc5とbyte-identicalであることと独立19 testでdelta非影響を確認した
- Residual validation gap: 複数の小directoryを横断してaggregate scan budgetを使い切る専用testはない。共有budgetのsource確認、flat directoryのmetadata取得前拒否、recursive pagination testは存在し、Candidate c6のdelta由来ではないためnon-blockingとする

## External Runtime Review Repair

### Task Brief

- Goal: Session files実装後の外部Session runtimeを、accepted public contract、credential isolation、終了時のbounded lifecycle、provider-neutralなSession/Turn操作へ収束する
- Scope: Windows discovery artifact、execution shutdown/queue drain、Session progress audit、runtime catalog、Session create、Turn options/run/enqueue、CLI/MCP schemaとannotation、acceptedだが未接続のinteraction/transcript surface
- Excluded scope: Memory runtime、GUI固有の新機能、未知providerの自動fallback、review範囲外の一般的hardening
- Done: 下表のblocking familyをdirect checkと必要なtargeted reviewで閉じ、typecheck/build/full testを最終sourceで通す。別subsystemを要求するpublic surface prerequisiteは独立sliceとして実装・検証する

### Pre-Implementation Closure Plan

- Gate: `ready`
- Accepted contract:
  - ADR 021の17 public operations、provider/catalog revisionの明示、provider固有Turn optionのexact projection、SessionFolder authority、外部adapter間の同一契約
  - `docs/design/session-external-runtime.md`のruntime discovery security、bounded shutdown、public projection、operation別result、MCP metadata
  - ユーザー指定により、`runtime.catalog`をCodexへ縮小せず、外部Session runtimeが対応する有効providerをSession createからTurn実行まで利用可能にする
- Canonical owners:
  - request/result mappingとstrict validation: `src/session-external-runtime-contract.ts`
  - provider capabilityとadapter選択: `src-electron/provider-support.ts`
  - public projection/orchestration: `src-electron/session-external-application-service.ts`
  - queue admission、dispatch、shutdown persistence fence: `src-electron/session-execution-service.ts`
  - discovery artifactとWindows ACL: `src-electron/session-external-runtime.ts`と`src/session-runtime-discovery.ts`
  - execution audit: `src-electron/session-runtime-service.ts`
- Sibling entries: loopback HTTP、Session CLI、Session MCP、GUI Session runtime。CLI/MCPだけを個別回避せず、shared application/contract境界で修正する
- Failure timing:
  - unsupported/disabled provider、stale catalog、provider固有option不一致、unknown custom agentはexecution登録前に`not_applied`
  - Windows ACLがowner-onlyへ収束しない場合はcredential file作成前にfail closedする
  - quitは新規受付を閉じ、active providerへcancelを要求し、有限grace後にrunning executionを`interrupted`へ確定する。late provider completionは閉じたstorageへ触れない
  - transient queue admission failureはbounded retryを予約し、shutdown開始後は再予約しない
- Knowledge placement: public input/resultとfailureはtype/schema/test、局所理由はcode comment、利用方法だけrunbookへ置く。ADR 021の選択を変更しないため新ADRは不要。未実装operationはdesign correctionではなくaccepted contractを満たす独立prerequisiteとして扱う

### Finding Promotion

| Finding | Disposition | Accepted contract / reachability | Supported owner |
| --- | --- | --- | --- |
| Windows credential ACL | `blocking / current-scope repair` | 任意runtime pathとWindows ACL未検証から平文secretへ到達可能 | runtime discovery publication |
| unbounded quit | `blocking / current-scope repair` | authenticated handlerとprovider promiseが未settleならstorage closeへ進めない | HTTP + execution shutdown lifecycle |
| missing accepted operations/projections | `blocking / boundary prerequisite` | ADR 021でacceptedなoperationをadapterが公開できない | interaction/transcript/public projection slices |
| progress audit defaults overwrite | `blocking / current-scope repair` | meaningful progress後のrunning auditだけper-turn tupleを失う | Session runtime audit projection |
| unusable catalog candidates | `blocking / current-scope repair` | Copilotは実装済みadapterだがcreate/options/input schemaで到達不能 | shared provider/Session Turn contract |
| unknown MCP result schema | `blocking / current-scope repair` | operation別exact fieldをclient/runtimeが検証不能 | shared result map + MCP schema |
| inaccurate MCP execution hints | `blocking / current-scope repair` | provider executionはfilesystem/network副作用へ到達可能 | MCP tool metadata |
| stranded queued execution | `blocking / current-scope repair` | transient admission rejection後に自動drainが再発火しない | execution drain coordinator |

### Invariant Matrix

| ID | Coupled invariant | Failure mode / consumer impact | Direct verification | Review trigger |
| --- | --- | --- | --- | --- |
| EXT-PROVIDER-01 | catalog candidate = current snapshot ∩ external-runtime-supported ∩ enabled | 選択後にcreate/optionsが必ず失敗、または未知adapterへfallback | catalog/create/options application tests | public contract/provider capability targeted review |
| EXT-PROVIDER-02 | external Turnはcommon tuple + exact provider option union。Codexはsandbox、Copilotはcustom agent | provider固有optionの混在、fallback、CLI/MCP分岐 | shared parser、CLI、MCP、dispatch tests | contract/schema targeted review |
| EXT-RESULT-03 | operation→result mappingはcompile-timeとMCP runtime schemaでexact | 不正projectionを`unknown`で通過 | operation全件のsuccess/error schema tests | contract/schema targeted review |
| EXT-MCP-04 | provider実行toolはdestructive/open-worldを正しく宣言 | clientが副作用確認を省略 | tool list annotation test | direct check sufficient |
| EXT-AUDIT-05 | running/terminal auditは同じeffective Turn tupleを保持 | crash時に誤ったmodel/reasoning/approvalが履歴へ残る | progress→crash相当のaudit test | direct check sufficient |
| EXT-WIN-CRED-06 | credential root/generation/fileはcurrent OS user boundary内、検証不能なら未公開 | 別OS userのsecret読取とruntime authorization bypass | injected Windows ACL failure/success/cleanup tests | identity/security targeted review |
| EXT-SHUTDOWN-07 | cancel→finite grace→interrupted→storage fence→close | quit無期限停止、late write、結果消失 | stuck provider、late completion、HTTP handler tests | lifecycle/concurrency targeted review |
| EXT-QUEUE-08 | drain rejectionは一つのtracked retryへ収束しshutdownで停止 | executionがqueuedのまま永続化 | transient admission/retry/shutdown tests | lifecycle/concurrency targeted review |
| EXT-SURFACE-09 | ADR 021の17 operationsと必要projectionが全adapterで接続 | callerがaccepted operationを実行不能 | operation inventory、interaction/transcript/attachment tests | prerequisiteごとのtargeted review |

### Slice Order and Review Contract

1. provider-neutral public contract、exact result schema、MCP annotation、progress auditを同一external-surface sliceで閉じる
2. Windows credential publicationを独立security sliceで閉じる
3. shutdown persistence fenceとqueue retryを同一lifecycle sliceで閉じる
4. missing interaction/transcript/projectionをsemantic ownerごとのboundary prerequisiteとして閉じる
5. 各高リスクsliceはdirect check後に割当finding familyだけを`targeted_reviewer`へ一度渡す。全slice統合後はcross-subsystem interactionが残るため`Full-review gate=run`とし、同一Final Candidateのcomplete diffをfresh reviewerへ一度だけ渡す

### Candidate c1 Finding Closure and c2 Preflight

- Candidate c1: `session-external-runtime-final-c1`。source変更後のためc1上のreview/check entryは最終完了証拠に再関連付けしない
- c1 lifecycle findingは`current-scope repair`。admission retry exhaustion後も次のqueued executionをdrainし、terminal writeの一時失敗もtracked retryへ戻す。同じexecution/queue coordinator owner内で閉じた
- c1 identity findingsは`current-scope repair`。SessionFolder attachmentは検証済みidentityからruntime-owned snapshotを作りCodex/Copilotへ渡す。transcript temp cleanupはauthorized parent identityとstaged inodeに結び付け、parent rename後も同一inodeだけを回収する
- Windows credentialとattachment snapshotのACL semantic ownerを`runtime-path-security.ts`へ統合し、Windowsでは内容書込前にprotected DACLを確定する。前processのsnapshot orphanはsingle-instance lock取得後のstartup sweepで回収する
- contract projectionはprovider別discriminated union、interaction kind別tuple、operation別MCP result schemaへ固定し、`transcript.export`をmutation effect familyへ含める
- Provider parity: `runtime.catalog`はenabledなCodex/Copilotを返し、両providerのSession create、Turn options、run、enqueueをshared contract、CLI、MCPから到達可能にする。未知providerのfallbackは行わない
- Structural convergence gate: `ready-after-consolidation`。security ownerの重複を共有ACL boundaryへ収束し、public parser/projection、persistence、application orchestration、adapterの責務は既存境界を維持した。独立責務の追加混在またはcanonical boundary迂回を示す残存evidenceはない
- Current direct checks:
  - `npm test`: 2554 tests、2553 passed、1 skipped、0 failed
  - `npm run typecheck`: passed
  - `npm run build`: passed。既存のLightning CSS selector warningとchunk size warningのみ
  - attachment/Codex/Copilot/runtime targeted suite: 124 passed
  - execution queue suite: 20 passed
  - contract/application/execution/MCP suite: 78 passed
  - transcript suite: 11 passed
  - `git diff --check`: passed with line-ending warnings only
- Full-review gate: `run`。public schema、Windows credential/attachment security、queue/shutdown concurrency、interaction/transcript persistenceが複数process/subsystemを横断し、direct checkだけではcross-cutting反例を閉じられない。triggered lensを同一c2 Candidateへ適用後、fresh reviewerによるcomplete-diff reviewを一度だけ行う

### Candidate c2 Specialist Findings and c3 Closure

- Candidate c2のspecialist reviewで3件を`blocking / current-scope repair`へ分類した。いずれもaccepted contractと現実的な到達性があり、既存semantic owner内で閉じる
- `F-TRANSCRIPT-EFFECT`: `transcript.export`のinlineとSessionFolderで異なる上限・副作用をMCP schemaとCLI/application effectが区別していなかった。destination別schemaへ分離し、inline failureは常に`not_applied`、SessionFolderのdispatch後failureは`indeterminate`へ統一した
- `F-INTERACTION-POSTCOMMIT`: durable response commit後のobserver例外がapplied responseとprovider continuationを壊し、shutdown expiry failureがexecution drainをskipし得た。observerをpost-commit best-effortへ限定し、continuationを一度だけsettleし、expiryとexecution drainを独立して必ず試行する
- `F-TRANSCRIPT-PARENT-IDENTITY`: staging後にparentをSessionFolder外へ移動し元pathを同一inodeのsymlink/junctionへ差し替えるとpublish先が外へ移り得た。publish直前にparentのlexical non-link、current real path、identity、current root containmentの複合値を再検証する
- Provider parityを再確認し、Codex/Copilotの両方についてcatalog、Session create、Turn options、run/enqueue、interaction observationをshared contract、CLI、MCPから到達可能なまま維持した
- Current direct checks:
  - provider/CLI/MCP/interaction/transcript targeted suite: 117 passed、0 failed
  - `npm test`: 2560 tests、2559 passed、1 skipped、0 failed
  - `npm run typecheck`: passed
  - `npm run build`: passed。既存のLightning CSS selector warningとchunk size warningのみ
  - `git diff --check`: passed with line-ending warnings only
- Candidate c3では上記3 finding familyとresulting deltaだけを各specialistへtargeted closureとして渡す。新規探索は行わない。3 closureが同一Candidateでclosedした後、`Full-review gate=run`に従いfresh reviewerへcomplete diffを一度だけ渡す

### Candidate c3 Transcript Finding and c4 Closure

- Candidate c3のinteraction closureはblockingなしでclosedした。transcript closureでは、path identityの最終確認後からpath-based publishまでにparentを差し替えられる`F-TRANSCRIPT-PUBLISH-TOCTOU`を`blocking / current-scope repair`へ分類した
- Finding Promotion: acceptedなSessionFolder containmentとpersonal-data boundaryへ現実的に到達し、既存transcript export filesystem effect owner内で閉じる。新しいpublic operation、永続化schema、別subsystemは追加しない
- Repair delta:
  - 認可済みparentをchild processのcwdへidentity-bindし、stream staging、prepared barrier、publish、hard-link proof、recoveryをcwd相対basenameだけで実行する。全量bufferは保持せず、1 GiB hard maximumでもchunk streamingを維持する
  - `recordPreparedOutput`成功後だけpublish commandを送り、`replace=true`ではtemp proofからpublish aliasをhard linkしてrenameする。rename直後のresponse lossでもtemp proofを失わず、別writerの同digest targetを本operationの成果として受理しない
  - worker bind後かつpublish command直前にparentを外部directoryへのsymlink/junctionへ差し替えるdirect regressionを追加し、外部target/tempが作られないことを確認する。Windowsでcwd lockが差し替えを拒否する`EBUSY/EPERM`もpath identity failureへ収束する
  - MCP transport response lossはinline transcriptを`not_applied`、SessionFolder transcriptを`indeterminate`へ投影するdirect contractを追加した
- Provider parity: Codex/Copilot両方のSession create、Turn options、run、enqueue、CLI/MCP dispatchを再実行し、catalog候補を縮小せずend-to-end supportを維持した
- Current direct checks:
  - transcript/provider/CLI/MCP targeted set: 160 passed、0 failed
  - transcript service exact race/recovery set: 12 passed、0 failed
  - `npm test`: passed、0 failed
  - `npm run typecheck`: passed
  - `npm run build`: passed。既存のLightning CSS selector warningとVite chunk-size warningのみ
  - `git diff --check`: passed with line-ending warnings only
- Candidate c4では`F-TRANSCRIPT-PUBLISH-TOCTOU`とMCP transcript effect deltaだけをtargeted closureへ渡す。interactionと他specialist cellはproduction delta非影響をsource identityで確認する。全trigger済みcellが同一Candidateへ揃った後、`Full-review gate=run`に従いfresh reviewerへcomplete diffを一度だけ渡す
- security境界の選択理由は`docs/adr/023-identity-bound-sessionfolder-file-effects.md`を正本とする。完了時cleanupはtemporary fileと同一identityのpublish proofだけを除去し、別fileを削除しない

### Holistic Candidate c5 Finding Promotion

- Gate: `ready`
- `F-ATTACH-IDENTITY-PERSIST`: admissionで検証・正規化したattachment identityをexecutionへ保存せず、dispatch時に欠落する。shared execution coordinator内の`current-scope repair`として、validatorの戻り値をcanonical internal requestとして保存・dispatchする
- `F-SNAPSHOT-CROSS-INSTANCE-CLEANUP`: OS temp全体のprefix sweepが、異なる`userData`で同時起動中の別WithMate instanceのactive snapshotを削除する。snapshot lifecycle内の`current-scope repair`として、single-instance lock domainと同じ`userData`由来namespaceだけをcleanupする
- `F-TRANSCRIPT-FIELD-TITLE`: canonical interaction fieldの`title`をtranscriptが旧`label`として読んで欠落させる。transcript projection owner内の`current-scope repair`として、public `label`へ`title`を写す
- Folder snapshotのaggregate byte/file/depth budgetは新しいresource-limit contractを要求するため、現Candidateへ加えないhardening follow-upとする
- `ATTACH-SNAPSHOT-OWNER-01`: 同じ`userData`のsingle-instance lock holderだけがexact namespaceの前process orphanを削除し、別namespace、legacy global root、unrelated entryを変更しない。namespaceとsnapshot rootは内容書込前にcurrent-user boundaryへsecureし、検証不能ならfail closedする
- Direct verification: normalized requestのstorage/dispatch、canonical interaction titleのtranscript投影、userData A/B namespace isolation、同namespace orphan cleanup、legacy/unrelated preservation、Windows permission-before-writeを対象testで確認する
- Knowledge placement: request normalizationとsnapshot namespaceはsource/type、不変条件はtest、lockとcleanupの結合は`main.ts`、userData namespaceとPID/TTLを退ける長期concurrency判断は独立ADRへ置く
- Review: Candidate c5のcomplete-diff holistic reviewは既に一度実施済み。修正後Candidateではfinding familyとresulting deltaだけをtargeted closureし、complete-diff reviewを再実行しない

### Candidate c6 Targeted Finding and c7 Closure

- Candidate c6のtranscript field targeted closureはblockingなしでclosedした。attachment identity targeted closureでは、validation後に`RunSessionTurnRequest`単体を永続化し、dispatchが要求する`catalogRevision`とprovider discriminatorを失う`F-ATTACH-IDENTITY-PERSIST`同familyの反例を確認した
- Finding Promotion: 新規external `turn.run` / `turn.enqueue`から通常到達し、attachment有無やproviderを問わずdispatch前に`PROVIDER_FAILURE`へ収束する。shared execution request composition owner内の`blocking / current-scope repair`として閉じる
- Repair delta: execution envelopeのparseとvalidation後の再構成を専用境界へ抽出し、`catalogRevision`、Codex/Copilot discriminator、identity付与済みTurnをcanonical internal envelopeとして永続化する
- Direct verification: red testでmodule不在時の失敗を確認後、validation済みCopilot Turnを再parseしてrevision、provider、attachment identityが保持されることを確認した。execution、attachment、provider application、CLI、MCPの関連109 testも通した
- Candidate c7では`validate → persist → dispatch parse`のround-tripとsnapshot namespace deltaだけを同じattachment reviewerへtargeted closureし、transcript cellはc6以降のdelta非影響を同じtranscript reviewerへ確認する。complete-diff reviewは再実行しない
- Final Candidate: `session-external-runtime-final-c7`。manifest-digest Candidateはtask-local planを除外して固定し、review前後ともverification `verified`
- Current direct evidence:
  - execution/provider/CLI/MCP targeted set: 109 passed、0 failed
  - `npm test`: 2563 tests、2562 passed、1 skipped、0 failed
  - `npm run typecheck`: passed
  - `npm run build`: passed。既存のLightning CSS `::highlight` warningとVite chunk-size warningのみ
  - `git diff --check`: passed with line-ending warnings only
- Targeted closure:
  - attachment identity/execution envelope cellは33 scoped testsとCodex/Copilot双方の追加round-trip checkを行い、blocking 0でapprove
  - transcript title/label delta cellは13 direct testsとc6/c7 manifest比較を行い、production delta非影響、blocking 0でapprove
- Final review state: holistic complete-diff reviewはCandidate c5で一度だけ実施済み。Candidate c7ではfinding familyとresulting deltaのtargeted closureだけを行い、未解決blocking、accepted-risk candidate、material validation gapはない
- Residual hardening: folder snapshotのaggregate byte/file/depth budgetは新しいresource-limit contractを要するため、現論理変更には含めない
