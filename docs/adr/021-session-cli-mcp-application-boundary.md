# ADR 021: SessionのCLIとMCPは専用application boundaryへ接続する

## Status

Accepted

## Context

WithMateの通常Sessionをagentから作成、参照、実行するには、人向けGUIの操作手順ではなく、SessionとTurnを対象とした構造化された境界が必要である。CLIだけを提供するとagentはshell commandと表示形式へ依存し、MCPだけを提供すると接続診断やprotocol確認が難しくなる。

Sessionの永続化とprovider実行はElectron Main Processが所有している。外部processで動くCLIまたはMCP serverがSQLiteやprovider adapterへ直接接続すると、GUIとの間でvalidation、状態遷移、idempotency、認証、error semanticsが分岐する。

既存のMemoryとCharacter AffectはADR 020に従って共通runtimeへ接続している。しかし、Session操作は通常Sessionの作成、長時間のTurn実行、interaction、transcript、SessionFolderを扱う。Memoryと同じcredential、discovery、listener、public schemaへ同居させると、異なるauthorityと障害境界が一つのruntimeへ集約される。

MCPを呼び出すagent自身のSessionと、操作対象として指定するWithMate Sessionは同一とは限らない。この区別が曖昧だと、呼び出し元のworkspaceと対象SessionのWorkspaceまたはSessionFolderを混同し、WithMateに任意のhost pathを代理で読み取らせる境界を作り得る。

## Decision

### Session専用runtimeを設ける

- Electron Main Processにtransport非依存のSession application serviceを置く。
- GUIのIPC、Session CLI、Session MCPは同じapplication serviceへ接続する兄弟adapterとする。
- CLIとMCPはSQLiteまたはprovider adapterへ直接接続せず、MCP serverもCLI processを起動しない。
- Session向けのloopback listener、runtime identity、discovery、credential、route、error contractをMemory runtimeから分離する。
- Session runtimeとMemory runtimeは独立して起動、停止、障害処理を行う。一方の起動失敗を他方の停止理由にしない。
- loopback URL検証、atomicなdiscovery更新、challenge処理、safe shutdownなど、domain contractを持たない低水準helperだけを共有してよい。
- CLIとMCPは`withmate-session`配布物にまとめ、`withmate-session mcp-server`をSession MCPの入口とする。MemoryのCLIとMCPは変更しない。

### 操作対象を明示したSessionに固定する

- WithMate提供のSession CLI・MCP application operationは、すべてprovider runtime bindingを必須とする。transport credentialはCLI/MCP routeを認証し、bindingだけがactor Session IDとoperation grantを証明する。request body、prompt、workspace path、adapter種別、parent関係からactorを推測せず、binding欠落・空白・不正・失効・grant不足ではapplication serviceの副作用開始前にfail closedとする。
- Session操作、Turn操作、interaction、transcript、SessionFolder操作の対象Sessionは、`session.self`以外ではrequestの明示値を維持する。bindingから解決したactorを暗黙targetへ補完せず、現在存在しないRoleまたはhierarchy authorizationを追加しない。
- MCPを呼び出しているagentのworkspaceを暗黙の対象にしない。
- 初期surfaceは通常Sessionだけを扱い、Auxiliary Session、Companion Session、Character Authoring Sessionは対象外とする。
- Provider、Character、Workspace、Session kindは作成後に変更しない。外部surfaceで公開するmetadata変更はrenameに限定する。
- Session作成ではtitleを必須とし、自動生成または省略時のfallbackを設けない。
- CLIとMCPからSessionを作成する場合、Characterを指定する入力は公開せず、GUIのランダム選択と同じcanonical policyでCharacterを解決する。解決済みCharacterはresultへ投影する。
- Workspaceは既存directoryまたはADR 005のSessionFolder workspaceを明示的に選択する。指定を省略した場合にSessionFolder workspaceへfallbackしない。ID発行、directory作成、永続化の順序はGUIと同じMain Process境界で所有する。

