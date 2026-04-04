# Provider Adapter

- 作成日: 2026-03-13
- 対象: WithMate の Main Process に置く provider 実行境界

## Goal

Renderer が provider ごとの差異を知らずに、`Session Window` の送信と結果反映を扱えるようにする。

## Position

- provider 実行境界と current adapter 責務の正本はこの文書とする
- current capability の一覧は `docs/design/coding-agent-capability-matrix.md` を参照する
- provider ごとの詳細 snapshot は `docs/design/codex-capability-matrix.md` などの supporting doc を参照する
- SDK surface 不足で保留している項目は、この文書または capability matrix に follow-up として反映する

## Boundary

WithMate では provider 実行境界を Main Process に置く。

理由:
- CLI ログイン状態を安全に引き継ぎやすい
- Electron Renderer へ SDK 実行権限を持ち込まなくてよい
- session store と thread id を同じ責務で管理できる

## Current Runtime

current runtime は shared contract の上に次の 2 adapter を持つ。

- `CodexAdapter`
- `CopilotAdapter`

```ts
type ProviderCodingAdapter = {
  composePrompt(input: RunSessionTurnInput): ProviderPromptComposition;
  getProviderQuotaTelemetry(input: GetProviderQuotaTelemetryInput): Promise<ProviderQuotaTelemetry | null>;
  invalidateSessionThread(sessionId: string): void;
  invalidateAllSessionThreads(): void;
  runSessionTurn(input: {
    session: Session;
    sessionMemory: SessionMemory;
    projectMemoryEntries: ProjectMemoryEntry[];
    character: CharacterProfile;
    providerCatalog: ModelCatalogProvider;
    userMessage: string;
    appSettings: AppSettings;
    attachments: ComposerAttachment[];
    signal?: AbortSignal;
    onApprovalRequest?: (request: LiveApprovalRequest) => Promise<"approve" | "deny">;
    onProviderQuotaTelemetry?: (telemetry: ProviderQuotaTelemetry) => void | Promise<void>;
    onSessionContextTelemetry?: (telemetry: SessionContextTelemetry) => void | Promise<void>;
  }, onProgress?: (state: LiveSessionRunState) => void | Promise<void>): Promise<ProviderTurnResult>;
};
```

```ts
type ProviderBackgroundAdapter = {
  extractSessionMemoryDelta(input: ExtractSessionMemoryInput): Promise<ExtractSessionMemoryResult>;
  runCharacterReflection(input: RunCharacterReflectionInput): Promise<RunCharacterReflectionResult>;
};
```

```ts
type ProviderTurnResult = {
  threadId: string | null;
  assistantText: string;
  artifact?: MessageArtifact;
  logicalPrompt: {
    systemText: string;
    inputText: string;
    composedText: string;
  };
  transportPayload: {
    summary: string;
    fields: Array<{ label: string; value: string }>;
  } | null;
  operations: AuditLogOperation[];
  rawItemsJson: string;
  usage: AuditLogUsage | null;
};
```

```ts
type ProviderTurnAdapter = ProviderCodingAdapter & ProviderBackgroundAdapter;
```

監査用途では、provider 実行結果から `logical prompt`、`transport payload`、operations、raw items、usage も Main Process へ返し、SQLite の監査ログに保存する。
Main Process では `MainProviderFacade` が `coding plane` と `background plane` の入口を分けて解決し、`SessionRuntimeService` は coding plane、`MemoryOrchestrationService` は background plane だけを見る。

current milestone の provider ごとの差は次。

- `CodexAdapter`
  - `thread.runStreamed()` を使い、workspace snapshot を含む artifact まで組み立てる
  - `file / folder / image` 添付を shipped
  - workspace 外 access は session metadata `allowedAdditionalDirectories` を正本にして制御する
  - packaged runtime では `src-electron/provider-binary-paths.ts` を通して `resources/provider-binaries/` 配下の staged binary を `codexPathOverride` で明示する
