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

runtimeはshared contractの上に次の3 adapterを持つ。

- `CodexAdapter`
- `CopilotAdapter`
- `ClaudeAdapter`

対応ProviderとAdapterの対応表は`src-electron/providers/provider-support.ts`を正本とし、capability、Coding / Backgroundの解決、Session launchで共有する。未知のProvider IDは実行前に明示的に拒否し、Codexへ置き換えない。実行用catalogは指定Providerとの完全一致で解決し、未登録の場合も別Providerへfallbackしない。Adapter・実行用catalogのProvider指定を省略した場合だけCodexを既定とする。

カスタムcatalogや保存済みSession内の未対応Provider定義は削除しない。新規Sessionで未対応Providerを明示した場合、または有効な対応Providerがない場合はlaunchを拒否する。

`ProviderCodingAdapter`はprompt composition、quota取得、thread invalidation、live turn実行を担う。`ProviderBackgroundAdapter`は権限を制限したstructured promptによるcompleted turn後のCharacter Affect評価を担う。型と入力・出力の正本は`src-electron/providers/provider-runtime.ts`に置く。

Provider 実行が失敗した場合、adapter は `ProviderTurnError` を投げる。`canceled` は既存の session phase / retry / invalidation 判定のため boolean として維持し、失敗分類は `reason` で渡す。

Provider 固有の error message 判定は adapter 側に閉じる。`SessionRuntimeService` は `reason` を見て audit log と assistant fallback message を分け、provider 固有の英語 message を再 parse しない。

監査用途では、provider 実行結果から `logical prompt`、`transport payload`、operations、raw items、usage も Main Process へ返し、SQLite の監査ログに保存する。
Main Processでは`MainProviderFacade`がcoding planeとbackground planeの入口を分ける。`SessionRuntimeService`はcoding plane、completed turn後のCharacter Affect評価はbackground planeを使う。

providerごとの差は次。

- `CodexAdapter`
  - turnごとに公式Codex CLIの`app-server --listen stdio://`を起動し、`initialize` / `initialized`後に`thread/start`または保存済みIDの`thread/resume`、`turn/start`を実行する。native item / delta / usage通知からlive state、監査、workspace snapshotを含むartifactを組み立てる
  - command / file approval、permissions、user-input、MCP elicitationのserver requestを元のrequest IDとの対応を保持して共通GUIへ直列中継し、応答は元のIDへ返す。GUIのrequest IDは独立したopaque IDとする。`serverRequest/resolved`、turn終了、取消でpendingと待機列を解放し、二重回答・別turnへの回答を拒否する
  - 実行中追加入力は現在のthread IDと`expectedTurnId`を使う`turn/steer`へ送る。terminal後は入力を受け付けない。dispatch済みsteerの応答はRPC timeoutの有界範囲で待ってからtransportを閉じ、terminalより遅れた成功ACKも受理結果として保持する。一致するACKで受理された本文・file/folder path・image入力は対応turnのRaw Itemsへ秘匿化・サイズ上限付きで保存する。開始時のlogical prompt / transport payloadとは区別し、拒否された入力は受理済みtraceへ含めない
  - terminalはnative `turn/completed`のstatusを正本とし、受信済み通知は後続EOFでも到着順に処理する。EOF自体は成功の根拠にしない。終了・取消時は所有processと子孫をboundedに終了する。Windowsは起動前にJob Objectへsupervisorを割り当て、POSIXは専用process groupを使う。cleanup失敗は診断として独立して報告し、native terminal outcomeを上書きしない。所有processの終了確認まで同一Session・workspace・threadへの再実行を拒否し、Session runtimeの終了中guardを維持する
  - background structured promptは独立した非継続thread、`read-only` / `never`、`outputSchema`で実行し、interactive requestを拒否する
  - `file / folder / image` 添付を shipped
  - workspace 外 access は session metadata `allowedAdditionalDirectories` を正本にして制御する
  - binary pathは`src-electron/providers/provider-binary-paths.ts`を正本とし、開発時は固定版`@openai/codex`のnative package、配布時は`resources/provider-binaries/`配下のstaged binaryを直接起動する。App Serverのenvironmentへcredentialとturnのruntime bindingを明示し、global `process.env`は書き換えない
