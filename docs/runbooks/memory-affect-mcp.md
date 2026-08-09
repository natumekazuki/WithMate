# Memory / Character Affect MCP運用

## 前提

Memory CLIとMCP serverは、起動中のWithMateが公開するloopback runtime APIへ接続する。どちらもSQLiteを直接開かず、WithMateが停止中の場合は別状態へ書き込まずに失敗する。

設計判断は`docs/adr/020-memory-affect-mcp-application-boundary.md`、tool schemaとvalidationの正本は`src/character-context/`を参照する。

## MCP serverの起動

開発環境では次を実行する。

```powershell
npm run build:memory-cli
node resources/skills/withmate-memory/bin/withmate-memory.mjs mcp-server
```

配布版では同梱された`withmate-memory`へ`mcp-server`を渡す。MCP clientには、このstdio commandをserver commandとして登録する。

同梱artifactはSDKを内包し、配布先の`node_modules`を参照しない。sourceまたは依存を変更した場合は`npm run build:memory-cli`で再生成し、分離した一時directoryから`schema`とMCP initializeが成功するcontract testを通してから配布する。

公開toolは次の6個である。

- `character_context.get`
- `character_affect.appraise`
- `character_memory.search`
- `character_memory.append_episode`
- `character_memory.correct`
- `character_memory.forget`

`get`と`search`はread-onlyである。`appraise`と`append_episode`は通常会話authorityのbounded write、`correct`と`forget`は明示的なユーザー指示またはoperator authorityを必要とする。MCP tool inputはauthority文字列を受け付けず、destructive tool invocationをadapterが明示指示境界へ写像する。CLIはdiscovery fileのCLI専用operator credential、MCPはMCP専用credentialで認証する。通常runtime secretとcaller指定のtransport headerだけではoperatorへ昇格できない。最終判定はWithMate application serviceが行う。

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

主な運用commandは`context-get`、`affect-inspect`、`affect-correct`、`affect-reset`、`character-memory-search`、`character-memory-correct`、`character-memory-forget`である。完全なrequest shapeは`withmate-memory schema`とruntime validation errorを参照する。

`character-memory-correct`の自由記述reasonは訂正監査とidempotency判定に使われる。`character-memory-forget`のreasonは`user_request`、`incorrect`、`outdated`、`privacy`、`other`のいずれかを指定する。

MCP障害後に同じ操作をCLIで明示的にfallbackする場合は`--fallback-from mcp`を付ける。

```powershell
$request | withmate-memory context-get --stdin --fallback-from mcp
```

fallbackも同じruntime APIを使う。Character commandの`storage_unavailable`、または従来Memory commandの`WITHMATE_NOT_RUNNING`を受けた場合は、別DBや一時ファイルへ書かず、WithMate runtimeとmigration状態を復旧してから同じidempotency keyで再試行する。writeの`effect: unknown`はresponse lossの可能性を表すため、再送前にread-backする。

## Errorと再試行

- `invalid_input`、`unknown_character`、`unknown_scope`、`authority_denied`: request、保存済みidentity、authorityを直してから再試行する。
- `version_conflict`: `character_context.get`または`affect-inspect`で最新versionを読み、意図を再評価して新しい`expectedVersion`を使う。状態全体を上書きしない。
- `idempotent_replay`: 同一eventの再送として扱う。motifが同じでも別eventなら新しいidempotency keyを使う。
- `storage_unavailable`、`migration_required`: write成功として扱わない。runtimeまたはmigrationを復旧後にread-backする。
- `partial_failure`: `effect`とdetailsを確認し、保存済み部分をread-backしてから再試行する。成功へ読み替えない。

read failureの`conversationMayContinue`は、状態なしで応答を続けられるかを示す。write failureは会話を継続できても、保存済みとは扱わない。

## 観測

`withmate-memory character-metrics`は、transportとoperation別の呼び出し、成功、拒否、失敗、idempotent replay、version conflict、合計latency、拒否code、および`mcp->cli` fallback数を返す。lifecycleとモデル主導MCPの比率は、同じoperationの`lifecycle:`と`mcp:`を比較する。

metricsとapp logには会話本文、Memory本文、secretを記録しない。障害調査で本文が必要な場合も、権限のあるinspect/searchを明示的に使う。

## Turn lifecycle

通常のWithMate Sessionは各turnの応答前にapplication serviceから最新context versionを取得し、Character Definitionとは別の最小envelopeをpromptへ注入する。応答後のCharacter自身の感情評価もlifecycleが実行する。MCP toolは追加想起や明示操作の境界であり、毎turn呼ばれる前提にはしない。

post-turn appraisalは永続audit IDをcorrelationとし、Sessionをcompletedとして保存する前にpendingへ記録する。pendingにはassistant message indexも保存し、次回起動時は保存済みSessionの同じindexと本文が一致するrecordだけをcommit済みとして再評価する。Session保存前に停止したrecordはappraiseせず破棄する。cancelとprovider成功が競合してcompleted responseを保存する場合もenqueueは省略しない。appraiseのread-back後だけsettledにし、一時保存した会話本文を除去する。pendingはcursorで全件走査し、先頭batchの失敗で後続をstarvationさせない。version conflict時も古い候補をblind retryせず、最新contextで一度だけ再評価する。recovery失敗時は本文をlogへ出さずpendingを保持する。