### Turn実行を独立したexecutionとして扱う

- `turn.run`と`turn.enqueue`が作成する各Turnは独立したexecution IDを持ち、Session IDまたはMessage IDをexecution identityとして流用しない。
- 新規execution requestはGUI送信を`{ kind: "user" }`、CLI・MCP送信を`{ kind: "session", sessionId, character }`として保存する。Session initiatorのSession IDはbindingから、Character ID・表示名・icon参照はactor Sessionとcanonical Character stateからexecution作成時に解決する。caller入力は受け付けない。
- Session initiatorのCharacter値はexecution作成時snapshotであり、その後のrename、archive、削除では再解決しない。initiatorを持たない既存external requestだけをlegacyとして読み込む。
- `turn.run`の呼び出し側は`wait`または`deferred`を明示する。どちらも同じexecutionを直ちに開始し、実行方式を分岐させない。
- `wait`はterminal result、interaction待機、またはtimeoutまで待つ。client切断とwait timeoutはexecutionをcancelしない。
- cancel、interaction response、状態取得はSession IDとexecution IDを組にして対象を検証する。
- `turn.run`は即時開始専用とし、対象Sessionが実行中または終了処理中なら`SESSION_BUSY`で拒否する。暗黙にqueueへ切り替えない。
- 後続実行を予約する場合は`turn.enqueue`を明示して、対象Sessionごとの永続FIFO queueへexecutionを登録する。登録済みexecutionは`queued`として`turn.get`、`turn.list`、`turn.cancel`から参照または取消できる。
- `turn.enqueue`はresponse modeを受け取らず、queue登録の受付結果を直ちに返す。admission、interaction、terminal resultを待たず、以後の状態はexecution IDで取得する。
- 一つのSessionでは同時に一つのTurnだけを実行する。異なるSession間にglobal queueまたは固定並列数上限は設けない。
- Turnごとのmodel、reasoning、approval、sandbox、custom agent、provider固有optionは`turn.run`または`turn.enqueue`で明示し、GUIまたはSessionの保存済みdefaultへfallbackしない。
- modelとreasoningの選択にはSessionに依存しないcatalogとSession固有optionを使い、`turn.run`と`turn.enqueue`はcatalog revisionを要求する。stale revisionは再試行可能なerrorとして拒否する。
- queue先頭を実行するときは、`queued`から`running`へのadmissionを永続化してからproviderへdispatchする。永続化前のcrashでは`queued`を再admitできる。永続化後はproviderへ到達したか不明でも`interrupted`へ収束させ、自動dispatchしない。
- process再起動時、admit済みの非terminal executionは自動resumeせず`interrupted`へ収束させる。未admitの`queued` executionは保持し、起動時のreconciliation後に対象SessionのFIFO順で実行を再開する。
- 同じoperationとidempotency keyで`turn.run`または`turn.enqueue`を再送した場合は、保存済みのcanonical executionを返す。terminal executionを再実行するには新しいidempotency keyを要求する。
- Sessionごとのqueueにはhard limitを設け、超過した`turn.enqueue`を副作用開始前に拒否する。具体値はpublic schemaとexecutable contractで固定する。
- 初期MCP adapterはexperimentalなMCP Tasksへapplication contractを依存させない。`deferred`とexecution IDを正本とし、将来MCP Tasksを採用する場合も同じexecutionへ投影する。

### Session間の引き継ぎは明示的なTurn enqueueで表す