- `CopilotAdapter`
  - `session.send()` と session event stream を使い、最小 turn 実行、assistant text streaming、minimal audit log を返す
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
  - `LatestCommand` と audit `operations` には、`shell / powershell / bash` に加えて `create / edit / replace / move / delete` のような mutating tool も `command_execution` として正規化して返す
  - `rawItemsJson` は full session dump ではなく、`tool.execution_*`、`assistant.message`、`assistant.usage` など監査で読む stable event trace に絞って返す
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
  - SDKの`PreToolUse`でread-only以外をaskにし、native設定が自動許可する場合も`canUseTool`からWithMateの共通承認UIへ中継する。`AskUserQuestion`は選択肢と自由入力を保持した共通質問UIへ、MCP elicitationも共通UIへ中継する。同一turnの承認・質問は直列化し、未回答のpending要求を上書きしない。MCPのfield変換はCopilotと共有し、選択肢のlabel、既定値、入力制約を保持する。応答・tool操作・usageを共通live state、監査、artifactへ投影し、Bashだけをraw command付きの`command_execution`として扱う
  - background planeは別の非永続sessionで構造化JSONを要求し、tools / MCP / hooksを無効化する。`resolveSettings({ cwd, settingSources: [] })`でmanaged sourceまたは設定検査失敗を検出した場合、実行物を起動せず拒否する。user / project / local設定は読まず、親プロセスの環境変数とSDKが参照する既存CLIログインを利用する。設定ファイルだけにある認証helperや認証・接続先設定は共有しない
  - SDK transcriptはWithMateの履歴・workspaceとは別にClaude側が管理し、WithMateのsession削除で消さない。quota残量は取得不能としてtelemetryを`null`にし、token / cache usageのみturn単位で扱う。API換算USDは実請求額として表示しない。backgroundの補助処理も解決された認証先の利用枠を消費する。同じ契約枠になる条件は[Provider Usage Telemetry](provider-usage-telemetry.md)に従う

## Plane Separation

provider 境界は current 実装で次の 2 plane に分けて扱う。

### Coding Plane

- Session の通常 turn 実行
- prompt composition
- live state / approval / elicitation / quota / context telemetry
- thread invalidation

利用側:

- `SessionRuntimeService`
- `MainObservabilityFacade`
- `MainProviderFacade#getProviderCodingAdapter()`

### Background Plane

- completed turn後のCharacter Affect評価

利用側:

- `character-affect-turn-main-lifecycle`
- `MainProviderFacade#getProviderBackgroundAdapter()`

この分離により、通常のcoding turnと完了後のAffect評価をadapterの入口で分ける。

## Session Flow

1. Renderer が送信時の表示選択を `executionOptions` に固定し、`runSessionTurn(sessionId, { userMessage, executionOptions })` を IPC で Main Process に送る。Main Session と Auxiliary Session は同じ実行契約を使う
2. Main Process が session store から thread、workspace、Character などの session context を引く。保存済みの実行設定はこの turn の実行値にしない
3. 保存済みCharacter snapshotとturn contextを解決する
4. Main Process が textarea 内の `@path` を解決し、file / folder / image を正規化する
   - workspace 外 path は `allowedAdditionalDirectories` 配下だけを許可する
5. prompt composer がCharacter context、user inputと添付referenceをproviderへ渡す形式に正規化する
6. Main Process が送信された `executionOptions.catalogRevision` と session の `provider` から provider catalog を解決し、revision、model、reasoning depth、実行 option 値を検証する。model が存在しない、depth が非対応などの不正な選択は turn 開始保存・Provider 起動前に拒否し、default や保存値へ置換しない
7. 検証済み`executionOptions`を独立したturn snapshotとしてprompt、coding plane adapter、監査ログへ渡し、provider-native実行へ変換する
   - `CodexAdapter`: file / folderのworkspace外accessはsession metadata `allowedAdditionalDirectories`からsandbox policyの`writableRoots`へ変換し、画像は`localImage` inputとして`turn/start`へ渡す。model、effort、approval、sandbox、service tier、reviewerは送信時の検証済み値を使う
   - `CopilotAdapter`: prompt composerの結果とattachmentを送る。file / folderは`session.send({ attachments })`の`file` / `directory`へ変換し、imageも`file` attachmentとして渡す。workspace外pathはWithMate側の`allowedAdditionalDirectories`判定を正本にする。`on-request`ではpermission requestをMain Processへ返し、Session UIのapproval cardと往復する。Electronではnative CLI binaryを明示して起動し、bootstrap failure時はaudit logにdebug metadataを残す
   - `ClaudeAdapter`: 共通prompt、検証済み添付、実行optionをSDK `query()`へ渡す。`resume`は保存済みの明示session IDだけを使い、承認・質問を共通pending UIへ返す
8. Main Process が stream event から live state と provider telemetry を組み立て、IPC で Session Window へ中継する
   - live state には `approvalRequest` と `elicitationRequest` を含められる
   - quota telemetry は provider 単位、context telemetry は session 単位で memory cache する
   - Codexはnative `turn/completed`の`completed / failed / interrupted`をterminal outcomeの正本とする。`error`通知はdiagnosticとして扱い、terminal前の切断は失敗とする。transport終了はbounded cleanupとして扱う
