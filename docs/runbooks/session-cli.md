# Session CLI 運用手順

## 目的

`withmate-session`は、起動中のデスクトップアプリが所有するSession runtimeを通じて通常Sessionを操作する。アプリケーションのdatabaseやprovider adapterへ直接アクセスしない。

## 利用条件

`schema`とtransport接続診断を除くapplication operationでは、WithMateを起動し、WithMateが発行したAgent runtime bindingを持つprovider実行内から呼び出す必要がある。Windows installerはinstall directoryへ`withmate-session.cmd`を配置する。Session CLI用のWindowsApps aliasは作成せず、Codex MCP登録はSettingsからinstall directory内のlauncher絶対pathを登録する。外部terminalからのunbound application operationはサポートしない。

Windowsのruntime credentialは`%LOCALAPPDATA%\WithMate\session-runtime`へ公開される。Windowsでは`WITHMATE_SESSION_RUNTIME_DIR`による保存先変更を受理しない。ACLを安全に確定できない場合、Session runtimeはfail closedし、CLI/MCPは利用不能になる。

runtime接続を確認する。

```powershell
withmate-session status
```

WithMateを起動せずにCLI schemaを確認する。

```powershell
withmate-session schema
```

## Turn操作

current model catalogを確認する。入力JSONは不要である。

```powershell
withmate-session runtime catalog
```

## Resource budget操作

対象Sessionのbudgetを取得する。root配下の可視account一覧は`budget list`で取得する。

```powershell
withmate-session budget get --json '{"sessionId":"<session-id>"}'
withmate-session budget list --json '{"sessionId":"<session-id>","limit":50}'
```

`budget configure`は`sessionId`、`accountId`、current `expectedRevision`、caller-owned `idempotencyKey`を必須とする。direct childへの配分作成ではtop-level `accountId`に親accountを指定し、`childAllocation`へ新しい`accountId`、canonical `childSessionId`、8項目すべての`hardLimits`を渡す。`storageBytes`は`0`に固定し、storageはroot共有accountだけで実使用量を計測・制限する。child snapshotではrootのcurrent storage投影を返し、`rootManagedDimensions`の`storageBytes`でその意味を示す。`childAllocation`と親accountのpolicy変更は併用せず、owner、authority grant、派生hierarchy fieldは入力しない。Agentは既存allocation内のsoft limitと子accountへの配分を変更し、per-execution retry limitを引き下げられる。root hard limitまたはretry limitの増加、deadline延長、expiry延長、revoked accountの復元にはtrusted userまたはissuer authorityが必要であり、Agent runtime bindingから権限を作ることはできない。

hard limit到達後またはdeadline後は新規effectを開始せず、read、cancel、result回収を続ける。token、費用、provider usageは`unknown`、`estimated`、`reported`、`settled`を区別して計測するが、hard limitとしては扱わない。rootのTurn、retry、generation ledgerが対象にするのはcanonical execution IDを持つmain Sessionの`turn.run`と`turn.enqueue`であり、そのIDを通らないauxiliaryまたはcompanionの直接provider経路は対象外である。Session Runtime経由のfile writeとtranscript exportはroot共有のstorage枠を事前reserveする。providerまたはユーザーによるSessionFolderへの直接writeは事前reserveを迂回できるため、dispatch前の再計測がunknownまたは超過なら新規dispatchを停止する。

CLIは次のTurn commandを公開する。

- `turn options`
- `turn run`
- `turn enqueue`
- `turn list`
- `turn get`
- `turn cancel`

operation inputはJSON objectとし、`--json`、`--file`、`--stdin`のいずれか一つで渡す。CLIがversioned Session runtime request envelopeへ変換する。

```powershell
withmate-session turn options --json '{"sessionId":"SESSION_ID"}'
withmate-session turn get --json '{"sessionId":"SESSION_ID","executionId":"EXECUTION_ID"}'
withmate-session turn cancel --json '{"sessionId":"SESSION_ID","executionId":"EXECUTION_ID","expectedRevision":1,"idempotencyKey":"CANCEL_KEY"}'
```

