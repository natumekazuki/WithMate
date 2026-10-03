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
- Electron Renderer へ SDK 実行権限を持ち込まなくてよい
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
  - `thread.runStreamed()` を使い、workspace snapshot を含む artifact まで組み立てる
  - `file / folder / image` 添付を shipped
  - workspace 外 access は session metadata `allowedAdditionalDirectories` を正本にして制御する
  - packaged runtime では `src-electron/providers/provider-binary-paths.ts` を通して `resources/provider-binaries/` 配下の staged binary を `codexPathOverride` で明示する
- `CopilotAdapter`
  - `session.send()` と session event stream を使い、最小 turn 実行、assistant text streaming、minimal audit log を返す
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
  - current slice は Copilot-only で、task の create/list/control RPC までは吸収しない。Codex current SDK に同等 surface は無い
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
7. 検証済み `executionOptions` を独立した turn snapshot として prompt、coding plane adapter、監査ログへ渡し、provider-native SDK 実行へ変換する
   - `CodexAdapter`: file / folder の workspace 外 access は session metadata `allowedAdditionalDirectories` だけを `additionalDirectories` へ変換し、画像は structured input にして `thread.runStreamed()` を実行する
   - `CopilotAdapter`: prompt composerの結果とattachmentを送る。file / folderは`session.send({ attachments })`の`file` / `directory`へ変換し、imageも`file` attachmentとして渡す。workspace外pathはWithMate側の`allowedAdditionalDirectories`判定を正本にする。`on-request`ではpermission requestをMain Processへ返し、Session UIのapproval cardと往復する。Electronではnative CLI binaryを明示して起動し、bootstrap failure時はaudit logにdebug metadataを残す
   - `ClaudeAdapter`: 共通prompt、検証済み添付、実行optionをSDK `query()`へ渡す。`resume`は保存済みの明示session IDだけを使い、承認・質問を共通pending UIへ返す
8. Main Process が stream event から live state と provider telemetry を組み立て、IPC で Session Window へ中継する
   - live state には `approvalRequest` と `elicitationRequest` を含められる
   - quota telemetry は provider 単位、context telemetry は session 単位で memory cache する
   - Codex は `turn.completed` / `turn.failed` / fatal `error` の最初の event を terminal outcome の正本とし、transport EOF は bounded cleanup として扱う
9. turn 完了後に Main Process が `threadId` と assistant message を session store に反映する
10. Main Process が `running / completed / canceled / failed` の監査ログを 1 turn 1 record で SQLite に保存する。terminal phase の最小更新を先に確定し、詳細は bounded enrichment として後段で更新する
11. Renderer は Session summary invalidation と live state 購読を使って再描画する

## Prompt Composition Constraint

添付はproviderごとのtransportへ変換する。

- `Codex`
  - file / folder: session metadata `allowedAdditionalDirectories` を `additionalDirectories` へ変換
  - image: structured input (`local_image`)
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

- sessionごとにprovider固有の会話IDを保持する。Codexは`threadId`から`resumeThread()`し、未作成時は`startThread()`する。Claudeは同じ保存fieldの明示IDをSDK `resume`へ渡し、未作成時は新規`query()`を使う
- 実行後に `thread.id` を session store へ保存する
- model または reasoning depth を変更した場合も、その session の `threadId` は維持し、次回 turn は送信された runtime parameter で既存 thread / session の resume を試す
- Codex の `approvalMode` / `codexSandboxMode` は thread settings key に含める。変更後の turn では既存 thread cache を再利用せず、送信された runtime parameter で `resumeThread()` または `startThread()` する
- Codex / Copilotのcoding credentialは`AppSettings.codingProviderSettings[providerId].apiKey`から解決してSDK clientへ渡す。Claudeは既存CLI認証をSDKに任せ、WithMateのcredential設定へ取り込まない
- coding credential が変わった provider では既存 thread / adapter cache を再利用しないため、対象 session の `threadId` を空に戻す

