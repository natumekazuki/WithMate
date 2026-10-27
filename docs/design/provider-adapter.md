# Provider Adapter

## Goal

Renderer が provider ごとの差異を知らずに、`Session Window` の送信と結果反映を扱えるようにする。

## Position

- provider 実行境界と current adapter 責務の正本はこの文書とする
- current capability の一覧は `docs/design/coding-agent-capability-matrix.md` を参照する

## Boundary

WithMate では provider 実行境界を Main Process に置く。

理由:
- CLI ログイン状態を安全に引き継ぎやすい
- Electron Renderer へ provider 実行権限を持ち込まなくてよい
- session store と thread id を同じ責務で管理できる

## Current Runtime

runtimeはshared contractの上に次の4 adapterを持つ。

- `CodexAdapter`
- `CopilotAdapter`
- `ClaudeAdapter`
- `OpenCodeAdapter`

対応ProviderとAdapterの対応表は`src-electron/providers/provider-support.ts`を正本とし、capability、Coding / Backgroundの解決、Session launchで共有する。未知のProvider IDは実行前に明示的に拒否し、Codexへ置き換えない。実行用catalogは指定Providerとの完全一致で解決し、未登録の場合も別Providerへfallbackしない。Adapter・実行用catalogのProvider指定を省略した場合だけCodexを既定とする。

カスタムcatalogや保存済みSession内の未対応Provider定義は削除しない。新規Sessionで未対応Providerを明示した場合、または有効な対応Providerがない場合はlaunchを拒否する。

`ProviderCodingAdapter`はprompt composition、quota取得、thread invalidation、live turn実行を担う。型と入力・出力の正本は`src-electron/providers/provider-runtime.ts`に置く。

Provider 実行が失敗した場合、adapter は `ProviderTurnError` を投げる。`canceled` は既存の session phase / retry / invalidation 判定のため boolean として維持し、失敗分類は `reason` で渡す。

Provider 固有の error message 判定は adapter 側に閉じる。`SessionRuntimeService` は `reason` から失敗理由を生成し、最小turnのerrorとassistant messageの`runFailure`へ保存する。受信済み`text`は変更せず、失敗通知を本文へ追記しない。本文未取得でも空の`text`と失敗理由を保存する。provider 固有の英語 message を再 parse しない。

provider実行結果から取得済みassistant本文とartifactをMainへ返し、正常・失敗・取消の通常履歴へ保存する。操作の正本は`MessageArtifact.operationTimeline`とし、live stepと共通の操作型で実取得したID、status、exitCode、構造化error、truncationを保持する。未取得の値は省略し、turn全体のphaseや自由文から個別操作の成功・失敗を推定しない。
Main Processでは`MainProviderFacade`が通常turnのadapterを提供し、`SessionRuntimeService`が実行する。Memory／Affect更新は通常turn内MCPから既存application serviceへ接続する。

providerごとの差は次。

