# Memory / Character Affect MCP運用

## 前提

Memory CLIとMCP serverは、起動中のWithMateが公開するloopback runtime APIへ接続する。どちらもSQLiteを直接開かず、WithMateが停止中の場合は別状態へ書き込まずに失敗する。

設計判断は`docs/adr/020-memory-affect-mcp-application-boundary.md`を参照する。一般Memoryのcontractとvalidationは`src/memory-v6/`、Character系contractは`src/character-context/`と`src/character-affect/`を正本とする。

## MCP serverの起動

開発環境では次を実行する。

```powershell
npm run build:memory-cli
node resources/skills/withmate-memory/bin/withmate-memory.mjs mcp-server
```

配布版では同梱された`withmate-memory`へ`mcp-server`を渡す。MCP clientには、このstdio commandをserver commandとして登録する。

同梱artifactはSDKを内包し、配布先の`node_modules`を参照しない。sourceまたは依存を変更した場合は`npm run build:memory-cli`で再生成し、分離した一時directoryからMCP initialize、`tools/list`、代表的なread/writeを実行してから配布する。

Character系は次の6 toolを公開する。

- `character_context.get`
- `character_affect.appraise`
- `character_memory.search`
- `character_memory.append_episode`
- `character_memory.correct`
- `character_memory.forget`

一般Memoryは次の11 toolを`memory.*` namespaceで公開する。

- `memory.search`
- `memory.get_entry`
- `memory.list_targets`
- `memory.list_entries`
- `memory.list_tags`
- `memory.append`
- `memory.forget`
- `memory.move_entry`
- `memory.get_file`
- `memory.export_files`
- `memory.file_usage`

`memory.append`、`memory.forget`、`memory.move_entry`はidempotency keyを必須とし、`memory.forget`と`memory.move_entry`はreasonも必須とする。`memory.forget`の`dryRun: true`はMemory、protected object、監査event、idempotency stateを変更しない。`memory.move_entry`はdry-runを受け付けない。成功responseの`replayed: true`は同一requestの再送を表す。keyを異なるrequestへ再利用した結果はdomain conflictであり、availability failureではない。

`memory.get_file`と`memory.export_files`は、target照合後に新しい出力fileだけを作成する。既存fileを上書きしないためdestructive annotationは付けないが、external side effectを持ち、同じrequestの再実行は既存file errorになり得るためread-onlyまたはidempotentとは表示しない。

Character系の`get`と`search`、一般Memoryのsearch/get/list/usageはread-onlyである。Characterの`appraise`と`append_episode`、一般Memoryの`append`はbounded writeである。runtime bindingで解決されたAgentは、明示target、具体的な理由、idempotency key、変更後のread-backを満たす場合、Characterの`correct`と`forget`、一般Memoryの`forget`と`move_entry`をユーザーの代理として自律実行できる。一般Memoryのbulk forgetは実行前にdry-runする。relationship affect correction、session / relationship affect reset、relationship boundary変更は、明示的なユーザー指示またはoperator authorityを必要とする。MCP tool inputはauthority文字列を受け付けない。CLIはCLI専用operator credential、MCPはMCP専用credentialで認証し、MCP credentialは公開toolに対応するruntime routeだけを呼び出せる。最終判定はWithMate application serviceが行う。

`memory.list_tags`は`targets`へ明示targetを1件だけ指定する。`limit`で1 pageのtag総数を制限し、`nextCursor`が返る間は同じtargetとcount条件で継続する。cursorはruntime発行値だけを使う。`sampleLimit`は`withCounts: true`時の各tagのsample数だけを制限し、tag総数の上限には使わない。

## CLI commandとMCP公開範囲

「公開」は同名のruntime routeを一般またはCharacter MCP toolから呼び出せることを表す。「MCPで代替済み」は専用toolを増やさず、MCP protocolまたは別の公開toolで同じ利用目的を満たすことを表す。