理由:
- provider prompt は過去の `session.messages` を毎 turn 再送せず、会話継続は provider 側の `threadId` に依存するため、model / reasoning depth 変更だけで `threadId` を消すと履歴が途切れる
- Copilot / Codex adapter は settings key 差分時に cache を切り替え、新しい runtime parameter 付きで `resumeSession(threadId, config)` / `resumeThread(threadId, options)` を試す
- 既存 thread / session が失効または model-incompatible で拒否された場合は、runtime が meaningful partial の無い stale error だけを `threadId clear + provider cache invalidate + 1 回 internal retry` で新規 thread / session へ回復する
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

- renderer / shared state / session persistence / audit log では SDK policy 値を write-path の正本として扱う
- 既存 row に残る legacy 値は read-path normalize で吸収する
  - `allow-all -> never`
  - `safety -> untrusted`
  - `provider-controlled -> on-request`
- CodexAdapter は `approvalMode` を SDK `approvalPolicy` へそのまま渡す
- CopilotAdapter は `never` を自動許可、`untrusted` を read-only 以外 rules deny、`on-request` を Session UI の approval card 中継として扱う
- ClaudeAdapterは`on-request`だけを選択可能にし、SDKのdefault permissionと共通approval / elicitation UIで処理する
- UIはSDK値をそのまま表示せず、`Auto Run` / `Provider Controlled` / `Safety Focused` のdisplay labelへ変換する。保存・API・adapter境界ではSDK policy値をrawのまま保持し、providerごとに出すchoicesを分ける

これにより、session 作成、永続化、監査、artifact 表示、resume 復元では SDK 値を追跡しつつ、provider ごとの差異は provider-specific choices と adapter 実装で吸収する。

## Sandbox Modes

Codex session は `codexSandboxMode` を持つ。UI では Codex provider のときだけ Sandbox dropdown を表示する。

- `read-only`
- `workspace-write`
- `workspace-write + network`
- `danger-full-access`

`workspace-write + network` は WithMate 側の UI option であり、Codex SDK へは `sandboxMode: "workspace-write"` と `networkAccessEnabled: true` の組み合わせで渡す。他の provider は現時点で sandbox dropdown を表示しない。

## Model Resolution Policy

- session metadata は選択状態を保存するが、turn の Provider 実行値は Main / Auxiliary の送信要求に含まれる `executionOptions` を使う
- Main Process は送信された catalog revision と session provider の catalog を解決し、snapshot revision、model、reasoning effort を実行開始前に検証する
- model 自体が見つからない場合はそのままエラーにする
- selected depth が非対応ならそのままエラーにする
- 保存済みの値、catalog default、depth clamp への暗黙の置換はしない
- provider 実行時に拒否された場合も、そのまま session error として扱う

詳細は `docs/design/model-catalog.md` を参照する。

## Artifact Summary Policy

Codex SDKの`turn.items`とworkspace snapshot差分からsummaryを組み立てる。

- `file_change` + snapshot diff -> changed files
- `command_execution` -> activity summary
- `mcp_tool_call` / `web_search` / `todo_list` / `reasoning` -> activity summary
- approval -> run checks の provider-neutral canonical value
- usage -> run checks
- model / reasoning -> run checks

diff 本文は turn items からは直接取れないため、Main Process 側で `before / after` スナップショットを補完取得する。
CodexAdapter は `workspacePath + allowedAdditionalDirectories` ごとに process memory の `WorkspaceSnapshotIndex` を持つ。初回または invalidation 時は full rebuild し、全 session thread の invalidation 時は index cache も破棄する。その後の turn 開始時・終了時は index refresh を通して snapshot を取得する。既存 file の mtime / size だけが変わった場合は、全 file 本文を読み直さず、変化した file だけ再読込する。

turn 終了後の snapshot は provider outcome に対する enrichment である。取得が deadline を超えた場合は turn 自体を失敗へ変更せず、取得済み item から result を確定し、diff が不完全になり得ることを provider metadata と app log に残す。

`file_change` だけで変更候補を確定でき、`command_execution` / `mcp_tool_call` のような副作用範囲が不明な operation が無い場合は、候補ファイルだけを trusted candidate として refresh する。副作用範囲が不明な場合でも、directory 構造と ignore source が変わっていなければ、known file の stat 差分から incremental refresh する。directory mtime 変化、ignore source 変化、snapshot limit 超過または limit hit 状態、不確定な ignore 状態がある場合は full rebuild へ fallback する。