- Session間の成功時引き継ぎに専用の完了通知toolは設けない。実行中のagentが、引き継ぎ先Sessionを明示した`turn.enqueue`を呼び出す。
- 引き継ぐpromptはagentが作業結果と次の目的に合わせて自然文で生成する。runtimeはpromptの意味内容を組み立てず、宛先検証、永続化、FIFO admission、execution identityだけを所有する。
- 引き継ぎ先は呼び出し元または親Sessionに固定しない。統括SessionがSession Bを作成し、BへSession CのIDを渡して、Bが完了後にCへ競合確認を依頼する構成を許可する。
- 初期promptへ呼び出し元Sessionを自動注入する`runtime.context`は設けない。必要なSession IDはSession作成resultまたは明示的な指示から渡す。
- 通常Sessionのprovider promptには実行対象自身のSession IDだけを含める。これはagentが自分のSessionを識別するための実行文脈であり、呼び出し元または親Sessionを伝える`runtime.context`とは分ける。
- agentが`turn.enqueue`を呼ぶ前に失敗または中断した場合、引き継ぎは作成されない。統括側は保持したexecution IDを`turn.get`で確認できる。terminal failureを別Sessionへ自動enqueueする機能は初期surfaceに含めない。

### mutationをidempotencyで収束させる

- Session作成とrename、Turnの即時開始とenqueue、cancel、interaction response、SessionFolderへのwriteまたはexportはidempotency keyを必須とする。
- idempotency scopeはoperationとidempotency keyの組とする。同じeffect-bearing inputはcanonical resultを再生し、異なるfingerprintはconflictとして拒否する。
- response mode、wait timeout、request IDなどdeliveryだけに関係する値はfingerprintへ含めない。
- 未完了recordはterminalへ収束するまで保持する。terminal recordの再送保証期間は24時間とし、起動時と定期cleanupで期限切れrecordを除去する。
- response lossまたはclient切断の後も、同じkeyの再送でSessionまたはTurnを重複作成しない。
- Turn作成fingerprintはinitiator kindとSession actor IDを含み、CLI/MCP adapter、binding ID/reference/generation、Character表示名、icon参照を含めない。canonical replayをCharacter snapshot再解決より先に判定し、同じactorのMCP・CLI retryを同じexecutionへ収束させる。別actorによる同一keyとpayloadはconflictとする。

### SessionFolderを対象Sessionのmanaged file boundaryとする

- SessionFolderは独立したtop-level resourceにせず、Sessionに従属するmanaged directoryとして扱う。
- Session詳細はWorkspaceとSessionFolderを区別して投影し、SessionFolderがWorkspaceでもあるかを示す。Session一覧は対象を選択できるようWorkspace pathを返すが、時間とともに変わるbranchは返さない。`session.get`だけがdirectory Workspaceの現在branchをGitからbest effortで解決し、非Git directory、detached HEAD、SessionFolder、解決失敗では`null`を返す。
- 外部surfaceのfile操作はSession IDとSessionFolder内のrelative pathを要求する。absolute path、`..`、symlink escapeを拒否する。
- 初期surfaceはlist、UTF-8 text read、UTF-8 text writeに限定する。delete、rename、任意host pathからのcopy、binary uploadは公開しない。
- `turn.run`の添付はSessionFolderをrootとしたrelative pathで指定できる。serverが対象Sessionのrootへ解決し、root containmentを検証する。
- 対象Sessionのprovider runtimeには、`docs/design/session-local-files.md`の既存契約どおりSessionFolderを暗黙の追加directoryとして渡す。成果物の生成は、原則としてMCP callerがfileを運搬するのではなく、対象Sessionへ指示して対象Session側で行う。
- Session削除後にfilesystem上へ保持されたorphan directoryは、Session recordが存在しないため外部surfaceから参照できない。

### public projectionを明示的に構成する