- `CopilotAdapter`
  - `session.send()` と session event stream を使い、最小 turn 実行、assistant text streaming、minimal audit log を返す
  - top-level `assistant.message` が複数回来た場合は、arrival 順に空行区切りで連結した本文を `assistantText` として返す
  - character prompt は `SessionConfig.systemMessage` `mode: "append"` に載せ、`session.send()` には user input 本文を送る
  - `file / folder` は Copilot SDK `attachments` (`file` / `directory`) へ変換して送る
  - `image` も `attachments` の `file` として送り、専用 UI 分岐は持たない
  - custom agent は `~/.copilot/agents` と workspace `.github/agents` を探索し、picker には `user-invocable: true` の定義だけを出す。session metadata の選択値は `customAgents` / `agent` に変換する
  - rich command timeline は未対応
  - `provider-controlled` で non-read-only permission request が来た場合は、Main Process の `onApprovalRequest` bridge を通して Session UI の approval card へ中継し、user の `approve / deny` を SDK `PermissionHandler` へ返す
  - `elicitation.requested` が来た場合は、Main Process の `onElicitationRequest` bridge を通して Session UI の form / url card へ中継し、user の `accept / decline / cancel` を RPC で返す
  - Electron main process では `src-electron/provider-binary-paths.ts` を正本にして staged native Copilot CLI binary を明示して起動する
  - `Latest Command` と audit `operations` には、`shell / powershell / bash` に加えて `create / edit / replace / move / delete` のような mutating tool も `command_execution` として正規化して返す
  - `rawItemsJson` は full session dump ではなく、`tool.execution_*`、`assistant.message`、`assistant.usage` など監査で読む stable event trace に絞って返す
  - `artifact` は snapshot diff fallback を使って `changedFiles / runChecks / operationTimeline` を最小構成で返す
  - `Premium Requests` は `client.rpc.account.getQuota()` と `assistant.usage.quotaSnapshots` から app-wide telemetry として更新する
  - `Context Usage` は `session.usage_info` を session local telemetry として Main Process memory に保持する
  - background task は `session.idle.backgroundTasks` と `system.notification` を `LiveSessionRunState.backgroundTasks` へ正規化し、Session 右ペインの Copilot 専用 `Tasks` tab へ流す
  - current slice は Copilot-only で、task の create/list/control RPC までは吸収しない。Codex current SDK に同等 surface は無い

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

- `Session Memory extraction`
- `character reflection cycle`

利用側:

- `MemoryOrchestrationService`
- `MainProviderFacade#getProviderBackgroundAdapter()`

この分離により、通常の coding turn と裏で走る memory / monologue 系処理の責務を adapter の入口で混ぜない。

## Session Flow

1. Renderer が `runSessionTurn(sessionId, { userMessage })` を IPC で Main Process に送る
2. Main Process が session store から session metadata を引く
3. `characterId` で `CharacterProfile` を読む
4. Main Process が textarea 内の `@path` を解決し、file / folder / image を正規化する
   - workspace 外 path は `allowedAdditionalDirectories` 配下だけを許可する
5. Main Process が app settings から `System Prompt Prefix` を読む
6. prompt composer が `# System Prompt + (system prompt prefix + roleMarkdown) + # User Input Prompt + userMessage` を空行区切りで合成する
7. Main Process が session の `catalogRevision` と `provider` から provider catalog を解決する
8. `MainProviderFacade` が coding plane adapter を解決し、`model / reasoningEffort` を検証したうえで provider-native SDK 実行へ変換する
   - `CodexAdapter`: file / folder の workspace 外 access は session metadata `allowedAdditionalDirectories` だけを `additionalDirectories` へ変換し、画像は structured input にして `thread.runStreamed()` を実行する
   - `CopilotAdapter`: `systemPromptPrefix + roleMarkdown` は `SessionConfig.systemMessage` `mode: "append"` に載せ、`session.send()` には user input 本文だけを送る。file / folder は `session.send({ attachments })` の `file` / `directory` へ変換して同時に渡す。image も `file` attachment として吸収し、renderer 側では共通の `Image` 導線を維持する。workspace 外 path は WithMate 側の `allowedAdditionalDirectories` 判定だけを正本にして許可する。`provider-controlled` では permission request を Main Process へ返し、Session UI の approval card と往復する。Electron では native CLI binary を明示して起動し、bootstrap failure 時は audit log に debug metadata を残す
9. Main Process が stream event から live state と provider telemetry を組み立て、IPC で Session Window へ中継する
   - live state には `approvalRequest` と `elicitationRequest` を含められる
   - quota telemetry は provider 単位、context telemetry は session 単位で memory cache する