一つの委譲を複数Turnまたは再依頼にまたがって追跡する場合は、先にWork Itemを作成する。Work ItemはSessionやexecutionとは別のidentityであり、`overall-coordinator`または`task-coordinator`だけが既存の通信authorityで送信可能な直属targetへ作成できる。

```powershell
withmate-session work create --json '{"expectedContainerRevision":1,"targetSessionId":"TARGET_SESSION_ID","goal":"実装を完了する","scope":"対象moduleのみ","completionCriteria":"targeted testが成功する","authority":"対象Worktree内の変更と検証","sourceIdentity":{"workspace":null,"repository":null,"branch":null,"base":null,"head":null},"idempotencyKey":"work-create-001"}'
withmate-session work transition --json '{"workItemId":"WORK_ITEM_ID","state":"in_progress","expectedRevision":1,"idempotencyKey":"work-start-001"}'
withmate-session work revise --json '{"workItemId":"ROOT_WORK_ITEM_ID","goal":"実装を完了する","scope":"対象moduleのみ","completionCriteria":"全検証が成功する","authority":"対象Worktree内の変更と検証","expectedRevision":1,"idempotencyKey":"root-revise-001"}'
withmate-session work history append --json '{"workItemId":"ROOT_WORK_ITEM_ID","type":"handoff","summary":"公開adapterまで完了","blockers":[],"nextAction":"全体検証を実行する","expectedRevision":2,"idempotencyKey":"root-handoff-001"}'
withmate-session work history list --json '{"workItemId":"ROOT_WORK_ITEM_ID","limit":50}'
```

`work.create`はtarget Sessionのcurrent `revision`を`expectedContainerRevision`へ指定する。`turn run`または`turn enqueue`もtarget Sessionのcurrent `revision`を`expectedContainerRevision`へ指定し、top-levelへ任意の`workItemId`を渡すと、root、target、active state、actor authorityをexecution作成前に検証して関連付けを保存する。`workItemId`はTurnのidempotency fingerprintへ含まれるため、同じkeyで関連先だけを変更するとconflictになる。executionのterminal stateはWork Itemを暗黙に完了させない。target Sessionが`work result`で`completed`、`partially_completed`、`failed`のstateとstrict resultを同時に報告する。creator Sessionは非terminal Work Itemを`work cancel`で取消せる。全mutationはcurrent revisionとidempotency keyを要求する。

直属子を持つWork Itemでは、親のtarget Sessionが`work aggregation get/list`でbounded summaryを取得し、terminalな直属子へ`work aggregation decide`または`work aggregation retry`を実行する。`retry`はdecisionとreplacement Work Itemを同一transactionで作成する。すべての直属子がterminalかつdecision済みになった後、`work result`へcurrent `expectedAggregateRevision`を指定して親resultを確定する。孫Work Itemは親集約へ直接含めず、result本文の詳細は`work get`で取得する。

`turn options`は対象Sessionのproviderに応じた候補を返す。Codex Turnは`provider: "codex"`と`codexSandboxMode`、Copilot Turnは`provider: "copilot"`と`customAgentName`を指定する。provider固有fieldを混在させない。

Agent起点の`turn run`と`turn enqueue`は、runtime bindingで確定したactorとtargetのcanonical Role bindingに対して次の送信matrixを適用する。

| actor Role | 許可するtarget |
| --- | --- |
| `standalone` | actor自身のみ |
| `overall-coordinator` | actor自身、直属の`task-coordinator`、直属の`executor` |
| `task-coordinator` | actor自身、直属の`executor`、rootの`overall-coordinator`、同じrootかつ同じ親の兄弟`task-coordinator` |
| `executor` | actor自身、直属の親（`overall-coordinator`または`task-coordinator`） |