- `CodexAdapter`
  - turnごとに公式Codex CLIの`app-server --listen stdio://`を起動し、`initialize` / `initialized`後に`thread/start`または保存済みIDの`thread/resume`、`turn/start`を実行する。native item / delta / usage通知からlive state、workspace snapshotを含むartifactを組み立てる
  - command / file approval、permissions、user-input、MCP elicitationのserver requestを元のrequest IDとの対応を保持して共通GUIへ直列中継し、応答は元のIDへ返す。GUIのrequest IDは独立したopaque IDとする。`serverRequest/resolved`、turn終了、取消でpendingと待機列を解放し、二重回答・別turnへの回答を拒否する
  - 質問はnative `item/tool/requestUserInput`のblocking／nonblockingと、`agentMessage.delivery = async`の構造化`questions`を識別し、共通`LiveElicitationRequest.kind = question`へ投影する。本文から質問を推測しない。asyncはitem IDで重複を除き、providerの進行を待機させず複数のformを表示する。native requestの応答先とasyncの通常入力配送は分離する。質問表示時のWindows通知条件とactivationは[Desktop UI](desktop-ui.md#windows-session-notifications)を参照する
  - async質問はsource item IDと秘匿化後の本文範囲をlive/final投影へ保持する。表示前に受信済み本文を配送し、質問本文の差し替えと本文のない要求の受信位置を共通runtimeへ渡す。preview外へ移動したsourceの古い範囲は破棄し、確定全文のfinal範囲で補正する。本文のない要求の挿入位置は受信時の秘匿化後全文の末尾とし、live previewの切断位置を使わない
  - async質問回答は`delivery = user-message`として共通serviceで扱い、`【質問】\n質問原文\n【回答】\n回答`を現在turn IDに固定した通常の`turn/steer`へ渡す。複数組は空行で連結する。user messageの保存と添付解決には回答部分だけを使い、provider向け文と表示本文は内部runtimeで分ける。対応ACKと保存後だけ回答済みにする。受付失敗時は有効なformを維持し、次turnへ振り替えない。終了と送信が競合した場合も送信結果を待って終端履歴を確定する。通常チャット割り込みは質問回答とは別入力であり、pendingを解決しない
  - native質問のCloseは`{ answers: {} }`を元RPCへ返し、質問だけを終了する。turn全体のabort・serverRequest/resolvedとは分離し、解放済みrequestへの応答やfatal errorへ変換しない
  - asyncの待機signalはturn終了・取消で失効する。共通runtimeは正常・失敗・取消の終端で全formを解放し、質問文・選択肢・form回答状態・本文内の位置だけをassistant messageへ保存する。form操作と履歴表示は[Question Forms](desktop-ui.md#question-forms)を参照する
  - 実行中追加入力は現在のthread IDと`expectedTurnId`を使う`turn/steer`へ送る。terminal後は入力を受け付けない。dispatch済みsteerの応答はRPC timeoutの有界範囲で待ってからtransportを閉じ、terminalより遅れた成功ACKも受理結果として保持する。一致するACKで受理された入力だけを通常会話へ保存し、拒否された入力を受理済みとして扱わない
  - terminalはnative `turn/completed`のstatusを正本とし、受信済み通知は後続EOFでも到着順に処理する。EOF自体は成功の根拠にしない。終了・取消時は所有processと子孫をboundedに終了する。Windowsは起動前にJob Objectへsupervisorを割り当て、POSIXは専用process groupを使う。cleanup失敗は診断として独立して報告し、native terminal outcomeを上書きしない。所有processの終了確認まで同一Session・workspace・threadへの再実行を拒否し、Session runtimeの終了中guardを維持する
  - `file / folder / image` 添付を shipped
  - workspace 外 access は session metadata `allowedAdditionalDirectories` を正本にして制御する
  - binary pathは`src-electron/providers/provider-binary-paths.ts`を正本とし、開発時は固定版`@openai/codex`のnative package、配布時は`resources/provider-binaries/`配下のstaged binaryを直接起動する。App Serverのenvironmentへcredentialとturnのruntime bindingを明示し、global `process.env`は書き換えない
- `CopilotAdapter`
  - `session.send()` と session event stream を使い、最小 turn 実行、assistant text streaming、通常履歴用artifactを返す
  - 開始済みturnの取消ではsend応答とcompletionを並行して観測し、abort応答・`session.idle`・send応答の収束を取消専用の猶予内で確認する。取消受付時に当turnのsession/client cacheを同期的に切り離し、捕捉した旧sessionのdisconnectと旧clientのstop、必要時のforceStopへ進む。SDKのstdio clientには公開exit hookがないため、cleanupが破棄する前の`cliProcess`をreadonlyで捕捉する。forceStopのresolveを停止証明にせず、必要時はその旧childだけへSIGKILLを送り、実exitとsend/abort RPC終了までadapter Promiseと共通runtimeの再送guardを保持する。kill失敗も期限だけで解放せずexitを待つ。SDK childを捕捉できない場合は切断を停止証明にせず、元turnのidleとRPC終了を待つ
  - 取消後は旧SDK Sessionを再利用せず、保存済みthread IDからresumeする。disconnectはCopilot側の会話履歴を削除せず、新接続や無関係Sessionのclientを停止しない。正常turnには取消用の期限を適用しない。取消のpartial resultを保持し、停止確認・cleanupの失敗はprovider metadataとapp logへ残す。共通runtimeの取消猶予で先にterminal保存した場合は、その後の停止失敗をapp logで確認する
  - top-level `assistant.message` が複数回来た場合は、arrival 順に空行区切りで連結した本文を `assistantText` として返す
  - character prompt は `SessionConfig.systemMessage` `mode: "append"` に載せ、`session.send()` には user input 本文を送る
  - `file / folder` は Copilot SDK `attachments` (`file` / `directory`) へ変換して送る
  - `image` も `attachments` の `file` として送り、専用 UI 分岐は持たない
  - custom agent は `~/.copilot/agents` と workspace `.github/agents` を探索し、picker には `user-invocable: true` の定義だけを出す。turn の送信値は `customAgents` / `agent` に変換する
  - rich command timeline は未対応
  - `on-request` で non-read-only permission request が来た場合は、Main Process の `onApprovalRequest` bridge を通して Session UI の approval card へ中継し、user の `approve / deny` を SDK `PermissionHandler` へ返す
  - `elicitation.requested` が来た場合は、Main Process の `onElicitationRequest` bridge を通して Session UI の form / url card へ中継し、user の `accept / decline / cancel` を RPC で返す
  - Electron main process では `src-electron/providers/provider-binary-paths.ts` を正本にして staged native Copilot CLI binary を明示して起動する
  - `LatestCommand` と artifact `operationTimeline` には、`shell / powershell / bash` に加えて `create / edit / replace / move / delete` のような mutating tool も `command_execution` として正規化して返す
  - `artifact` は snapshot diff fallback を使って `changedFiles / runChecks / operationTimeline` を最小構成で返す
  - `Premium Requests` は `client.rpc.account.getQuota()` と `assistant.usage.quotaSnapshots` から app-wide telemetry として更新する
  - `Context Usage` は `session.usage_info` を session local telemetry として Main Process memory に保持する
  - background task は `session.idle.backgroundTasks` と `system.notification` を `LiveSessionRunState.backgroundTasks` へ正規化し、Session 右ペインの Copilot 専用 `Tasks` tab へ流す
  - current sliceはCopilot-onlyで、taskのcreate/list/control RPCまでは吸収しない。Codex adapterは同等のTasks UIへ接続していない
- `ClaudeAdapter`
  - 公式SDK `0.3.285`と未改変の公式native実行物 `2.1.285`を使い、Windows / macOSの対象architecture向け実行物を配布物へ同梱する。CLIの既存ログインをSDKに任せ、WithMateはcredentialを読取・コピーせず、独自OAuthを行わない。SDKの認証・課金に関わる環境変数や設定の優先順位を上書きしない
  - `query()`で1 turnを実行し、保存済みの明示session IDを`resume`へ渡す。履歴全件の再送、暗黙の最新会話`continue`は行わない。取消時はSDKの公開spawn hookで子プロセスの実終了を追跡し、実終了までprovider Promiseを保持してruntimeの再送guardにつなぐ。正常なterminal result後のcleanupは[ADR 002](../adr/002-provider-turn-terminal-and-cancellation.md)のbounded graceに従う
  - `claude-opus-5-5`と`low / medium / high / xhigh / max`をcatalogで扱う。`permissionMode: "default"`と共通UIの`Provider Controlled`のみを用い、Codexのsandbox選択は提供しない
  - 共通promptのsystem本文を`claude_code` presetの`append`へ渡し、`snapshot: false`でturnごとのCharacter / Affect / Memoryを反映する。既存のuser / project / local設定、repositoryの`CLAUDE.md`と`.claude/skills`、MCP設定をSDKのnative経路で読み込む
  - SDKの`PreToolUse`でread-only以外をaskにし、native設定が自動許可する場合も`canUseTool`からWithMateの共通承認UIへ中継する。`AskUserQuestion`は選択肢と自由入力を保持した共通質問UIへ、MCP elicitationも共通UIへ中継する。同一turnの承認・質問は直列化し、未回答のpending要求を上書きしない。MCPのfield変換はCopilotと共有し、選択肢のlabel、既定値、入力制約を保持する。応答・tool操作・usageを共通live state、artifactへ投影し、Bashだけをraw command付きの`command_execution`として扱う
  - background planeは別の非永続sessionで構造化JSONを要求し、tools / MCP / hooksを無効化する。`resolveSettings({ cwd, settingSources: [] })`でmanaged sourceまたは設定検査失敗を検出した場合、実行物を起動せず拒否する。user / project / local設定は読まず、親プロセスの環境変数とSDKが参照する既存CLIログインを利用する。設定ファイルだけにある認証helperや認証・接続先設定は共有しない
  - SDK transcriptはWithMateの履歴・workspaceとは別にClaude側が管理し、WithMateのsession削除で消さない。quotaはモデルを実行しないcontrol APIで取得し、Mainの非永続cacheへ保持する。token / cache usageはturn単位で扱う。API換算USDは実請求額として表示しない。backgroundの補助処理も解決された認証先の利用枠を消費する。同じ契約枠になる条件は[Provider Usage Telemetry](provider-usage-telemetry.md)に従う

- `OpenCodeAdapter`
  - 公式CLI／`@opencode/client`を`2.1.4`へexact pinし、turnごとに`serve --stdio --hostname 127.0.0.1 --port 0`を起動する。stdioの起動通知でloopback URLを検証し、Mainが生成したpasswordによるHTTP認証後にCLI版を照合する。Codexと共通の`providers/owned-process.ts`がWindows Job Object／POSIX process groupを所有し、cleanup未確認中は同一Session・workspace・threadの再実行を止める
  - `OPENCODE_DB`は`<userData>/providers/opencode/<build channel>/opencode.db`へ固定し、Main内でnative DB bootstrapを直列化する。DBの所有者はOpenCodeであり、adapterから直接SQLを実行しない。foregroundはPATH／HOMEとnative global／project設定、AGENTS、skills、第三者MCPの読込を維持する
  - 共通promptの`logicalPrompt.composedText`を毎turn送る。保存済みの明示thread IDを取得し、root・workspace・既存incarnation由来のownerを照合する。未配送inboxは同ownerとrequest IDを確認できる旧入力だけをcancelし、未知ownerや取消未確認はエラーにする。入力の自動再送やstale threadの自動resetはしない
  - event接続を確認してからpromptを1回だけ送る。admissionを完了とせず、当該入力の配送、root execution終端とmessageのidle outcomeを照合する。text deltaは確定messageで補正し、tool・usageはnative IDで重複を除く。失敗・取消では取得済み本文・操作・threadをpartial resultとして返す
  - catalogの`providerID/modelID`をnative model Refへ分解し、Depthを同名variantへ渡す。native model一覧で有効性・variant・添付modalityを確認し、不一致は明示エラーにする。添付はfile URIへ変換し、Additional Directoryは`external_directory` grantへ変換する。workspace移動の`opencode_session_move`はdenyする
  - `on-request`は共通承認UIへ中継し、approveを`once`、denyを`reject`へ変換する。`never`はnative askへ`once`を返し、永続許可`always`は発行しない。formは共通質問UIへ変換し、未対応fieldや帰属不明requestはcancel／rejectして失敗にする。実行中steerとturnを越えるbackground taskは接続しない
  - token／contextは実取得値を投影し、Go契約quotaはモデルを実行しないusage HTTP APIから独立取得する。5時間・7日・請求月の残量を共通Monitor／Action Dockへ表示し、Mainの非永続cacheと既存の更新・失敗処理を使う。artifactはtool操作を保持するが、変更fileのsnapshot差分は生成しない

## Provider実行とManaged MCP

### Managed HTTP MCP

Coding planeのMemory／CharacterとGlossaryは、Mainが所有する1つのlocalhost Streamable HTTP listenerへ接続する。endpointは`/mcp/memory`と`/mcp/glossary`であり、tool schemaとruntime clientは`src-electron/platform/mcp/`をstdio CLIと共有する。内側のruntime exchangeとapplication serviceを通し、DBへ直結しない。

- Mainはactor、provider、runtime owner、binding generation、captured logical turnへ固定した短命tokenをmemory内で発行する。全requestを`x-withmate-mcp-token`で認証し、MCP session IDはprotocol stateの選択にだけ使う。
- Codexはtokenをprivate envへ渡し、processとthreadの一時configに`env_http_headers`を設定する。native `config/read`で存在を確認した`withmate-memory`／`withmate-glossary`だけを当threadで無効化し、`withmate-memory-http`／`withmate-glossary-http`を登録する。第三者MCPと永続configは変更しない。
- CopilotとClaudeは当turnのnative session／query optionsへ標準managed名のHTTP設定を渡す。既存native設定の探索と保存済みthreadのresumeは維持する。
- OpenCodeは確定workspaceのlocationへ`mcp.add`で当turnのHTTP設定を登録し、必要なmanaged MCPの接続を`mcp.list`で確認してからpromptを送る。第三者MCPと永続設定は変更しない。
- tokenはprompt、通常log、通常履歴、artifactへ投影せず、bindingと同じredactorで除去する。
- 取消受付、turn終了、binding失効、runtime停止でtokenとcaptured turnを失効させる。queued Workerにも共有失効stateを渡し、SQLite transactionとfilesystem副作用の境界で再確認する。確定済み副作用はpartial／unknownとして維持する。
- HTTP hostが利用不能ならprovider起動を明示失敗にし、stdio自動fallbackや無認証設定へ切り替えない。operator CLIとadmission付きagent CLI fallbackは別経路で維持する。

provider adapterは通常turn実行を所有する。Affect専用の背景生成経路は持たず、Copilotの通常turnに属するbackground task監視はlive stateとして維持する。

### Coding Plane

- Session の通常 turn 実行
- prompt composition
- live state / approval / elicitation / quota / context telemetry
- thread invalidation

利用側:

- `SessionRuntimeService`
- `MainObservabilityFacade`
- `MainProviderFacade#getProviderCodingAdapter()`

## Session Flow

1. Renderer が送信時の表示選択を `executionOptions` に固定し、`runSessionTurn(sessionId, { userMessage, executionOptions })` を IPC で Main Process に送る。Main Session と Auxiliary Session は同じ実行契約を使う
2. Main Process が session store から thread、workspace、Character などの session context を引く。保存済みの実行設定はこの turn の実行値にしない
3. 保存済みCharacter snapshotとturn contextを解決する
4. Main Process が textarea 内の `@path` を解決し、file / folder / image を正規化する
   - workspace 外 path は `allowedAdditionalDirectories` 配下だけを許可する
5. prompt composer がCharacter context、user inputと添付referenceをproviderへ渡す形式に正規化する
6. Main Process が送信された `executionOptions.catalogRevision` と session の `provider` から provider catalog を解決し、revision、model、reasoning depth、実行 option 値を検証する。model が存在しない、depth が非対応などの不正な選択は turn 開始保存・Provider 起動前に拒否し、default や保存値へ置換しない
7. 検証済み`executionOptions`を独立したturn snapshotとしてprompt、coding plane adapter、最小turn記録へ渡し、provider-native実行へ変換する
   - `CodexAdapter`: file / folderのworkspace外accessはsession metadata `allowedAdditionalDirectories`からsandbox policyの`writableRoots`へ変換し、画像は`localImage` inputとして`turn/start`へ渡す。model、effort、approval、sandbox、service tier、reviewerは送信時の検証済み値を使う
   - `CopilotAdapter`: prompt composerの結果とattachmentを送る。file / folderは`session.send({ attachments })`の`file` / `directory`へ変換し、imageも`file` attachmentとして渡す。workspace外pathはWithMate側の`allowedAdditionalDirectories`判定を正本にする。`on-request`ではpermission requestをMain Processへ返し、Session UIのapproval cardと往復する。Electronではnative CLI binaryを明示して起動し、bootstrap failure時は診断ログに必要なerror metadataを残す
   - `ClaudeAdapter`: 共通prompt、検証済み添付、実行optionをSDK `query()`へ渡す。`resume`は保存済みの明示session IDだけを使い、承認・質問を共通pending UIへ返す
   - `OpenCodeAdapter`: 共通promptとfile URI、検証済みmodel／variantをnative Sessionへ渡す。明示threadと所有metadataを照合し、承認・formを共通pending UIへ返す
8. provider ownerがstream eventからsanitized live stateとprovider telemetryを組み立て、Main ProcessがIPCでSession Windowへ中継する。Codexのprojectionは共有Workerが所有し、transportと制御requestはMain Processに残す
   - live state には `approvalRequest` と `elicitationRequest` を含められる
   - quota telemetry は provider 単位、context telemetry は session 単位で memory cache する
   - Codexはnative `turn/completed`の`completed / failed / interrupted`をterminal outcomeの正本とする。`error`通知はdiagnosticとして扱い、terminal前の切断は失敗とする。transport終了はbounded cleanupとして扱う
9. turn 完了後に Main Process が `threadId` と assistant message を session store に反映する
10. Main Processが開始・終端の最小turnをSQLiteへ保存し、終端では通常本文・artifactと関連するmessage位置を確定する。stream中の累積snapshotを永続化しない
11. Renderer は Session summary invalidation と live state 購読を使って再描画する

## Prompt Composition Constraint

添付はproviderごとのtransportへ変換する。

- `Codex`
  - file / folder: session metadata `allowedAdditionalDirectories`をsandbox policyの`writableRoots`へ変換
  - image: structured input (`localImage`)
- `Copilot`
  - SDK native には `attachments` として `file` / `directory` attachment がある
  - `CopilotAdapter` はfile / folderに加えてimageも`file` attachmentとして扱う
- `Claude`
  - file / folderは検証済みpathを入力へ渡し、imageはSDKの画像入力へ変換する
- `OpenCode`
  - file / folder / imageをfile URIへ変換する。image／PDF／textの入力modalityをnative model能力と照合し、非対応添付を拒否する

workspace 外 path の access control は provider 任せにせず、WithMate が session metadata `allowedAdditionalDirectories` を正本にして先に判定する。

picker で選んだ file / folder / image も renderer 側では textarea に `@path` を挿入するだけで、実行直前の解決対象は textarea の `@path` のみとする。

the text prompt 側には `# System Prompt` と `# User Input Prompt` を自動付与し、各レイヤーを空行区切りで結合する。

詳細は `docs/design/prompt-composition.md` を参照する。

## Thread Management

- sessionごとにprovider固有の会話IDを保持する。Codexはturnごとの新しいApp Serverで保存済み`threadId`を`thread/resume`へ渡し、未作成時は`thread/start`する。Claudeは同じ保存fieldの明示IDをSDK `resume`へ渡し、未作成時は新規`query()`を使う。OpenCodeは明示IDの`session.get()`、未作成時は`session.create()`を使う
- Codexの`thread/resume`には`excludeTurns: true`を指定し、WithMateが利用しない過去turnの一括返送を省く。Codex側の会話履歴と保存済みIDは維持し、再開後の通知を処理する。新規`thread/start`には指定しない
- 実行後にproviderが返した会話IDをsession storeへ保存する
- model または reasoning depth を変更した場合も、その session の `threadId` は維持し、次回 turn は送信された runtime parameter で既存 thread / session の resume を試す
- Codexは毎turnの`thread/start` / `thread/resume`と`turn/start`へ送信時の実行optionを渡す
- Codex / Copilotのcoding credentialは`AppSettings.codingProviderSettings[providerId].apiKey`から解決する。Codexは設定値を優先し、未設定時は継承した`CODEX_API_KEY`を使う。キーがある場合だけApp Serverを`cli_auth_credentials_store="ephemeral"`で起動し、initialize後の`account/login/start`へ渡す。認証はprocess内に限定し、保存済みCLI認証を変更しない。キーがなければ既存CLI認証を使う。CopilotはSDK clientへ渡す。Claudeは既存CLI認証をSDKに任せ、WithMateのcredential設定へ取り込まない
- coding credential が変わった provider では既存 thread / adapter cache を再利用しないため、対象 session の `threadId` を空に戻す
- OpenCodeのGo用keyは`codingProviderSettings.opencode.apiKey`を優先し、未設定時は継承した`OPENCODE_API_KEY`を使う。子processのenvだけへ投影し、global `process.env`は書き換えない

理由:
- provider prompt は過去の `session.messages` を毎 turn 再送せず、会話継続は provider 側の `threadId` に依存するため、model / reasoning depth 変更だけで `threadId` を消すと履歴が途切れる
- Copilotはsettings key差分時にcacheを切り替えて`resumeSession(threadId, config)`を試す。Codexは新しいApp Serverへ明示IDと今回のruntime parameterを渡す
- Codexの`thread/resume`が拒否された場合は保存済みIDを保持してエラーを返し、自動で新threadへ切り替えない。Copilotのstale session回復はError Handlingに従う
- coding credential を切り替えたあとに旧 client / 旧 thread 文脈を引き継ぐと runtime 差し替えが不透明になる
- そのため model / reasoning depth 変更は conversation continuity を優先し、credential 変更は security boundary として thread を切り替える

## Session Metadata Dependency

adapter 実行に必要な保存済み session context:

- `session.id`
- `session.workspacePath`
- `session.provider`
- `session.allowedAdditionalDirectories`
- `session.characterId`
- `session.threadId`

実行値は保存済み session とは独立した送信時の `executionOptions` を正本にする。これは `catalogRevision / model / reasoningEffort / approvalMode / codexSandboxMode / codexSpeed / codexReviewer / customAgentName` を含む。

## Approval Modes

approval mode は WithMate が対応する Codex policy 値を正本にする。

- `never`
- `on-request`
- `untrusted`

方針:

- renderer / shared state / session persistence / 最小turn記録ではCodex policy値をwrite-pathの正本として扱う
- 既存 row に残る legacy 値は read-path normalize で吸収する
  - `allow-all -> never`
  - `safety -> untrusted`
  - `provider-controlled -> on-request`
- CodexAdapterは`approvalMode`をApp Serverの`approvalPolicy`へそのまま渡す
- CopilotAdapter は `never` を自動許可、`untrusted` を read-only 以外 rules deny、`on-request` を Session UI の approval card 中継として扱う
- ClaudeAdapterは`on-request`だけを選択可能にし、SDKのdefault permissionと共通approval / elicitation UIで処理する
- OpenCodeAdapterは`on-request`（既定）と`never`だけを選択可能にし、native askへそれぞれ共通UIの判断／今回だけ許可を返す。nativeの明示denyを上書きしない
- UIはpolicy値をそのまま表示せず、`Auto Run` / `Provider Controlled` / `Safety Focused`のdisplay labelへ変換する。保存・API・adapter境界ではpolicy値をrawのまま保持し、providerごとに出すchoicesを分ける

session作成、永続化、最小turn、artifact表示、resume復元ではpolicy値を追跡し、providerごとの差異はprovider-specific choicesとadapter実装で吸収する。

## Sandbox Modes

Codex session は `codexSandboxMode` を持つ。UI では Codex provider のときだけ Sandbox dropdown を表示する。

- `read-only`
- `workspace-write`
- `workspace-write + network`
- `danger-full-access`

`workspace-write + network`はWithMate側のUI optionであり、Codex App Serverへは`workspaceWrite` sandbox policyの`networkAccess: true`として渡す。他のproviderは現時点でsandbox dropdownを表示しない。

## Model Resolution Policy

- session metadata は選択状態を保存するが、turn の Provider 実行値は Main / Auxiliary の送信要求に含まれる `executionOptions` を使う
- Main Process は送信された catalog revision と session provider の catalog を解決し、snapshot revision、model、reasoning effort を実行開始前に検証する
- model 自体が見つからない場合はそのままエラーにする
- selected depth が非対応ならそのままエラーにする
- 保存済みの値、catalog default、depth clamp への暗黙の置換はしない
- provider 実行時に拒否された場合も、そのまま session error として扱う

詳細は `docs/design/model-catalog.md` を参照する。

## Artifact Summary Policy

Codex App Serverのnative itemsとworkspace snapshot差分からsummaryを組み立てる。

- `fileChange` + snapshot diff -> changed files
- `commandExecution` -> activity summary
- `mcpToolCall` / `webSearch` / `plan` / `reasoning` -> activity summary
- approval -> run checks の provider-neutral canonical value
- usage -> run checks
- model / reasoning -> run checks

diff 本文は turn items からは直接取れないため、Main Process 側で `before / after` スナップショットを補完取得する。
CodexAdapter は `workspacePath + allowedAdditionalDirectories` ごとに process memory の `WorkspaceSnapshotIndex` を持つ。初回または invalidation 時は full rebuild し、全 session thread の invalidation 時は index cache も破棄する。その後の turn 開始時・終了時は index refresh を通して snapshot を取得する。既存 file の mtime / size だけが変わった場合は、全 file 本文を読み直さず、変化した file だけ再読込する。

turn 終了後の snapshot は provider outcome に対する enrichment である。取得が deadline を超えた場合は turn 自体を失敗へ変更せず、取得済み item から result を確定し、diff が不完全になり得ることを provider metadata と app log に残す。

`fileChange`だけで変更候補を確定でき、`commandExecution` / `mcpToolCall`のような副作用範囲が不明なoperationが無い場合は、候補ファイルだけをtrusted candidateとしてrefreshする。副作用範囲が不明な場合でも、directory構造とignore sourceが変わっていなければ、known fileのstat差分からincremental refreshする。directory mtime変化、ignore source変化、snapshot limit超過またはlimit hit状態、不確定なignore状態がある場合はfull rebuildへfallbackする。

- 実行前に `workspacePath + allowedAdditionalDirectories` 全体の text file snapshot を取る
- 初回以降は `WorkspaceSnapshotIndex` の snapshot を before として使い、turn 前に index refresh で外部変更を反映する
- 実行後はcompleted `fileChange`の候補ファイルだけをtrusted candidateとしてrefreshできる場合がある
- `commandExecution` / `mcpToolCall`がある場合も、directory構造とignore sourceが変わっていなければknown fileのstat差分だけでrefreshする
- directory 構造変化、ignore source 変化、limit 超過または limit hit 状態、不確定な ignore 状態では full rebuild へ戻す
- snapshot の除外判定は、workspace から親方向へ探索した `.gitignore` を使う
- `.git` は `.gitignore` に関係なく常に除外する
- Git 管理下なら Git root までの `.gitignore` を上から順に積む
- Git 管理下なら `.git/info/exclude` も Git root 基準の ignore source として使う
- Git 管理下でない場合は、workspace 直下と最初に見つかった親の `.gitignore` までを使う
- workspace 配下で見つかった nested `.gitignore` は、そのディレクトリ以下にだけ適用する
- snapshot は 1 file あたり 1 MiB、全体で 4,000 files / 16 MiB を上限にする
- skipped / limit hit がある場合は artifact `runChecks` に warning を残し、`Changed Files 0 件 = 変更なし` と断定しない
- `add`: `before = null`, `after = 実行後本文`
- `edit`: `before = 実行前 snapshot`, `after = 実行後本文`
- `delete`: `before = 実行前 snapshot`, `after = null`
- `ChangedFile.diffRows` は split diff viewer 向けに `add / edit / delete / modify / context` を持つ


## Streaming Policy

- provider固有のstreaming APIを使い、turn完了前の一時状態をRendererへ中継する
- providerの正常データを受信・配送する経路では、件数・容量だけでturnを拒否しない。不要なデータは後段へ渡す前に除き、処理済みの受信情報や余分な複製を早期に解放する。必要な本文・ツール結果・未解決の対話は保持し、実際の資源不足、通信・protocol・consumerの失敗は成功へ置き換えない
- Claude／Copilotのprogress配送は容量計測用のJSON複製や完了後のmacrotask待ちを行わず、consumerの実完了と実失敗を追跡する。Copilotはnative完了後に受付済みcallbackをdrainし、取消はそのdrainを待たない。Claudeは32 messageごとにmacrotaskへyieldして制御処理へ戻る
- live state には少なくとも次を含める
  - 最新の assistant text
  - 実行中 / 完了 / 失敗の step 一覧
  - usage
  - stream 中の error
  - 必要なら pending approval request
- Codex native itemsに`agentMessage`が複数ある場合、Session UIに表示するassistant textはarrival順に空行区切りで連結する
- Codexの一時的なstream errorは同一thread / turnの有効なitem activityで解除する。別scopeや未知itemへのdeltaでは解除せず、terminal後は確定した失敗理由を保持する
- live state は Main Process の memory 上だけに持ち、session DB へは保存しない
- Session Window を開き直した場合は、Main Process が保持している live state を再購読して復元する
- Session Window から `Cancel` を押した場合は、Main Process が保持している `AbortController` で provider 実行を中断する
- Claudeの個別approval / elicitation要求はSDKのrequest signalとturn signalを共通pending serviceまで渡す。要求取消ではresolverとlive表示を解除してから直列待機列の次要求を表示し、取消済みrequestIdへの回答は拒否する。待機列内の取消済み要求は表示せず、turn全体の取消・子プロセス実終了待ちとは区別する
- Copilot の approval request は Main Process が pending resolver を保持し、Session UI の `今回だけ許可 / 拒否` を受けて permission handler を再開する
- turn終端で通常履歴と最小turnを確定値で保存する
- canceled / failedでも、取得済みassistant textとnative itemsはpartial resultとして回収し、通常履歴の`Details`に残す

### Codex projection owner

CodexAdapterは同時turnで1つのprojection Workerを共有し、最後のturnを解放した時に停止する。Workerはopaque run IDごとにnative items、増分text cache、step projection、turn固有のredactorを保持する。次turnや別runへ本文・binding・API keyのcacheを流用しない。binding registry、logical turn、lease、transport、承認・取消、個別process cleanupのownerはMain Processに残す。

assistant／reasoningはitem単位で更新し、arrival順の全量連結とbounded previewを必要時だけ生成する。command deltaは全reasoningを走査せず、terminalの一括item適用後に集約する。変更していないstepは再projection・再redactionしない。表示に影響しない通知ではsnapshotを生成しないが、取得済みnative itemsと未知itemのraw情報は保持する。

live更新は33msを目安に生成し、未完了のlive要求は1件とdirty flagだけを持つ。WorkerからMainへのstep配送は既存changesのupserts/removesだけとし、無変更operationのDetailsを再送しない。Codex progressは`changes.snapshot = false`、stateのcollectionsは空配列とし、制御通知も同じ契約を使う。`SessionRuntimeService`はchangesを既存のMain live stateへ統合し、同ID更新の位置と追加順を維持する。完全状態は`SessionObservabilityService`が保持し、Window再接続・snapshot取得・取消partialのconsumerへ返す。adapterに完全状態のMapを重複保持しない。他providerのsnapshot付きprogressはstateを利用する。

最後のdeltaの後にもtimerで最新表示へ追いつき、終了・取消時は最終changesをflushする。承認・取消・terminalの入力入口閉鎖とerror通知はlive timerを待たない。progressは一時的な表示の更新であり、保存queueを持たない。

stdio transportは正常な受信frame、未消費event、送信frameを件数・容量だけで拒否しない。通知・server requestは到着順に保持し、`nextEvent`で取り出した参照は直ちに解放する。FIFOは毎回配列全体を移動せず、消費済み領域をまとめて除去する。RPC応答はeventキューを経由せずIDで解決し、承認・質問・取消・追加入力の応答を塞がないためにstdout全体の読取を停止しない。不正UTF-8／JSON／envelope、通信断、実際のwrite失敗は引き続き失敗とする。

Worker clientは未応答commandの件数・容量だけで受付を拒否せず、容量計測用のJSON化も行わない。adapterは各turnの通知を最大32 eventまたは次のmacrotaskでまとめて配送し、未完了8 batchでは完了を待って次の配送へ進む。通知の順序と各投影変更を保持し、32 event読取ごとにもyieldする。別threadの通知と不要な別turn通知はWorkerへ転送しないが、usage baselineに必要な過去turnのtokenUsageは保持する。承認・質問・取消・terminalの制御はMainに残し、終了・取消・失敗時にも受信済みbatchを反映してpartialを回収する。5秒以内に応答しないWorkerやWorker異常では要求をrejectし、Mainでの全量projection fallbackや自動再実行をしない。

runの解放は先行commandの後に配送し、Workerのowner削除応答かWorker異常終了なしにclient登録だけを失わない。native itemsとredactorを孤立したownerとして保持し続けない。

最終assistant本文、operations、必要なprovider metadataはWorkerで集約・秘匿化し、artifactのfilesystem snapshot／diffはMainで補完する。live previewの長さでfinal本文を切らず、取消・失敗時も取得済みpartialを回収する。backgroundの診断traceを取得する場合はrawの個別128×1024・最終512×1024 code units予算と省略markerを維持し、正常なWorker入力へ容量上限を適用しない。通常turnのraw JSONを独立して永続化しない。

## Error Handling

- provider 実行失敗時は Main Process が session を `runState=error` へ更新する
- Renderer に raw stack trace は出さず、UI 向けの失敗メッセージへ整形する
- Codex／OpenCodeの失敗時は保存済み`threadId`を保持し、resume拒否を新threadの成功へ置き換えない。他providerのstale session回復は各adapterの契約に従う
- ユーザーキャンセル時は最小turnに `phase=canceled` を記録する
- setup 中の cancel intent も保持し、setup dependency または provider が abort 後に settle しない場合は cancel grace 後に呼び出しを収束させる。元処理が実際に終了するまでは同一 session の再送を拒否する
- Main は取消受付を live run の `cancellationState = requested`、cancel grace 後も未終了の処理を `terminating` として投影する。terminal Session の保存が `idle` を返しても取消待ちを解除せず、元処理と終端保存が終了して admission guard が解放された時に live 取消状態を解除・通知する。重複取消は同一 turn の要求として扱う
- 失敗時は最小turnに `phase=failed` とerror summaryを記録する
- canceled / failed のどちらでも、取得済みの `assistant text` / operations / artifact があれば捨てずに残す
- `CopilotAdapter` は cached session 再利用中の `SessionNotFound` / stale connection も同一 turn 内で 1 回だけ internal retry できる
  - retry 前には cached `CopilotSession` と client cache を破棄する
  - retry 後は既存の `resumeSession(threadId)` を再試行し、missing session なら `createSession()` fallback へ落とす
  - `session.error` や未対応event診断だけの局面では retry を妨げず、取得済みの `assistantText` / terminal操作（completed・failed・canceled）/ exitCode・error・操作の非空partial output / `artifact.changedFiles` がある時は retry を止める。partial outputの取得はturn実行中の証拠で判定し、artifactのdetails本文から推定しない
  - `tool.execution_start` や pending permission のような未確定 step だけでは retry を妨げない。承認情報を継承した開始details、開始step由来のactivity summary、実行設定由来のrun checksも実行結果として扱わない
- DB reset は running session がある間は拒否し、そのエラーメッセージを renderer にそのまま返す

## 通常履歴と最小turn

- assistant本文と操作結果は通常履歴・artifactへ保存し、`Details`で閲覧する。操作の配列順を保持し、独立した順序台帳を設けない
- prompt、transport payload、raw event、本文tokenやstdout chunkごとの累積snapshotを別に保存しない
- 最小turnはphase、実行設定、message位置、thread、時刻、error summaryを保存し、取消・retry・Conversation Timingの関連付けに使う
- 保存失敗、結果不明、owner不一致を正常emptyや成功に変換せず、旧storage generationや削除済みownerへ書き戻さない

## Slash Command Routing

- slash commandはproviderへそのまま渡さない
- Renderer / Main Process が先に app command または session setting command として解釈する
- adapter は slash command 自体を parse せず、送信時に固定された実行 option を provider-native option へ変換する

## Agent / Skill Mapping

- skill 探索元は次を使う
  - `codingProviderSettings[providerId].skillRootPath` と任意の `skillRelativePath` から解決した provider skill root
  - workspace 標準 skill roots (`skills`, `.github/skills`, `.copilot/skills`, `.codex/skills`, `.claude/skills`, `.opencode/skills`)
- `codingProviderSettings[providerId].instructionRelativePath` は provider ごとの instruction file 設定として保持するが、skill 探索やprompt compositionでは参照しない
- 同名 skill は workspace 優先で dedupe する
- adapter は選択済み skill を provider ごとの prompt / option へ変換する
  - Codex: `$skill-name` mention
  - Copilot: explicit skill directive を prompt へ付加
  - Claude: 選択済みskillのpathを明示するdirectiveをpromptへ付加する。設定したskill root全体をSDKのnative Skill探索元として追加しない
  - OpenCode: skill名のdirectiveをpromptへ付加する。nativeのSkill探索はOpenCodeの設定に従い、任意同期先を自動登録しない
- `agent` は provider 専用 command とする
  - Codex: 未対応
  - Copilot: custom agent selection を session metadata に保存し、送信時に固定した選択値と `~/.copilot/agents`・workspace `.github/agents` から探索した agent catalog を adapter が `customAgents` / `agent` に変換する

## References

- `docs/design/prompt-composition.md`
- `docs/design/electron-session-store.md`
- `docs/design/model-catalog.md`
- `docs/design/coding-agent-capability-matrix.md`