10. turn 完了後に Main Process が `threadId` と assistant message を session store に反映する
11. Main Process が `running / completed / canceled / failed` の監査ログを 1 turn 1 record で SQLite に保存する
12. Renderer は `sessions-changed` と live state 購読を使って再描画する

## Prompt Composition Constraint

現時点の provider 差分は、添付の扱いで最も大きい。

- `Codex`
  - file / folder: session metadata `allowedAdditionalDirectories` を `additionalDirectories` へ変換
  - image: structured input (`local_image`)
- `Copilot`
  - SDK native には `attachments` として `file` / `directory` attachment がある
  - current milestone の `CopilotAdapter` は file / folder に加えて image も `file` attachment として吸収する

workspace 外 path の access control は provider 任せにせず、WithMate が session metadata `allowedAdditionalDirectories` を正本にして先に判定する。

picker で選んだ file / folder / image も renderer 側では textarea に `@path` を挿入するだけで、実行直前の解決対象は textarea の `@path` のみとする。

the text prompt 側には `# System Prompt` と `# User Input Prompt` を自動付与し、各レイヤーを空行区切りで結合する。

詳細は `docs/design/prompt-composition.md` を参照する。

## Thread Management

- session ごとに 1 つの Codex thread を持つ
- session に `threadId` がある場合は `resumeThread(threadId)` を使う
- ない場合は `startThread()` で新規作成する
- 実行後に `thread.id` を session store へ保存する
- model または reasoning depth を変更した場合は、その session の `threadId` を空に戻し、同時に provider 側の session / thread cache も invalidate する。次回 turn は新規 thread で開始する
- provider ごとの coding credential は `AppSettings.codingProviderSettings[providerId].apiKey` から解決して SDK client へ渡す
- coding plane の provider 設定は Character Stream 用 credential とは混ぜない
- coding credential が変わった provider では既存 thread / adapter cache を再利用しないため、対象 session の `threadId` を空に戻す

理由:
- Codex thread は作成時の model と結びつくため、既存 thread を別 model で `resumeThread()` すると provider 側で拒否されることがある
- coding credential を切り替えたあとに旧 client / 旧 thread 文脈を引き継ぐと runtime 差し替えが不透明になる
- そのため model / reasoning / credential 変更は「同一 session 内での thread 切り替え」として扱う

## Session Metadata Dependency

adapter 実行に最低限必要な session 情報:

- `session.id`
- `session.workspacePath`
- `session.catalogRevision`
- `session.provider`
- `session.approvalMode`
- `session.model`
- `session.reasoningEffort`
- `session.allowedAdditionalDirectories`
- `session.characterId`
- `session.threadId`

## Approval Modes

approval mode の正本は provider-neutral な 3 mode に揃える。

- `allow-all`
- `safety`
- `provider-controlled`

方針:

- renderer / shared state / session persistence / audit log では、この 3 mode だけを write-path の正本として扱う
- 既存 row や provider 由来の legacy/native 値 `never / untrusted / on-request / on-failure` は read-path normalize で吸収する
- adapter 境界だけで provider native policy へ変換する
  - `allow-all -> never`
  - `safety -> untrusted`
  - `provider-controlled -> on-request`
- adapter の外へ native policy 名を漏らさない
- UI wording は provider-neutral に固定し、`自動実行 / 安全寄り / プロバイダー判断` を共通表示として使う

これにより、session 作成、永続化、監査、artifact 表示、resume 復元では provider ごとの差異を持ち込まず、実行直前の adapter 実装だけが native policy を知る構成にする。

## Model Resolution Policy

- session metadata には user selection として `provider / model / reasoningEffort / catalogRevision` を保存する
- adapter 実行時に session が参照している catalog revision を使って `provider / model / reasoningEffort` を検証する
- model 自体が見つからない場合はそのままエラーにする
- selected depth が非対応ならそのままエラーにする
- provider 実行時に拒否された場合も、そのまま session error として扱う

詳細は `docs/design/model-catalog.md` を参照する。

## Artifact Summary Policy

MVP では Codex SDK の `turn.items` と workspace snapshot 差分から最小の summary を組み立てる。

- `file_change` + snapshot diff -> changed files
- `command_execution` -> activity summary
- `mcp_tool_call` / `web_search` / `todo_list` / `reasoning` -> activity summary
- approval -> run checks の provider-neutral canonical value
- usage -> run checks
- model / reasoning -> run checks