| CLI command | Runtime route | 判定 | MCP toolまたは代替経路 | 除外理由 |
| --- | --- | --- | --- | --- |
| `help` | なし | MCPで代替済み | server instructions、`tools/list` | CLIの表示用helpをpublic APIにしない |
| `status` | `/v1/status` | MCPで代替済み | MCP initializeと各toolのstructured availability error | runtime identity確認用routeをtool化しない |
| `characters` | `/v1/characters` | MCPで代替済み | `memory.list_targets`で`owner: character`と`includeEmpty: true`を指定 | Character definitionを広げずtarget inventoryだけを使う |
| `file-usage` | `/v1/file_usage` | 公開 | `memory.file_usage` | optional |
| `list-targets` | `/v1/list_targets` | 公開 | `memory.list_targets` | なし |
| `list-entries` | `/v1/list_entries` | 公開 | `memory.list_entries` | なし |
| `audit` | `/v1/audit` | operator/診断専用として除外 | CLI operator credential | repository横断の保守・診断候補を通常会話toolへ出さない |
| `search` | `/v1/search` | 公開 | `memory.search` | なし |
| `get-entry` | `/v1/get_entry` | 公開 | `memory.get_entry` | なし |
| `get-file` | `/v1/get_file` | 公開 | `memory.get_file` | target照合、絶対path、非上書きをserviceで維持する |
| `export-files` | `/v1/export_files` | 公開 | `memory.export_files` | target照合、絶対path、非上書きをserviceで維持する |
| `list-tags` | `/v1/list_tags` | 公開 | `memory.list_tags` | なし |
| `append` | `/v1/append` | 公開 | `memory.append` | MCPではidempotency keyを必須化する |
| `forget` | `/v1/forget` | 公開 | `memory.forget` | MCPではreasonとidempotency keyを必須化し、dry-runを維持する |
| `move-entry` | `/v1/move_entry` | 公開 | `memory.move_entry` | MCPではreasonとidempotency keyを必須化する |
| `context-get` | `/v1/character_context/get` | 公開 | `character_context.get` | なし |
| `affect-appraise` | `/v1/character_affect/appraise` | 公開 | `character_affect.appraise` | なし |
| `affect-inspect` | `/v1/character_affect/inspect` | operator/診断専用として除外 | CLI operator credential | 生eventとversionの運用inspectを通常会話toolへ出さない |
| `affect-correct` | `/v1/character_affect/correct` | operator/診断専用として除外 | CLI operator credential | version付き訂正はoperator operationとして維持する |
| `affect-reset` | `/v1/character_affect/reset` | operator/診断専用として除外 | CLI operator credential | session/relationship resetを通常会話toolへ出さない |
| `character-memory-search` | `/v1/character_memory/search` | 公開 | `character_memory.search` | なし |
| `character-memory-append-episode` | `/v1/character_memory/append_episode` | 公開 | `character_memory.append_episode` | なし |
| `character-memory-correct` | `/v1/character_memory/correct` | 公開 | `character_memory.correct` | 明示target、理由、idempotency、read-backを維持する |
| `character-memory-forget` | `/v1/character_memory/forget` | 公開 | `character_memory.forget` | 明示target、理由、idempotency、read-backを維持する |
| `character-metrics` | `/v1/character_context/metrics` | operator/診断専用として除外 | CLI operator credential | 運用metricsを通常会話toolへ出さない |
| `mcp-server` | なし | MCPで代替済み | stdio MCP serverの起動command | toolではなくadapter bootstrapである |
| `schema` | なし | MCPで代替済み | `tools/list` | MCPでは完全なinput/output schemaをprotocolで返す |
| `validate` | なし | MCPで代替済み | tool input schemaとapplication boundary validation | CLI local validation wrapperをtool化しない |

現在のCLIにmigrationまたはrepair commandはない。将来追加する場合も、既存data、schema、storageを変更する操作はoperator/診断専用を既定とし、MCPで明示指示、authority、failure effectを表現できる場合だけ別のcontract変更として公開を判断する。

## CLIでのinspectとrecovery

request bodyはshellのquotingを避けるため`--stdin`または`--file`で渡す。

```powershell
$request = @{
  schemaVersion = "withmate-character-context-v1"
  characterId = "<character-id>"
  sessionId = "<session-id>"
  authority = @{ kind = "operator"; reason = "incident inspection" }
} | ConvertTo-Json -Depth 10

$request | withmate-memory affect-inspect --stdin
```

主なoperator commandは`affect-inspect`、`affect-correct`、`affect-reset`、`character-metrics`、一般Memoryの`audit`である。`withmate-memory schema`はcommand、入力方法、enumの一覧であり、完全なrequest schemaは返さない。MCP toolの完全なinput/output shapeは`tools/list`で確認する。CLIとapplication boundaryのcanonical validationは一般Memoryが`src/memory-v6/memory-validation.ts`、Character系が`src/character-context/character-context-validation.ts`にある。

`character-memory-correct`の自由記述reasonは訂正監査とidempotency判定に使われる。`character-memory-forget`のreasonは`user_request`、`incorrect`、`outdated`、`privacy`、`other`のいずれかを指定する。

MCP障害後に同じ一般MemoryまたはCharacter操作をCLIで明示的にfallbackする場合は`--fallback-from mcp`を付ける。

```powershell
$request | withmate-memory context-get --stdin --fallback-from mcp
```