異なるroot、`overall-coordinator`から孫executor、`executor`から兄弟または別branch、存在しないtargetはexecutionまたはqueue作成前に拒否される。requestへactor Role、root、parent、depthを指定してもauthorityには使われない。GUIからユーザーが直接送信するTurnは別のtrusted invocation境界であり、このAgent間matrixを適用しない。`runtime catalog`の`sessionTurnCommunicationContractRevision`で対応する通信契約revisionを確認する。

```powershell
withmate-session turn run --json '{"expectedContainerRevision":1,"sessionId":"SESSION_ID","catalogRevision":1,"idempotencyKey":"run-codex-001","responseMode":"deferred","turn":{"provider":"codex","userMessage":"確認して","model":"gpt-5.4","reasoningEffort":"high","approvalMode":"on-request","codexSandboxMode":"workspace-write"}}'
withmate-session turn enqueue --json '{"expectedContainerRevision":2,"sessionId":"SESSION_ID","catalogRevision":1,"idempotencyKey":"run-copilot-001","turn":{"provider":"copilot","userMessage":"確認して","model":"claude-sonnet","reasoningEffort":"high","approvalMode":"on-request","customAgentName":""}}'
```

source Turnが`failed`または`interrupted`になった場合だけ、別の通常Sessionへ通知TurnをFIFO登録するには、`turn run`または`turn enqueue`へ通知先を明示する。

```powershell
withmate-session turn run --json '{"expectedContainerRevision":1,"sessionId":"SOURCE_SESSION_ID","catalogRevision":1,"idempotencyKey":"run-with-terminal-notify-001","responseMode":"deferred","terminalFailureNotification":{"targetSessionId":"TARGET_SESSION_ID"},"turn":{"provider":"codex","userMessage":"確認して","model":"gpt-5.4","reasoningEffort":"high","approvalMode":"on-request","codexSandboxMode":"workspace-write"}}'
```

通知先は自動補完されない。sourceと同じSession、存在しないSession、通常Session以外はsource execution作成前に拒否される。同じidempotency keyを再送するときは同じ通知先を指定する。通知先だけを変更するとconflictになる。

execution resultの`terminalFailureNotification`は、未設定なら`null`、待機中は`armed`、`completed`または`canceled`では`not_triggered`、配送中は`pending`、登録後は`enqueued`、配送不能または期限切れでは`failed`になる。`enqueued`の`notificationExecutionId`は通知先Sessionの`turn get`で追跡できる。通知配送の失敗はsource executionのterminal stateを変更しない。

## Session操作

通常Sessionの作成、一覧、取得、設定変更、移動、複製、復元、archive、deleteを公開する。

```powershell
withmate-session session create --json '{"expectedContainerRevision":1,"placement":{"kind":"child","parentSessionId":"ACTOR_SESSION_ID","sessionRole":"task-coordinator"},"title":"計画を分解する","character":{"characterId":"CHARACTER_ID","expectedDefinitionSha256":"DEFINITION_SHA256"},"provider":{"id":"codex","catalogRevision":1,"model":"MODEL_ID","reasoningEffort":"medium","threadContinuity":"reset","approvalMode":"on-request","codexSandboxMode":"workspace-write","allowedAdditionalDirectories":[]},"workspace":{"kind":"directory","path":"C:\\work"},"initialGrant":{"kind":"inherit"},"budget":{"kind":"inherit"},"idempotencyKey":"create-20260812-001"}'
withmate-session session list --json '{}'
withmate-session session get --json '{"sessionId":"SESSION_ID"}'
withmate-session session configure --json '{"sessionId":"SESSION_ID","expectedRevision":1,"kind":"title","title":"新しい名前","idempotencyKey":"configure-20260812-001"}'

`session configure` の `workspace` と `character` は `threadContinuity`（`reset` または `continue`）を明示する。`session restore` の provider tuple も既存 thread の継続または reset を選択できる。
withmate-session session rename --json '{"sessionId":"SESSION_ID","expectedRevision":1,"title":"新しい名前","idempotencyKey":"rename-20260812-001"}'
withmate-session session move-manifest --json '{"sessionId":"SESSION_ID","destinationRootSessionId":"DESTINATION_ROOT_SESSION_ID"}'
withmate-session session delete-manifest --json '{"sessionId":"SESSION_ID"}'
```