- CLIとMCPは同じapplication resultをtransport固有のenvelopeへ投影する。
- public resultには許可したSession metadata、execution state、effective Turn option、interaction、transcript、file referenceだけを含める。
- secret、runtime credential、raw provider payload、内部system prompt、Character prompt、stack trace、database detail、不要なprivate pathは投影しない。
- transcriptのcanonical formatはversioned JSONとし、Markdownは同じpublic projectionから生成するpresentationとする。出力先はinlineを既定とし、SessionFolderへのatomic writeも選択できる。
- list operationはopaque cursorによるpaginationを使い、offset paginationを公開しない。serverは安定したsortと一意なtie-breakerを所有し、続きがある場合だけ`nextCursor`を返す。
- application operationとMCP toolは同じdotted nameを使う。CLIは同じ階層をspace区切りのcommandへ投影する。状態取得は`turn.get`へ統合し、`turn.status`を設けない。
- MCP protocolの失敗とtool executionの失敗を分ける。application errorは共通のstable code、human-readable message、retry可能性、副作用の状態、safe detailsを持ち、message解析を機械判定に使わせない。
- inline textとloopback requestには上書き不能なhard size limitを設ける。SessionFolderへのtranscript exportはより大きい既定値を持ち、callerが`maxBytes`を明示した場合だけserver hard maximumまで拡張する。大きいexportは全量をmemoryへ保持せずatomicにstreaming writeする。
- exact tool名、requestとresponseのfield、error code、pagination、size limitはtype、schema、shared validation、executable contractを正本とする。このADRへ網羅的なAPI仕様を複製しない。

## Alternatives

### MemoryとSessionを一つのruntimeへ同居させる

listenerとdiscoveryの数は減るが、異なるauthority、lifecycle、schema、障害範囲が結合するため採用しない。

### MCP serverがSession CLIを起動する

CLIの表示形式、exit code、timeoutをapplication contractへ昇格させ、MCPとCLIのerror semanticsを二重化するため採用しない。

### CLIとMCPがSession persistenceへ直接接続する

Electron Main Processが所有するin-flight execution、provider runtime、interaction、idempotencyと整合できないため採用しない。

### MCP callerのworkspace pathをWithMateへ渡してSessionFolderへコピーする

呼び出し元Sessionと対象Sessionのfile authorityを混同し、MCP clientのsandbox外にあるfileをWithMateが代理で読み取る経路になり得るため採用しない。binary transferが必要になった場合は、callerがcontentを送信する別のupload contractとして再検討する。

### `turn.run`を常に同期または常に非同期にする

短い操作と長時間実行のどちらかで余計なpollingまたは接続維持が必要になる。execution自体を共通化し、deliveryだけを`wait`と`deferred`で選択する。

## Consequences

### Positive

- GUI、CLI、MCPが同じSession状態、Turn排他、provider実行、validationを観測する。
- 外部adapterの再試行や切断で、SessionまたはTurnの副作用が重複しない。
- MemoryとSessionのcredentialおよび障害範囲を分離できる。
- 呼び出し元Sessionと対象Sessionの所有関係が明示され、SessionFolderのfile authorityを対象Session内へ限定できる。
- CLIとMCPのどちらで開始したexecutionも、もう一方から同じIDで追跡できる。
- activeなuser、session、legacy executionは同じ永続FIFO順で既存Session message listへ投影する。Session initiatorは保存済みCharacter名とavatar、legacyだけは`外部`と汎用avatarを使い、CLI/MCPのtransport badgeは表示しない。GUI由来queued executionだけをGUIからcancelできる。
- agentが生成した自然文を使い、呼び出し元に限定されないSession間の後続処理を構成できる。

### Negative

- WithMateはMemoryとは別にSession runtimeのlistener、discovery、credential、配布物を管理する必要がある。
- idempotency record、execution registry、interaction待機、cleanupをMain Processで所有するため、runtime lifecycleが複雑になる。
- Sessionごとの永続queueと起動時reconciliationをMain Processで管理する必要がある。
- sandboxにより対象SessionFolderへ直接アクセスできないMCP callerは、初期surfaceではbinary fileを対象Sessionへuploadできない。
- public schema、CLI、MCP、GUIの兄弟入口に対するcontract testとsecurity reviewが必要になる。

## References

- `docs/adr/005-session-folder-workspace-launch.md`
- `docs/adr/020-memory-affect-mcp-application-boundary.md`
- `docs/design/session-external-runtime.md`
- `docs/design/session-local-files.md`
- `docs/design/session-run-lifecycle.md`
