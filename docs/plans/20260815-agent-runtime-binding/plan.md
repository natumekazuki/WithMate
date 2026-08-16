# Issue 298 Agent runtime binding implementation plan

## Scope

WithMateが起動したprovider executionから、callerの自己申告ではなくruntimeがactor Sessionを解決する共通identity基盤を追加する。

初期適用範囲は次のとおりとする。

- Session scopeを持つCharacter context / affect操作: `required`
- 明示targetを維持するagent-facing Memory CRUD: `optional`
- operator診断、Affect reset、migration系操作: `none`
- bound Agentはuser-global、明示Project、自SessionのCharacterを操作できるが、別Character ownerは操作できない
- Session / Turn mutationとCoordination Event: Role契約と公開endpointが未導入のため、本Issueでは有効化しない

## Pre-Implementation Closure Plan

### ARB-1 Actor identity

- Accepted contract / exact anchor: ISSUE-298の「actorとtargetを分離する」「runtime binding」。actor Sessionはruntime bindingだけから解決し、request body、CLI引数、promptのSession IDをauthority根拠にしない。provider environmentへ渡すのはopaque referenceだけとする。
- Scope / semantic owner: Electron main processのagent runtime binding registryとHTTP application boundary。
- Failure mode / consumer impact: callerがSession IDを書き換えて別actorのauthorityを得る。required操作が自己申告Sessionへ作用する。
- State transitions / failure timing: request admission後、body validationとapplication service呼出しより前にbindingを解決する。actor session fieldとnested affect candidateのsession fieldは解決済みactorへ正規化する。
- Direct verification: bindingなし、unknown/revoked reference、request内の別session ID、別target指定を含むHTTP/MCP/CLI test。
- Independent review trigger: authorization bypassとprivate field projectionをtargeted reviewerで反証する。
- Gate: ready

### ARB-2 Generation and revocation lifecycle

- Accepted contract / exact anchor: ISSUE-298の「provider processへの注入」「Session削除、provider execution再生成、app終了時に失効」「同一generation内のretry/read-back」。
- Scope / semantic owner: registryのsession/provider execution generationとSession/provider lifecycle hook。
- Failure mode / consumer impact: stale referenceが新generationまたは削除済みSessionで有効になる。retryだけでactor identityが変わる。
- State transitions / failure timing: create/reuse、provider retry、provider execution invalidation、Session delete、app shutdown。generation維持retryはreuseし、再生成は旧bindingを先に失効させる。`expiresAt`は発行前に正規化・検証し、正規化後の値が一致する場合だけbindingをreuseする。
- Direct verification: reuse、期限変更時のrotate、意味的に同じ期限のreuse、不正期限のpre-issue rejection、delete、revoke-all、expiry、stale generation、response-loss後read-backのregistry/runtime integration test。
- Independent review trigger: provider cacheとbinding generationの不一致をtargeted reviewerで反証する。
- Gate: ready

### ARB-3 Endpoint binding policy

- Accepted contract / exact anchor: ISSUE-298の`required` / `optional` / `none`表と初期適用範囲。
- Scope / semantic owner: WithMate-owned HTTP route table。runtime exchange経路とdirect HTTP経路は同じpolicy resolverを使う。
- Failure mode / consumer impact: required routeがbindingなしでserviceへ到達する。optional routeがimplicit targetを復活させる。none routeがbindingにより権限昇格する。
- State transitions / failure timing: route解決後、request body dispatch前。optionalでbinding referenceが提示された場合、invalid referenceはlocal-userへfallbackしない。
- Direct verification: 全routeがpolicyを宣言するstatic test、各policyのHTTP test、service spyによるpre-dispatch rejection test。
- Independent review trigger: route aliasまたはruntime exchangeからのpolicy迂回をtargeted reviewerで反証する。

provider executionでは非secretのbinding-required markerもexecution-scoped environmentへ渡し、managed MCP/CLIがreference欠落を検出した場合はoptional routeをlocal-userへdowngradeせずdispatch前に拒否する。外部terminalはmarkerを持たず、別認証によるoptional経路を維持する。
- Gate: ready

### ARB-4 Generic authority snapshot