diff 本文は turn items からは直接取れないため、MVP では Main Process 側で `before / after` スナップショットを補完取得する。
`file_change` が返らない `command_execution` ベースの変更も、snapshot 差分から `Changed Files` へ補完する。

- 実行前に `workspacePath + allowedAdditionalDirectories` 全体の text file snapshot を取る
- snapshot の除外判定は、workspace から親方向へ探索した `.gitignore` を使う
- `.git` は `.gitignore` に関係なく常に除外する
- Git 管理下なら Git root までの `.gitignore` を上から順に積む
- Git 管理下なら `.git/info/exclude` も Git root 基準の ignore source として使う
- Git 管理下でない場合は、workspace 直下と最初に見つかった親の `.gitignore` までを使う
- workspace 配下で見つかった nested `.gitignore` は、そのディレクトリ以下にだけ適用する
- snapshot は 1 file あたり 1 MiB、全体で 4,000 files / 16 MiB を上限にする
- skipped / limit 到達がある場合は artifact `runChecks` に warning を残し、`Changed Files 0 件 = 変更なし` と断定しない
- `add`: `before = null`, `after = 実行後本文`
- `edit`: `before = 実行前 snapshot`, `after = 実行後本文`
- `delete`: `before = 実行前 snapshot`, `after = null`
- `ChangedFile.diffRows` は split diff viewer 向けに `add / edit / delete / modify / context` を持つ

この方式は GitHub Desktop ライクな side-by-side diff を優先した MVP であり、将来 streaming diff を導入する場合は取得経路を見直す。
さらに `.gitignore` の優先順や exclude source を厳密に Git 本体へ寄せたくなったら、その時点で拡張する。

## Streaming Policy

- provider 実行は `runStreamed()` を使い、turn 完了前の一時状態を Renderer へ中継する
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
- Copilot の approval request は Main Process が pending resolver を保持し、Session UI の `今回だけ許可 / 拒否` を受けて permission handler を再開する
- turn 完了時だけ session 本体と audit log を確定値で更新する
- canceled / failed でも、途中まで取得できた `agent_message` と `turn.items` は partial result として回収し、Audit Log と `Details` に残す

## Error Handling

- provider 実行失敗時は Main Process が session を `runState=error` へ更新する
- Renderer に raw stack trace は出さず、UI 向けの失敗メッセージへ整形する
- thread id が取得済みなら失敗時も保持する
- ユーザーキャンセル時は監査ログに `phase=canceled` を記録する
- 失敗時は監査ログにも `phase=failed` を記録し、`system / input / composed prompt` と error を残す
- canceled / failed のどちらでも、取得済みの `assistant text` / operations / raw items / artifact があれば捨てずに残す
- stale thread / session 起因エラーに限り、`SessionRuntimeService` は同一 user turn 内で 1 回だけ internal retry できる
  - 対象は `NotFound / expired / invalid-thread / model-incompatible` の narrow classifier に限る
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
- adapter は slash command 自体を parse せず、更新済み metadata を provider-native option へ変換する

## Agent / Skill Mapping

- skill 探索元は次を使う
  - `codingProviderSettings[providerId].skillRootPath`
  - workspace 標準 skill roots (`skills`, `.github/skills`, `.copilot/skills`, `.codex/skills`, `.claude/skills`)
- 同名 skill は workspace 優先で dedupe する
- adapter は選択済み skill を provider ごとの prompt / option へ変換する
  - Codex: `$skill-name` mention
  - Copilot: explicit skill directive を prompt へ付加
- `agent` は provider 専用 command とする
  - Codex: 未対応
  - Copilot: custom agent selection を session metadata に保存し、`~/.copilot/agents` と workspace `.github/agents` から探索した agent catalog を adapter が `customAgents` / `agent` に変換する

## Future Extension

将来は次を追加できる構造にする。

- provider ごとの prompt composer 差し替え
- artifact summary の richer な構造化
- Character Stream 用 provider / credential 設定の別系統化
- background plane の provider を coding plane と独立させる

## References

- `docs/design/prompt-composition.md`
- `docs/design/electron-session-store.md`
- `docs/design/model-catalog.md`
- `docs/design/audit-log.md`
- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/codex-capability-matrix.md`