`session.create`はrootまたはchild placementを明示する。childではparentとRole、rootではrootKindを指定し、Character identity、provider実行tuple、Workspace、initial grant、budgetを省略しない。actor、root、depth、grant上限は保存済みbindingとactive grantから再評価される。新規Sessionのprovider thread continuityは`reset`だけを受理する。

`session.self`、`session.create`、`session.list`、`session.get`は`revision`、`sessionRole`、`roleContractRevision`、`rootSessionId`、`parentSessionId`、`delegationDepth`を同じ形で返す。mutationは対象またはcontainerのcurrent revisionを要求し、各操作へcaller-owned `idempotencyKey`を渡す。`session.move.manifest`と`session.delete.manifest`はread-onlyで、deleteは取得済みmanifest revisionをmutationへ要求する。`runtime catalog`の`baselineChildSessionRoleTemplates`はbaseline grant発行時のtemplateであり、現在のactorに対する認可結果ではない。

`session.delete`はSlice 3では物理削除ではなくtombstoneへ遷移する。Sessionの履歴、budget ledger、retry identity、SessionFolder workspaceは保持する。directory workspaceに付随するSessionFolderの既存cleanup経路は維持する。retention期間と履歴・ledgerを含むpurge範囲を定義するphysical purgeは後続の別変更とする。

Copilotの標準provider tupleでは`customAgentName`に空文字列を指定する。Codexのtupleへ`customAgentName`を混在させず、Copilotのcustom agentを選ぶ場合だけ名称を指定する。

`session.create`と`session.rename`の`idempotencyKey`は必須で、callerが生成して保持する。response loss後の再送では同じkeyを使う。create keyはactorごとのscopeであり、同じactorでRoleまたは他のcreate入力を変えて再利用すると`IDEMPOTENCY_CONFLICT`になる。

`runtime catalog`に出るproviderは、外部Session runtimeが対応し、かつSettingsで有効なproviderだけである。現在はCodexとCopilotを利用できる。Session作成後は対象Sessionと同じproviderをTurnへ指定する。

## SessionFolder操作

対象SessionのSessionFolderにあるfileを、相対pathで一覧、UTF-8 text読取、UTF-8 text書込できる。absolute path、`..`、symlinkまたはjunctionを経由するpathは受理しない。

```powershell
withmate-session session files list --json '{"sessionId":"SESSION_ID"}'
withmate-session session files read-text --json '{"sessionId":"SESSION_ID","relativePath":"notes/brief.md"}'
withmate-session session files write-text --json '{"sessionId":"SESSION_ID","relativePath":"notes/brief.md","content":"本文","idempotencyKey":"write-20260812-001"}'
```

listの`limit`は既定50、最大500である。read/writeの`maxBytes`は既定1 MiB、最大8 MiBであり、超過時はtruncateせず失敗する。Windows版v6.4では新規fileだけを書き込める。既存fileへの`"replace":true`は安全なidentity-bound置換primitiveがないため`not_applied`でfail closedする。`idempotencyKey`はcallerが生成して保持し、response loss後の再送では同じkeyを使う。

## InteractionとTranscript

実行中にproviderから確認が返った場合は、`interaction list`でpending interactionの`decisionClass`と`revision`を取得する。provider approvalとelicitationは現在`user_only`であり、Agent bindingを使うCLIの`interaction respond`では回答できない。WithMateのtrusted GUIからユーザーが回答するまで待機する。

```powershell
withmate-session interaction list --json '{"sessionId":"SESSION_ID","state":"pending"}'
```

Transcriptはpublic message、Turn、interaction projectionだけから生成される。inlineはJSONまたはMarkdownを返し、SessionFolder出力は同一SessionFolder配下へatomic publishする。SessionFolder出力ではresponse loss後も同じ`destination.idempotencyKey`で再送する。