- Accepted contract / exact anchor: ISSUE-298のbinding record、authority検証、関連Issueの実装順。現行baseにはSessionRole、root/parent、Role contract revisionのaccepted contractがない。
- Scope / semantic owner: registryはopaqueなrole snapshotとoperation grantを保持・検証できるgeneric APIを所有する。現行Character/Memory operation grantだけをIssue本文から与える。
- Failure mode / consumer impact:存在しないRole/default permissionを発明し、将来のSession/Turn endpointへ誤ったauthorityを固定する。
- State transitions / failure timing: binding発行時にauthority snapshotをコピーし、resolve時にoperation grantを検証する。Session/Turn mutationはRole snapshotの正本が導入されるまで公開しない。
- Direct verification: operation不足、actor不在、別target authorizer拒否のregistry test。
- Independent review trigger: generic APIが暗黙のroot Roleや全権限を与えていないかをtargeted reviewerで反証する。
- Gate: ready

### ARB-5 Provider isolation and cache

- Accepted contract / exact anchor: ISSUE-298の「process.envを書き換えない」「sessionまたはprovider execution scoped client」「並行Sessionを混線させない」。
- Scope / semantic owner: provider runtime input、Codex adapter client/thread cache、provider capability projection。
- Failure mode / consumer impact:Session Aのclient/processがSession Bのreferenceを継承する。global process.envの一時変更が並行turnへ漏れる。
- State transitions / failure timing: client create/cache/reuse、thread create/resume、invalidate/rotate。binding IDはcache identityに含めるがreference本体はsettings keyやlogへ入れない。
- Direct verification:並行Session別env、同generation reuse、rotate後client再生成、process.env不変、unsupported provider capability test。
- Independent review trigger: cache keyとgeneration cleanupをtargeted reviewerで反証する。
- Gate: ready

### ARB-6 MCP/CLI transport and redaction

- Accepted contract / exact anchor: ISSUE-298の「MCP transport session IDをWithMate Session IDとして扱わない」「外部CLIの--session-idはactor authorityにならない」「secretをprompt/UI/通常logへ出さない」「third-party MCPへauthorityを自動付与しない」。
- Scope / semantic owner: managed WithMate Memory MCP/CLI runtime clientだけがenvironmentのopaque referenceをidentity challenge後のruntime exchange envelopeへ転送する。provider promptとthird-party MCP configは対象外。
- Failure mode / consumer impact: transport sessionやCLI引数がactorになる。reference/secret/permission detailがresponse/logへ漏れる。全MCPへauthorityが拡散する。
- State transitions / failure timing: discovery、runtime exchange、operation dispatch、error mapping。required CLIはbindingなしで拒否する。
- Direct verification: MCP tool inputからactor Session IDを省略、CLI explicit session IDだけではrequired操作を拒否、challenge後のexchange envelope転送、response/log redaction、prompt非包含のtest。
- Independent review trigger: secret-bearing projectionとthird-party propagationをtargeted reviewerで反証する。
- Gate: ready

### ARB-7 Copilot provider parity

- Accepted contract / exact anchor: ISSUE-298のprovider process注入、generation維持retry、失効、並行Session分離と、CopilotをCodexと同じbinding仕様へ対応させるユーザー要求。`@github/copilot-sdk`のstdio runtimeはclient作成時の`env`をchild runtimeへ渡す。
- Scope / semantic owner: provider binding capability、registry発行判定、Copilot adapterのsession-bound client cacheとbackground unbound client cache。
- Failure mode / consumer impact: Copilot Sessionがbindingを受け取れない、Electron mainのambient bindingを継承する、別Sessionまたは旧generationのclientを再利用する、Session/provider/app失効後もbound client processが残る。
- State transitions / failure timing: bound client create、background unbound client create、session bootstrap前後、same-generation reuse、recoverable connection retry、generation rotate、Session invalidate、provider-wide invalidate、app shutdown。recoverable connection retryは同じlogical execution generationとして同じbindingを再利用する。supported Session入力でbindingが欠落した場合はclient cache参照前に拒否する。
- Direct verification: Copilot client options/env、A/B generation cache identity、supported Sessionのbinding欠落拒否、大小文字違いを含むbackground unbound scrub、`process.env`不変、bootstrap失敗後のsame-generation retry、Session/all invalidation時のclient stop、graceful stopのerror result/reject/timeoutからforce stopへの移行、app shutdownのcleanup await、provider capability/registry test。
- Independent review trigger: Copilot client cacheとbinding generation、ambient env scrub、lifecycle cleanupをtargeted reviewerで反証する。
- Gate: ready

### ARB-8 Auxiliary actor and lifecycle

