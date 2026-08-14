# Session CLI 運用手順

## 目的

`withmate-session`は、起動中のデスクトップアプリが所有するSession runtimeを通じて通常Sessionを操作する。アプリケーションのdatabaseやprovider adapterへ直接アクセスしない。

## 利用条件

WithMateを起動しておく必要がある。Windows installerはinstall directoryへ`withmate-session.cmd`を配置する。Session CLI用のWindowsApps aliasは作成せず、Codex MCP登録はSettingsからinstall directory内のlauncher絶対pathを登録する。CLIを直接使う場合はinstall directory内のlauncherを明示するか、ユーザー自身がPATHを設定する。

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

## Session操作

通常Sessionの作成、一覧、取得、名前変更を公開する。

```powershell
withmate-session session create --json '{"title":"作業","provider":"codex","catalogRevision":1,"workspace":{"kind":"directory","path":"C:\\work"},"idempotencyKey":"create-20260812-001"}'
withmate-session session create --json '{"title":"Copilot作業","provider":"copilot","catalogRevision":1,"workspace":{"kind":"session_folder"},"idempotencyKey":"create-copilot-20260812-001"}'
withmate-session session list --json '{}'
withmate-session session get --json '{"sessionId":"SESSION_ID"}'
withmate-session session rename --json '{"sessionId":"SESSION_ID","title":"新しい名前","idempotencyKey":"rename-20260812-001"}'
```

`session.create`と`session.rename`の`idempotencyKey`は必須で、callerが生成して保持する。response loss後の再送では同じkeyを使う。

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

MCP clientにはこのcommandをserver commandとして登録する。公開toolは`runtime.catalog`、`session.create`、`session.list`、`session.get`、`session.rename`、`session.files.list`、`session.files.read_text`、`session.files.write_text`、`turn.options`、`turn.run`、`turn.enqueue`、`turn.list`、`turn.get`、`turn.cancel`、`interaction.list`、`interaction.respond`、`transcript.export`の17操作で、入力shapeはMCPの`tools/list`を正本とする。application errorはversioned error envelopeと`isError: true`で返る。terminal `failed` executionはoperation受付済みのresultであり、tool errorではない。