SessionFolder出力もWindows版v6.4では新規targetだけを公開できる。既存targetへの`replace:true`は`EXPORT_FAILED`、`retryable:false`、`effect:"not_applied"`で拒否されるため、別のrelative pathを指定する。

```powershell
withmate-session transcript export --json '{"sessionId":"SESSION_ID","format":"json","maxBytes":1048576,"destination":{"kind":"inline"}}'
withmate-session transcript export --json '{"sessionId":"SESSION_ID","format":"markdown","maxBytes":67108864,"destination":{"kind":"session_folder","relativePath":"exports/transcript.md","replace":true,"idempotencyKey":"export-20260813-001"}}'
```

既定はJSON出力である。人が読む要約には`--format text`を使う。scriptはJSON出力を使い、messageではなく`ok`、`error.code`、`error.retryable`、`error.effect`を判定する。

## Exit code

| Exit code | 意味 |
| --- | --- |
| `0` | 成功 |
| `1` | CLI usageまたはinput parse失敗 |
| `2` | runtime未起動、dispatch前の接続失敗、またはidentity mismatch |
| `3` | Session application error |
| `4` | operation requestがdispatchされた可能性のあるtransport failure |

exit code `4`の後は、同じidentifierでoperation状態を確認し、mutationを再送する場合は同じidempotency keyを使う。

## MCP server

Session MCPは同じ配布物のstdio commandとして起動する。

```powershell
withmate-session mcp-server
```

MCP clientにはこのcommandをserver commandとして登録する。公開toolは計49操作で、Session lifecycleのmanifest read、configure、move、clone、restore、archive、deleteを含む。Work Item集約の`work.aggregation.get`、`work.aggregation.list`、`work.aggregation.decide`、`work.aggregation.retry`も含む。入力shapeと公開toolの完全な一覧はMCPの`tools/list`を正本とする。すべてのapplication toolはvalidなAgent runtime bindingを必要とする。application errorはversioned error envelopeと`isError: true`で返る。terminal `failed` executionはoperation受付済みのresultであり、tool errorではない。

## Coordination event

通常responseと別に進行や判断を記録する場合は、CLIで`coordination event create|list|get|resolve|consume|cancel|correct --json <input>`を使う。createはactor Sessionのcurrent `revision`を`expectedContainerRevision`へ、resolve、cancel、correctはeventのcurrent `revision`を`expectedRevision`へ指定する。mutationにはcaller-owned idempotency keyが必須である。responseを失った場合は同じkeyの`coordination event get`、既知のevent ID、または同一input・同一keyのreplayでcanonical resultを再照合する。

`list`のscopeは`self`または`subtree`で、subtreeはcoordinatorだけが使える。default limitは50、maximumは100である。cursorはprincipal Session、scope、kind、stateへ結び付くため、別Sessionまたは別filterへ流用しない。権限外、cross-root、非ancestorは存在を区別せず拒否される。

`user_decision_required`はCLI/MCP/HTTPからresolveできない。Coordination Windowのtrusted GUIでstable option IDを選択するか、自由回答を入力する。保存内容へsecret、raw log、stack trace、大きなdiff、provider response、chain-of-thought、個人環境path、binding参照を含めない。

回答はEventを作成したSessionの通常Turnへ、Agentが反映済みとしてconsumeするまで繰り返し渡される。回答を実作業へ反映した後にだけ、投影された`resolutionSequence`を`expectedResolutionSequence`へ指定してconsumeする。

```powershell
withmate-session coordination event consume --json '{"eventId":"EVENT_ID","expectedResolutionSequence":42,"idempotencyKey":"consume-20260822-001"}'
```

回答を確認しただけの場合、Turnが失敗した場合、またはまだ作業へ反映していない場合はconsumeしない。同じconsumeのresponseを失った場合は、同一inputと同一keyを再送する。