9. turn 完了後に Main Process が `threadId` と assistant message を session store に反映する
10. Main Process が `running / completed / canceled / failed` の監査ログを 1 turn 1 record で SQLite に保存する。terminal phase の最小更新を先に確定し、詳細は bounded enrichment として後段で更新する
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

workspace 外 path の access control は provider 任せにせず、WithMate が session metadata `allowedAdditionalDirectories` を正本にして先に判定する。

picker で選んだ file / folder / image も renderer 側では textarea に `@path` を挿入するだけで、実行直前の解決対象は textarea の `@path` のみとする。

the text prompt 側には `# System Prompt` と `# User Input Prompt` を自動付与し、各レイヤーを空行区切りで結合する。

詳細は `docs/design/prompt-composition.md` を参照する。

## Thread Management

- sessionごとにprovider固有の会話IDを保持する。Codexはturnごとの新しいApp Serverで保存済み`threadId`を`thread/resume`へ渡し、未作成時は`thread/start`する。Claudeは同じ保存fieldの明示IDをSDK `resume`へ渡し、未作成時は新規`query()`を使う
- 実行後にproviderが返した会話IDをsession storeへ保存する
- model または reasoning depth を変更した場合も、その session の `threadId` は維持し、次回 turn は送信された runtime parameter で既存 thread / session の resume を試す
- Codexは毎turnの`thread/start` / `thread/resume`と`turn/start`へ送信時の実行optionを渡す
- Codex / Copilotのcoding credentialは`AppSettings.codingProviderSettings[providerId].apiKey`から解決する。Codexは設定値を優先し、未設定時は継承した`CODEX_API_KEY`を使う。キーがある場合だけApp Serverを`cli_auth_credentials_store="ephemeral"`で起動し、initialize後の`account/login/start`へ渡す。認証はprocess内に限定し、保存済みCLI認証を変更しない。キーがなければ既存CLI認証を使う。CopilotはSDK clientへ渡す。Claudeは既存CLI認証をSDKに任せ、WithMateのcredential設定へ取り込まない
- coding credential が変わった provider では既存 thread / adapter cache を再利用しないため、対象 session の `threadId` を空に戻す

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

- renderer / shared state / session persistence / audit logではCodex policy値をwrite-pathの正本として扱う
- 既存 row に残る legacy 値は read-path normalize で吸収する
  - `allow-all -> never`
  - `safety -> untrusted`
  - `provider-controlled -> on-request`
- CodexAdapterは`approvalMode`をApp Serverの`approvalPolicy`へそのまま渡す
- CopilotAdapter は `never` を自動許可、`untrusted` を read-only 以外 rules deny、`on-request` を Session UI の approval card 中継として扱う
- ClaudeAdapterは`on-request`だけを選択可能にし、SDKのdefault permissionと共通approval / elicitation UIで処理する
- UIはpolicy値をそのまま表示せず、`Auto Run` / `Provider Controlled` / `Safety Focused`のdisplay labelへ変換する。保存・API・adapter境界ではpolicy値をrawのまま保持し、providerごとに出すchoicesを分ける

session作成、永続化、監査、artifact表示、resume復元ではpolicy値を追跡し、providerごとの差異はprovider-specific choicesとadapter実装で吸収する。

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
- live state には少なくとも次を含める
  - 最新の assistant text
  - 実行中 / 完了 / 失敗の step 一覧
  - usage
  - stream 中の error
  - 必要なら pending approval request
- Codex native itemsに`agentMessage`が複数ある場合、Session UIに表示するassistant textはarrival順に空行区切りで連結する
- Codexの一時的なstream errorは同一thread / turnの有効なitem activityで解除する。別scopeや未知itemへのdeltaでは解除せず、terminal後は確定した失敗理由を保持する
- Raw Itemsとoperationsは各`agentMessage`を個別に保持し、監査では元の粒度を失わない
- live state は Main Process の memory 上だけに持ち、session DB へは保存しない
- Session Window を開き直した場合は、Main Process が保持している live state を再購読して復元する
- Session Window から `Cancel` を押した場合は、Main Process が保持している `AbortController` で provider 実行を中断する
- Claudeの個別approval / elicitation要求はSDKのrequest signalとturn signalを共通pending serviceまで渡す。要求取消ではresolverとlive表示を解除してから直列待機列の次要求を表示し、取消済みrequestIdへの回答は拒否する。待機列内の取消済み要求は表示せず、turn全体の取消・子プロセス実終了待ちとは区別する
- Copilot の approval request は Main Process が pending resolver を保持し、Session UI の `今回だけ許可 / 拒否` を受けて permission handler を再開する
- turn 完了時だけ session 本体と audit log を確定値で更新する
- canceled / failedでも、取得済みassistant textとnative itemsはpartial resultとして回収し、Audit Logと`Details`に残す