fallbackも同じruntime APIを使う。MCP serverの未設定、起動不能、transport-level availability failure以外ではfallbackしない。MemoryまたはCharacterのstructured domain error、authority拒否、invalid input、version conflict、idempotency conflict/replay、migration requiredをCLIで迂回してはならない。writeの`effect: unknown`はresponse lossの可能性を表すため、同じrequestとidempotency keyでreconcileする。

## Errorと再試行

- `invalid_input`、`unknown_character`、`unknown_scope`、`authority_denied`: request、保存済みidentity、authorityを直してから再試行する。
- `version_conflict`: `character_context.get`または`affect-inspect`で最新versionを読み、意図を再評価して新しい`expectedVersion`を使う。状態全体を上書きしない。
- `idempotent_replay`: 同一eventの再送として扱う。motifが同じでも別eventなら新しいidempotency keyを使う。
- 一般Memoryの`replayed: true`: 同一requestの再送として扱う。新規append、forget、moveとして数えない。
- `MEMORY_IDEMPOTENCY_CONFLICT`: 同じkeyへ異なるrequest fingerprintを割り当てている。requestを変更する場合は新しいkeyを使う。
- `storage_unavailable`、`migration_required`: write成功として扱わない。runtimeまたはmigrationを復旧後にread-backする。
- `partial_failure`: `effect`とdetailsを確認し、保存済み部分をread-backしてから再試行する。成功へ読み替えない。

read failureの`conversationMayContinue`は、状態なしで応答を続けられるかを示す。write failureは会話を継続できても、保存済みとは扱わない。

## 観測

`withmate-memory character-metrics`は、transportとoperation別の呼び出し、成功、拒否、失敗、idempotent replay、version conflict、合計latency、拒否code、および`mcp->cli` fallback数を返す。lifecycleとモデル主導MCPの比率は、同じoperationの`lifecycle:`と`mcp:`を比較する。

metricsとapp logには会話本文、Memory本文、secretを記録しない。障害調査で本文が必要な場合も、権限のあるinspect/searchを明示的に使う。

## Turn lifecycle

通常のWithMate Sessionは各turnの応答前にapplication serviceから最新context versionを取得し、Character Definitionとは別の最小envelopeをpromptへ注入する。応答後のCharacter自身の感情評価もlifecycleが実行する。MCP toolは追加想起や明示操作の境界であり、毎turn呼ばれる前提にはしない。

post-turn appraisalは永続audit IDをcorrelationとし、Sessionをcompletedとして保存する前にpendingへ記録する。pendingにはassistant message indexも保存し、次回起動時は保存済みSessionの同じindexと本文が一致するrecordだけをcommit済みとして再評価する。Session保存前に停止したrecordはappraiseせず破棄する。cancelとprovider成功が競合してcompleted responseを保存する場合もenqueueは省略しない。appraiseのread-back後だけsettledにし、一時保存した会話本文を除去する。pendingはcursorで全件走査し、先頭batchの失敗で後続をstarvationさせない。version conflict時も古い候補をblind retryせず、最新contextで一度だけ再評価する。

retryable failureは項目ごとに1分から6時間上限の指数backoffを永続化する。実際の試行が8回失敗した項目とretryableでないfailureはquarantineされ、通常drainから除外される。quarantineは未処理dataの破棄ではなく、会話payloadと保存済みevaluationを保持する隔離である。`character-affect.lifecycle.settlement-deferred`と`character-affect.lifecycle.settlement-quarantined`には本文を出さず、stage、code、error name、所要時間、入力長、試行回数、次回時刻または隔離時刻を記録する。Context内部の予期しないfailureは`character-context.application.unexpected-failure`でAffect状態取得、Memory検索、response組み立てを区別する。

## Turn settlementのquarantine確認と解除

利用者databaseへ操作する前にWithMateを完全に終了し、databaseと同directoryの`-wal`、`-shm`を含めてdirectory単位でbackupする。まずread-only inspectを実行する。出力はcorrelation ID、Session ID、試行回数、failure分類だけで、会話本文は含まない。

```powershell
npm run affect:settlement-recovery -- --db "<absolute-app-database-path>" --inspect
```

原因を修正したversionが適用済みで、再試行してよい対象を確認した後、correlation IDを一件ずつreleaseする。`--confirm-app-stopped`は、停止確認を省略して実行しないための明示guardである。

```powershell
npm run affect:settlement-recovery -- --db "<absolute-app-database-path>" --release "<correlation-id>" --confirm-app-stopped
```

成功時はread-backした`state: ready`、`attemptCount: 0`、`evaluationPersisted`を確認する。その後WithMateを起動し、`settlement-deferred`、`settlement-quarantined`、settled件数を確認する。複数件を一括releaseせず、同じfailure分類の少数から再開してprovider負荷と成功率を確認する。実databaseへのreleaseはincident対応のoperator判断であり、通常のupgrade処理では自動実行しない。
