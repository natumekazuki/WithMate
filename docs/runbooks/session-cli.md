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
withmate-session turn cancel --json '{"sessionId":"SESSION_ID","executionId":"EXECUTION_ID","idempotencyKey":"CANCEL_KEY"}'
```

`turn options`は対象Sessionのproviderに応じた候補を返す。Codex Turnは`provider: "codex"`と`codexSandboxMode`、Copilot Turnは`provider: "copilot"`と`customAgentName`を指定する。provider固有fieldを混在させない。

```powershell
withmate-session turn run --json '{"sessionId":"SESSION_ID","catalogRevision":1,"idempotencyKey":"run-codex-001","responseMode":"deferred","turn":{"provider":"codex","userMessage":"確認して","model":"gpt-5.4","reasoningEffort":"high","approvalMode":"on-request","codexSandboxMode":"workspace-write"}}'
withmate-session turn enqueue --json '{"sessionId":"SESSION_ID","catalogRevision":1,"idempotencyKey":"run-copilot-001","turn":{"provider":"copilot","userMessage":"確認して","model":"claude-sonnet","reasoningEffort":"high","approvalMode":"on-request","customAgentName":""}}'
```

source Turnが`failed`または`interrupted`になった場合だけ、別の通常Sessionへ通知TurnをFIFO登録するには、`turn run`または`turn enqueue`へ通知先を明示する。

```powershell
withmate-session turn run --json '{"sessionId":"SOURCE_SESSION_ID","catalogRevision":1,"idempotencyKey":"run-with-terminal-notify-001","responseMode":"deferred","terminalFailureNotification":{"targetSessionId":"TARGET_SESSION_ID"},"turn":{"provider":"codex","userMessage":"確認して","model":"gpt-5.4","reasoningEffort":"high","approvalMode":"on-request","codexSandboxMode":"workspace-write"}}'
```

通知先は自動補完されない。sourceと同じSession、存在しないSession、通常Session以外はsource execution作成前に拒否される。同じidempotency keyを再送するときは同じ通知先を指定する。通知先だけを変更するとconflictになる。

execution resultの`terminalFailureNotification`は、未設定なら`null`、待機中は`armed`、`completed`または`canceled`では`not_triggered`、配送中は`pending`、登録後は`enqueued`、配送不能または期限切れでは`failed`になる。`enqueued`の`notificationExecutionId`は通知先Sessionの`turn get`で追跡できる。通知配送の失敗はsource executionのterminal stateを変更しない。

## Session操作

通常Sessionの作成、一覧、取得、名前変更を公開する。

```powershell
withmate-session session create --json '{"title":"計画を分解する","sessionRole":"task-coordinator","provider":"codex","catalogRevision":1,"workspace":{"kind":"directory","path":"C:\\work"},"idempotencyKey":"create-20260812-001"}'
withmate-session session create --json '{"title":"実装する","sessionRole":"executor","provider":"copilot","catalogRevision":1,"workspace":{"kind":"session_folder"},"idempotencyKey":"create-copilot-20260812-001"}'
withmate-session session list --json '{}'
withmate-session session get --json '{"sessionId":"SESSION_ID"}'
withmate-session session rename --json '{"sessionId":"SESSION_ID","title":"新しい名前","idempotencyKey":"rename-20260812-001"}'
```

`session.create`は現在のbinding actorのchildだけを作成する。`overall-coordinator`は`task-coordinator`または`executor`、`task-coordinator`は`executor`を作成できる。`standalone`と`executor`はchildを作成できない。actor、parent、root、depth、Character identityは入力せず、WithMateがcurrent bindingから導出する。

`session.self`、`session.create`、`session.list`、`session.get`は`sessionRole`、`roleContractRevision`、`rootSessionId`、`parentSessionId`、`delegationDepth`を同じ形で返す。`runtime catalog`はRole contract revision、対応Role、child規則、最大depthを返す。

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

実行中にproviderから確認が返った場合は、`interaction list`でpending interactionを取得し、`interaction respond`で回答する。`responseMode:"wait"`では回答後の次のpendingまたはterminal executionまで待つ。

```powershell
withmate-session interaction list --json '{"sessionId":"SESSION_ID","state":"pending"}'
withmate-session interaction respond --json '{"sessionId":"SESSION_ID","executionId":"EXECUTION_ID","interactionId":"INTERACTION_ID","response":{"kind":"approval","decision":"approve"},"idempotencyKey":"respond-20260813-001","responseMode":"wait"}'
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

MCP clientにはこのcommandをserver commandとして登録する。公開toolは既存18操作と`coordination.event.create`、`list`、`get`、`resolve`、`cancel`、`correct`の計24操作で、入力shapeはMCPの`tools/list`を正本とする。すべてのapplication toolはvalidなAgent runtime bindingを必要とする。application errorはversioned error envelopeと`isError: true`で返る。terminal `failed` executionはoperation受付済みのresultであり、tool errorではない。

## Coordination event

通常responseと別に進行や判断を記録する場合は、CLIで`coordination event create|list|get|resolve|cancel|correct --json <input>`を使う。mutationにはcaller-owned idempotency keyが必須である。responseを失った場合は同じkeyの`coordination event get`、既知のevent ID、または同一input・同一keyのreplayでcanonical resultを再照合する。

`list`のscopeは`self`または`subtree`で、subtreeはcoordinatorだけが使える。default limitは50、maximumは100である。cursorはprincipal Session、scope、kind、stateへ結び付くため、別Sessionまたは別filterへ流用しない。権限外、cross-root、非ancestorは存在を区別せず拒否される。

`user_decision_required`はCLI/MCP/HTTPからresolveできない。Session右ペインのtrusted GUIでstable option IDを選択する。保存内容へsecret、raw log、stack trace、大きなdiff、provider response、chain-of-thought、個人環境path、binding参照を含めない。