## Error Handling

- provider 実行失敗時は Main Process が session を `runState=error` へ更新する
- Renderer に raw stack trace は出さず、UI 向けの失敗メッセージへ整形する
- Codexの失敗時は保存済み`threadId`を保持し、resume拒否を新threadの成功へ置き換えない。他providerのstale session回復は各adapterの契約に従う
- ユーザーキャンセル時は監査ログに `phase=canceled` を記録する
- setup 中の cancel intent も保持し、setup dependency または provider が abort 後に settle しない場合は cancel grace 後に呼び出しを収束させる。元処理が実際に終了するまでは同一 session の再送を拒否する
- Main は取消受付を live run の `cancellationState = requested`、cancel grace 後も未終了の処理を `terminating` として投影する。terminal Session の保存が `idle` を返しても取消待ちを解除せず、元処理と終端保存が終了して admission guard が解放された時に live 取消状態を解除・通知する。重複取消は同一 turn の要求として扱う
- 失敗時は監査ログにも `phase=failed` を記録し、`system / input / composed prompt` と error を残す
- canceled / failed のどちらでも、取得済みの `assistant text` / operations / raw items / artifact があれば捨てずに残す
- `CopilotAdapter` は cached session 再利用中の `SessionNotFound` / stale connection も同一 turn 内で 1 回だけ internal retry できる
  - retry 前には cached `CopilotSession` と client cache を破棄する
  - retry 後は既存の `resumeSession(threadId)` を再試行し、missing session なら `createSession()` fallback へ落とす
  - `raw items` しか無い失敗や `session.error` だけの局面では retry を妨げず、`assistantText` / completed 済みの command / `artifact.changedFiles` など user-visible partial がある時だけ retry を止める
  - `tool.execution_start` や pending permission のような未確定 step は retry blocker に含めない
- DB reset は running session がある間は拒否し、そのエラーメッセージを renderer にそのまま返す

## Audit Logging

- prompt composer が作った `system / input / composed prompt` を監査ログへ保存する
- 画像添付がある場合の `composed prompt` は text 部分のみで、画像 payload は別送される
 - Copilot の file / folder attachment も text prompt とは別送される
- provider itemsは読みやすい`operations`とrawの`raw_items_json`の両方で残す
- Session Window から監査ログを overlay で閲覧できるようにする
- stream中のassistant snapshotと変更stepは、変更ownerからのprogress情報を使って監査ログへ増分保存する。受付容量超過は明示失敗とし、表示用のlatest-only集約でAuditを省略しない。受付・終端後の保存順序は[Audit Log](audit-log.md)を参照する
- Settings の DB reset を実行した場合は audit logs も初期化対象に含める

## Slash Command Routing

- slash commandはproviderへそのまま渡さない
- Renderer / Main Process が先に app command または session setting command として解釈する
- adapter は slash command 自体を parse せず、送信時に固定された実行 option を provider-native option へ変換する

## Agent / Skill Mapping

- skill 探索元は次を使う
  - `codingProviderSettings[providerId].skillRootPath` と任意の `skillRelativePath` から解決した provider skill root
  - workspace 標準 skill roots (`skills`, `.github/skills`, `.copilot/skills`, `.codex/skills`, `.claude/skills`)
- `codingProviderSettings[providerId].instructionRelativePath` は provider ごとの instruction file 設定として保持するが、skill 探索やprompt compositionでは参照しない
- 同名 skill は workspace 優先で dedupe する
- adapter は選択済み skill を provider ごとの prompt / option へ変換する
  - Codex: `$skill-name` mention
  - Copilot: explicit skill directive を prompt へ付加
  - Claude: 選択済みskillのpathを明示するdirectiveをpromptへ付加する。設定したskill root全体をSDKのnative Skill探索元として追加しない
- `agent` は provider 専用 command とする
  - Codex: 未対応
  - Copilot: custom agent selection を session metadata に保存し、送信時に固定した選択値と `~/.copilot/agents`・workspace `.github/agents` から探索した agent catalog を adapter が `customAgents` / `agent` に変換する

## References

- `docs/design/prompt-composition.md`
- `docs/design/electron-session-store.md`
- `docs/design/model-catalog.md`
- `docs/design/audit-log.md`
- `docs/design/coding-agent-capability-matrix.md`