- Accepted contract / exact anchor: Auxiliary SessionもWithMateが起動するprovider executionであり、ユーザー確認済み方針として通常Sessionと同じruntime identityを持つ。actor resolverは通常SessionとAuxiliary Sessionを同じcanonical boundaryで解決する。
- Scope / semantic owner: Auxiliary Session runtime wiring、actor Session resolver、binding registry lifecycle、provider client cache。
- Failure mode / consumer impact: Auxiliaryがunbound/background clientへ合流し、別Sessionのexecutionを共有する。close/delete後もbindingまたはprovider processが残る。
- State transitions / failure timing: Auxiliary create/load、turn開始、retry、close/delete、parent close、provider regeneration、app shutdown。
- Direct verification: Auxiliary binding発行、actor解決、通常Sessionとのcache分離、close/delete失効、same-generation retry reuseのintegration test。
- Independent review trigger: 通常SessionとAuxiliary Sessionのactor resolver、provider cache、失効順序をtargeted reviewerで反証する。
- Gate: ready

### ARB-9 Memory actor authority and target scope

- Accepted contract / exact anchor: ユーザー確認済み方針として、Agentはユーザーの代理でMemory CRUDを自己判断して行う。bindingは権限をlocal-userより狭めるためではなくactor/source/idempotencyを確定するために使う。ただしactor SessionのCharacter以外をownerとするCharacter / Character+Project targetは拒否し、target自体は常にrequestで明示する。
- Scope / semantic owner: Memory route binding policy、request-scoped principal、target resolver、Character Context application service、move source/destination authorization。
- Failure mode / consumer impact: Character appendがlocal-userとして記録される。別Session間でidempotency namespaceが衝突する。Agentが別Character MemoryをCRUDできる。`none` routeがbinding principalを捨ててtarget上限を迂回する。
- State transitions / failure timing: binding resolve、target resolve、search/get/append/correct/forget/move admission、idempotent replay、response loss read-back。target authorizationはstorage side effect前に完了する。
- Direct verification: user-global/Project/自Character CRUD許可、別Characterと別Character+Projectの全CRUD拒否、moveのsource/destination拒否、Character append principal分離、bindingなしlocal-user互換のservice/HTTP/MCP test。
- Independent review trigger: actor Characterとowner targetのcoupled authorization、Character専用routeとgeneral Memory routeのparityをtargeted reviewerで反証する。
- Gate: ready

### ARB-10 Companion retirement boundary

- Accepted contract / exact anchor: ユーザー確認済み方針としてCompanion Modeは退役済みとする。新規Companion作成、新規provider turn、CompanionからのAuxiliary起動は受け付けない。既存履歴の閲覧、merge、discardはデータ整理のため維持する。
- Scope / semantic owner: Companion Session作成service、Companion runtime、rendererのcomposer/Auxiliary導線、Companion設計文書。runtime bindingのactor scopeにはCompanionを含めない。
- Failure mode / consumer impact: hidden UIまたは内部IPCから退役済みprovider executionを起動し、bindingなしのoptional Memory経路へ到達する。既存Companionを整理できなくなる。
- State transitions / failure timing: create/preview/run/Auxiliary launchはworkspace作成、provider client取得、Session更新より前に拒否する。list/open/review/merge/discardは維持する。
- Direct verification: createとturnがside effect前に拒否されるservice test、rendererでcomposer/Auxiliaryが無効になるprojection test、merge/discard既存test。
- Independent review trigger: 退役済み実行入口の残存と、履歴整理経路の過剰停止をtargeted reviewerで反証する。
- Gate: ready

### ARB-11 Shutdown settlement

- Accepted contract / exact anchor: ISSUE-298のapp終了時失効とresource lifecycle。provider cleanup、binding revoke、persistent store closeの個別失敗があっても終了処理はsettleし、Electronの再quitへ到達する。
- Scope / semantic owner: AppLifecycleServiceのquit cleanup orchestration。
- Failure mode / consumer impact: `preventDefault()`後にcleanup promiseがrejectしたまま保持され、アプリが終了不能になる。
- State transitions / failure timing: provider invalidation、binding revoke、store closeをbest-effortで順に実行し、最後にcleanup完了状態を確定して`quitApp()`を一度呼ぶ。
- Direct verification: provider cleanup、binding revoke、store closeの各throw/rejectでもquitへ到達し、再要求でcleanupを重複実行しないlifecycle test。
- Independent review trigger: cleanup failure timingと再入をtargeted reviewerで反証する。
- Gate: ready