- 実行前に `workspacePath + allowedAdditionalDirectories` 全体の text file snapshot を取る
- 初回以降は `WorkspaceSnapshotIndex` の snapshot を before として使い、turn 前に index refresh で外部変更を反映する
- 実行後は completed `file_change` の候補ファイルだけを trusted candidate として refresh できる場合がある
- `command_execution` / `mcp_tool_call` がある場合も、directory 構造と ignore source が変わっていなければ known file の stat 差分だけで refresh する
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
- `turn.items` に `agent_message` が複数ある場合、Session UI に表示する assistant text は arrival 順に空行区切りで連結する
- Raw Items と operations は各 `agent_message` を個別に保持し、監査では元の粒度を失わない
- live state は Main Process の memory 上だけに持ち、session DB へは保存しない
- Session Window を開き直した場合は、Main Process が保持している live state を再購読して復元する
- Session Window から `Cancel` を押した場合は、Main Process が保持している `AbortController` で provider 実行を中断する
- Claudeの個別approval / elicitation要求はSDKのrequest signalとturn signalを共通pending serviceまで渡す。要求取消ではresolverとlive表示を解除してから直列待機列の次要求を表示し、取消済みrequestIdへの回答は拒否する。待機列内の取消済み要求は表示せず、turn全体の取消・子プロセス実終了待ちとは区別する
- Copilot の approval request は Main Process が pending resolver を保持し、Session UI の `今回だけ許可 / 拒否` を受けて permission handler を再開する
- turn 完了時だけ session 本体と audit log を確定値で更新する
- canceled / failed でも、途中まで取得できた `agent_message` と `turn.items` は partial result として回収し、Audit Log と `Details` に残す

## Error Handling

- provider 実行失敗時は Main Process が session を `runState=error` へ更新する
- Renderer に raw stack trace は出さず、UI 向けの失敗メッセージへ整形する
- 失敗時の `threadId` は既定では保持するが、`stale thread / session` または Codex の `Reading prompt from stdin...` のように「meaningful partial なしで再利用不能」と判定できる失敗では空へ戻す
- ユーザーキャンセル時は監査ログに `phase=canceled` を記録する
- setup 中の cancel intent も保持し、setup dependency または provider が abort 後に settle しない場合は cancel grace 後に呼び出しを収束させる。元処理が実際に終了するまでは同一 session の再送を拒否する
- Main は取消受付を live run の `cancellationState = requested`、cancel grace 後も未終了の処理を `terminating` として投影する。terminal Session の保存が `idle` を返しても取消待ちを解除せず、元処理と終端保存が終了して admission guard が解放された時に live 取消状態を解除・通知する。重複取消は同一 turn の要求として扱う
- 失敗時は監査ログにも `phase=failed` を記録し、`system / input / composed prompt` と error を残す
- canceled / failed のどちらでも、取得済みの `assistant text` / operations / raw items / artifact があれば捨てずに残す
- stale thread / session 起因エラー、または Codex の thread bootstrap 直後に `Reading prompt from stdin...` で落ちる再利用不能エラーに限り、`SessionRuntimeService` は同一 user turn 内で 1 回だけ internal retry できる
  - 対象は `NotFound / expired / invalid-thread / model-incompatible` に加え、meaningful partial を持たない Codex startup failure の narrow classifier に限る
  - retry 前には `threadId` を空へ戻し、provider cache invalidate を必ず同時に行う
  - `assistantText` / operations / artifact.changedFiles などの meaningful partial が既に出ている場合は retry しない
  - public API / renderer からの再送には広げない
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
- `turn.items` は読みやすい `operations` と raw の `raw_items_json` の両方で残す
- Session Window から監査ログを overlay で閲覧できるようにする
- stream 中の一時 step は監査ログへ逐次保存せず、turn 完了後の確定値だけを残す
- Settings の DB reset を実行した場合は audit logs も初期化対象に含める

## Slash Command Routing

- slash command は provider SDK へそのまま渡さない
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
