# ADR 006: Session CLI control plane contract

- Status: Accepted
- Date: 2026-07-18
- Amended by: ADR 013のruntime host ownership

## Context

CP2では、既存の`ApplicationSessionOperations`をprocess境界から操作できるCLIが必要である。CLI callerは、Application responseの成功、部分成功、domain rejection、access rejection、persistence failureを区別し、write結果が不明な場合は同じrequestを再構築できなければならない。

CLIがRepository clientやPersistence Worker requestへ直接到達すると、Application Serviceが所有するvalidation、authorization、timeout、response envelopeを迂回できる。Application responseをそのままspreadすると、将来追加された内部field、database path、Worker情報、authorization contextがpublic outputへ漏れる可能性がある。また、SQLite fileやWorkspaceをCLI invocationごとの必須scopeにすると、アプリ全体でSession IDをaddressable identityとする現在のSession modelと矛盾する。

CLIはshell automation向けの初期control planeであり、human向けpretty表示、interactive prompt、daemon processは今回の対象ではない。commandのfield一覧とvalidation ruleはCLI type、parser、help、contract testを正本とする。

## Decision

executable名は`withmate`、Session namespaceは`withmate session <operation>`とする。CLI handlerは注入された`ApplicationSessionOperations`だけを呼び出す。現行operationの正本はCLI type、parser、help、contract testとする。

通常operationとparse failureのcanonical outputは、top-levelに`schemaVersion: "withmate-cli-v1"`を持つnewline終端のJSON object 1件とする。Application responseは許可したfieldだけをCLI-owned unionへ投影し、内部objectをspreadしない。directories chunkはbase64 data、encoding、byte length、offset、total bytes、eofを明示する。helpとversionだけはruntimeを起動せずhuman-readable textをstdoutへ出す。operational log、stack trace、database path、Worker情報、authorization contextはstdoutへ出さない。

Application responseとCLI固有failureのexit codeは次で固定する。numeric codeはApplication内部enumや配列順に依存しない。

| Exit code | Classification |
| ---: | --- |
| 0 | success |
| 10 | partial success。`persistence`、`effect`、`reconciliation`の詳細はJSONに保持する |
| 20 | argv usage failureまたはApplication request invalid |
| 21 | access rejection |
| 22 | domain rejection |
| 30 | timeout / cancel以外のpersistence failure、`effect=none` |
| 31 | timeout / cancel以外のpersistence failure、`effect=unknown` |
| 40 | operationまたはpersistenceのtimeout failure |
| 41 | operationまたはpersistenceのcancel failure |
| 50 | malformed Application fulfillment、bootstrap、shutdown、output、その他のinternal/runtime failure |

stdoutへoperation responseを出した後にshutdownが失敗した場合は、Application responseを失わない`lifecycle_failure`としてexit 50を返す。stdout書き込み自体が失敗した場合はexit 50と固定stderr diagnosticを使用し、stack traceを出さない。stderrも利用不能なら追加出力を保証しない。

write commandのidempotency keyはcallerがcanonical lowercase UUIDとして必須指定する。CLIは暗黙のrandom keyを生成せず、request journalも所有しない。response loss後はcallerが同じargvとkeyでexact retryし、`effect=unknown`では構造化出力の`reconciliation=exact_request_required`に従う。

Session IDを直接指定するoperationではWorkspaceを要求しない。createだけがWorkspaceのabsolute pathを受け、Application側がSessionに保持する。listはアプリ全体のSessionを既定scopeとし、型付きfilterを受ける。検索とRepository集約の判断はADR 008に従う。

production CLIは同じlocal OS userが所有するWithMate application dataを操作するapp-wide authorityとして構成する。SQLite fileはOSごとのWithMate application data locationからcomposition rootが固定解決し、CLI optionや専用environment variableで切り替えない。create時はWorkspaceと追加directoryが存在するdirectoryであることを検証する。既存Sessionのreadとlifecycle操作ではfilesystem上のWorkspace利用可否を再認証条件にせず、Run admission時のpath validationと分離する。

argv parse、help、versionはPersistence Workerを起動しない。operation実行時だけWorkerとApplication Serviceを起動し、完了、failure、timeout、cancelのいずれでもshutdownする。checkpoint failure、Worker shutdown rejection、output failureを成功扱いしない。production compositionはApplication operationとlifecycleだけをCLIへ渡し、Repository client、Repository command、raw Worker requestを渡さない。

## Alternatives

- CLI frameworkを追加する: 現行command surfaceはNode.js標準機能でboundedにparseでき、依存とpublic behaviorを増やす根拠がないため採用しない。
- operation outputをApplication responseのspreadにする: 内部fieldの追加がpublic contractへ自動流出するため採用しない。
- SQLite pathやWorkspaceを全commandの必須optionにする: application-owned databaseとSession IDによる直接addressingをCLI callerへ漏らし、Workspaceをidentity scopeと誤認させるため採用しない。
- CLIがwrite keyを毎回random生成する: response loss後に同じrequestを再構築できないため採用しない。
- idempotency request journalをCLIへ追加する: caller-owned keyでexact retryでき、journal導入は新しいpersistence ownershipを増やすため採用しない。
- Workerを常駐daemonとして共有する: process ownership、認証、upgrade、crash recoveryの追加設計が必要なため後続scopeとする。
- partial successまたは`effect=unknown`をexit 0にする: automationが完全成功と誤認するため採用しない。

## Consequences

- shell callerはJSONのdiscriminantと安定したexit codeを組み合わせて全Application response familyを判定できる。
- `effect=unknown`やshutdown failureでも、確定したApplication responseとexact retryの手掛かりを失わない。
- Sessionはアプリ全体でIDにより操作でき、Workspaceはcreate inputおよびlist filterとして扱われる。
- CLIはapp-owned databaseを使用するため、temporary databaseを使うsmoke testはOS application data root自体を隔離する必要がある。
- 同じlocal OS userに属する任意のprocessはCLI経由で全Sessionを操作できる。このauthorityを狭める場合は、transport authenticationとSession ownershipを別のaccepted contractとして追加する必要がある。
- command option、JSON field、validation上限、projection詳細はsourceとexecutable contractで変更検知し、ADRへ複製しない。