### ARB-12 Managed MCP binding preflight

- Accepted contract / exact anchor: ISSUE-298のrequired binding failure contractとWithMate Memory Skillの「transport availability failureだけCLI fallback」。required marker付きでreferenceが欠落した場合はauthority/usage rejectionであり、transport failureではない。
- Scope / semantic owner: managed Character/Memory MCPのruntime dispatch前binding preflightとstructured error mapping。
- Failure mode / consumer impact: binding欠落をretryable transport errorとして返し、CLI fallbackや無駄なretryを誘発する。
- State transitions / failure timing: runtime discovery後、request timeout開始とruntime dispatchより前にbinding referenceを解決する。欠落はnon-retryable、effect `none`、dispatch回数0で返す。
- Direct verification: Character MCPとgeneral Memory MCPのrequired marker/reference欠落test、runtime dispatch spy、Skill fallback契約test。
- Independent review trigger: sibling MCP経路のerror taxonomyとdispatch timingをtargeted reviewerで反証する。
- Gate: ready

## Closure Map

- Entry points: direct HTTP、runtime exchange、managed MCP、managed CLI、provider turn、provider retry、Companion create/turn、Session delete、app shutdown。
- State transitions: issue/reuse、expiry normalize/rotate、resolve、revoke session、revoke all、expired/unknown、provider unsupported、Copilot recoverable connection retry、Companion retired rejection。
- Failure timing: admission前、service dispatch前、provider client create、Companion workspace/provider side effect前、retry前、Session storage delete後、shutdown cleanup settlement。
- Scope: binding item、Session/provider generation、process全体。Memory targetは明示user-global/Project/Character scopeを維持し、bound actorの別Character ownerをCRUD、inventory、file usage largest-entry projectionから除外する。
- Projection: provider capability、structured error、optional Memory source attribution。reference、runtime secret、grant detailはpublic projectionへ含めない。
- Excluded siblings: Session/Turn/Coordination endpointは公開契約が未導入。悪意ある同一OS user processはdesktop appのthreat model外。third-party MCPへWithMate credential/configurationは自動投影しない。background structured promptはSession actorを持たない。退役済みCompanionはprovider executionを持たず、runtime binding actor scopeへ含めない。

## Test Matrix

| Acceptance condition | Direct check |
| --- | --- |
| actor Session IDなしで自己解決 | MCP/CLI + runtime HTTP integration |
| 全endpointがpolicy宣言 | route policy exhaustiveness test |
| required/optional/none semantics | HTTP server service-spy tests |
| explicit Memory target維持 | Memory append/search integration |
| actorをrequestで上書き不可 | Character context/affect integration |
| stale/other binding rejection | registry + HTTP integration |
| external CLI required operation rejection | CLI/runtime integration |
| operation permission検証 | registry authorization test |
| concurrent Session isolation | Codex/Copilot adapter + runtime service test |
| delete/regenerate/shutdown revoke | lifecycle tests |
| Auxiliary binding/cache/lifecycle | Auxiliary runtime + parent delete lifecycle tests |
| same generation retry/read-back | registry + runtime service retry test |
| user-global/Project/own Character許可、別Character拒否 | Memory service + Character application integration |
| file usageのlargest候補から別Characterを除外 | Memory service + storage projection test |
| optionalで空白referenceを拒否 | HTTP pre-dispatch service-spy test |
| reference/secret/grant redaction | prompt/log/response contract tests |
| supported/unsupported provider | Codex/Copilot capability、registry、unknown provider no-env test |
| expiry変更時にbindingをrotate | registry normalize/reuse/rotate test |
| supported Copilot Sessionはbinding必須 | Copilot adapter pre-cache rejection test |
| Companion create/turn退役、history整理維持 | Companion session/runtime/UI + merge/discard tests |
| cleanup失敗後もapp終了 | AppLifecycleService failure settlement test |
| MCP binding欠落はnon-retryableかつdispatchなし | Character/general MCP preflight tests |

## Validation

- targeted registry、HTTP runtime、MCP/CLI、Codex/Copilot adapter、Session runtime/lifecycle tests
- `npm run typecheck`
- `npm run build`
- Candidate snapshot verification
- authorization/policy/cache/redactionをlensとするtargeted reviewer
