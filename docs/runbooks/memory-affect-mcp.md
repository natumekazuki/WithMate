# Memory / Character Affect MCP運用

## 前提

Memory CLIとMCP serverは、起動中のWithMateが公開するloopback runtime APIへ接続する。どちらもSQLiteを直接開かず、WithMateが停止中の場合は別状態へ書き込まずに失敗する。

設計判断は`docs/adr/020-memory-affect-mcp-application-boundary.md`を参照する。一般Memoryのcontractとvalidationは`src-shared/memory/`、Character系contractは`src-shared/character-context/`と`src-shared/character-affect/`を正本とする。

## Managed MCPと手動stdio起動

WithMateのprovider Sessionは、Mainの共有localhost HTTP MCPへ自動接続する。Memory／Characterは`/mcp/memory`、Glossaryは同じlistenerの`/mcp/glossary`を使い、当turnの短命tokenを一時設定へ渡す。URLやtokenを手動でproviderの永続設定へ保存しない。既存の標準managed名だけをturn設定で置換し、第三者MCPは維持する。CodexのHTTP登録名は`withmate-memory-http`／`withmate-glossary-http`である。

手動stdio clientの開発・診断では次を実行する。

```powershell
npm run build:memory-cli
node resources/cli/withmate-memory.mjs mcp-server
```

手動stdio clientの配布版では同梱された`withmate-memory`へ`mcp-server`を渡す。MCP clientには、このstdio commandをserver commandとして登録する。これはWithMateが自動注入するprovider SessionのHTTP経路とは別である。

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

## 会話・作業でのMemory利用

Agentへの利用契機と操作契約はMCP initialize instructionsと各toolのdescription/schemaで配布する。利用先のAgent guideは承認・保存範囲などの共通方針を担い、MCPの利用例がその権限を上書きするものではない。WithMateは個人環境のguideを配布物へ取り込まない。

Memoryは重要な決定や長期的な選好だけでなく、小さな好み、雑談の話題、実際に共有したやり取りも短く残せる。明示的な「覚えて」、大きな成果、強い感情、将来の有用性の確信をすべての保存の前提にはしない。毎turnの検索・保存ノルマや全会話の無条件保存は行わない。

| 内容 | 保存先・利用判断 |
| --- | --- |
| 「今日はコーヒーを選んだ」などの小さな事実・好み | 許可されたtargetの一般Memoryへ短い`note`や`preference`。一度の選択を恒久的な好みへ一般化しない |
| Characterと共有した雑談・小さな出来事 | 単独の`character_memory.append_episode`。同じ出来事を一般Memoryにも重複保存しない |
| Character自身の具体的なAffect eventと一体の出来事 | `character_affect.appraise.memoryEpisode`だけへ送り、単独episodeとして再送しない |
| 話題の開始・切替・再開で過去の文脈が役立ちそう | 対象を絞って検索し、必要な本文を読んで今回利用するか判断する |
| 同じ記憶がすでに現在のcontextにある | 不要な再取得をせず利用する |
| 推測、機密情報、private path、raw log | 事実として保存しない。repositoryの契約・実装状態の正本もMemoryへ移さない |

現在のユーザー発言とCharacter Definitionは過去のMemoryより優先する。一般Memory追加前は同じ正確なtargetを検索し、activeな意味的重複を作らず、矛盾する置換には訂正権限を確認する。episodeは同じmotifの別eventと同一eventの再送を区別する。

### 検索語が分かる時・浮かばない時

話題が分かる場合は`memory.search({targets:[target], query:"コーヒー", limit:5})`等で検索する。Character episodeには明示scope付きの`character_memory.search`を使う。既存のMemoryの内容や検索語が分からない場合は、次の既存toolを組み合わせる。

1. 必要な許可targetが分からなければ`memory.list_targets`をfilterと小さなlimitで確認する。
2. `memory.list_entries({target, states:["active"], limit:5})`で少量の要約を確認する。タグなしの記録も含まれる。
3. 分類が手掛かりになる場合は`memory.list_tags({targets:[target], limit:5})`を使い、関連tagで検索・一覧を絞る。タグなしの記録はtag一覧には出ない。
4. 回答や判断に関係する項目だけ`memory.get_entry({target, entryId})`で本文を読む。検索・一覧のpreviewだけで詳細を断定しない。

検索0件は、許可target内にMemoryが一切ないことの証明ではない。全件取得や同じ記憶の反復取得へ広げず、今回の話題に必要な範囲で読む。自動想起・自動prompt注入は追加しない。

### 軽い記録の入力

`memory.append`では`target`、`kind`、`title`、`body`、`preview`、`idempotencyKey`を明示する。`tags`は省略でき、省略時は`[]`と同じ値へ正規化する。必要な分類がある場合は明示tagを付ける。タグの自動生成は行わない。

title/previewは検索・一覧で本文取得前にも表示されるため、表示してよい短い値をAgentが指定する。短い本文をそのままpreviewにする場合も表示範囲を確認し、previewの280 UTF-16 code units上限を守る。本文の自動切り出しでは要点・分類語が失われ、本文限定の内容を検索結果へ出す可能性があるため、自動補完はしない。

タグなしでも本文検索、通常一覧、ID指定の本文取得は使えるが、tag一覧やtag filterの対象にはならない。既存の全項目明示入力、target authority、入力検証、idempotency、訂正・忘却の境界は維持する。応答喪失時は入力とkeyを変えず再照合する。

## CLI commandとMCP公開範囲

「公開」は同名のruntime routeを一般またはCharacter MCP toolから呼び出せることを表す。「MCPで代替済み」は専用toolを増やさず、MCP protocolまたは別の公開toolで同じ利用目的を満たすことを表す。

| CLI command | Runtime route | 判定 | MCP toolまたは代替経路 | 除外理由 |
| --- | --- | --- | --- | --- |
| `help` | なし | MCPで代替済み | server instructions、`tools/list` | CLIの表示用helpをpublic APIにしない |
| `status` | `/v1/status` | MCPで代替済み | MCP initializeと各toolのstructured availability error | runtime identity確認用routeをtool化しない |
| `characters` | `/v1/characters` | MCPで代替済み | `memory.list_targets`で`filter: { kind: "character" }`と`includeEmpty: true`を指定 | Character definitionを広げずtarget inventoryだけを使う |
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

主なoperator commandは`affect-inspect`、`affect-correct`、`affect-reset`、`character-metrics`、一般Memoryの`audit`である。`withmate-memory schema`はcommand、入力方法、enumの一覧であり、完全なrequest schemaは返さない。MCP toolの完全なinput/output shapeは`tools/list`で確認する。CLIとapplication boundaryのcanonical validationは一般Memoryが`src-shared/memory/memory-validation.ts`、Character系が`src-shared/character-context/character-context-validation.ts`にある。

`character-memory-correct`の自由記述reasonは訂正監査とidempotency判定に使われる。`character-memory-forget`のreasonは`user_request`、`incorrect`、`outdated`、`privacy`、`other`のいずれかを指定する。

MCPのinitializeと`tools/list`取得後にtransport availability failureが発生し、tool errorの`details.fallbackEligible`が`true`になった同じ一般MemoryまたはCharacter操作をCLIで明示的にfallbackする場合は`--fallback-from mcp`を付ける。fallbackはruntime bindingが選んだruntimeとMCP credentialを使い、operator-only command、接続先selector、caller指定identityは受け付けない。provider binding markerがあるprocessのflagなしCLIはoperator modeへ切り替えず拒否される。

```powershell
$request | withmate-memory context-get --stdin --fallback-from mcp
```

fallbackも同じruntime APIを使う。MCP server（共有HTTP hostまたは手動stdio）は`tools/list` responseの正常送出を確認して短命な`listed`登録を確定し、後続toolの内側runtime exchangeの実transport exceptionでmethod、path、bodyのfingerprintを持つ`eligible` stateへ遷移させる。CLIは同じruntime generation、binding、current turn、operation fingerprintに一致するadmissionだけをconsumeする。MCP initialize前の未設定・起動不能、`tools/list`失敗、process terminationなどserverへ障害を報告できない場合は開始しない。provider → HTTP MCPの切断やresponse lossだけではeligibleにならない。MemoryまたはCharacterのstructured domain error、authority拒否、invalid input、version conflict、idempotency conflict/replay、migration requiredをCLIで迂回してはならない。変更request、期限切れ、stale turnも拒否される。idempotency keyを持つwriteの`effect: unknown`はresponse lossの可能性を表すため、同じrequestとidempotency keyでreconcileする。`memory.get_file`と`memory.export_files`はagent fallbackで自動再試行せず、出力先をread-onlyで確認するかoperatorによるmanual recoveryへ進む。

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

`withmate-memory character-metrics`は、transportとoperation別の呼び出し、成功、拒否、失敗、idempotent replay、version conflict、合計latency、拒否code、および`mcp->cli` fallback数を返す。context取得とモデル主導MCPは、同じoperationの`lifecycle:`と`mcp:`で区別する。

metricsとapp logには会話本文、Memory本文、secretを記録しない。障害調査で本文が必要な場合も、権限のあるinspect/searchを明示的に使う。

## Turn lifecycle

通常のWithMate Sessionは各turnの応答前にapplication serviceから最新context versionを取得し、Character Definitionとは別の最小envelopeをpromptへ注入する。保存済みAffectとMemoryの取得、取得時のafterglow projectionは追加LLMを使わない。Agentが記録する意味のある感情変化を認識した場合は、通常turn中にruntime binding付きの`character_affect.appraise`で保存する。感情が後で解消、反転、減衰しても先行eventは残す。具体的なeventがないturnでMCP appraisalを儀式的に呼ぶ必要はない。

同じturnの後続appraisalには直前の成功応答で返されたversionを渡す。別時点または別の根拠を持つeventはfamily、target、label、意味が似ていても新しいkeyを使う。同一requestのtimeout、response loss、client resendだけはrequestを変えず同じkeyで照合する。`effect: unknown`は同じrequestとkeyでreconcileし、未commitの`effect: none` version conflictは最新contextから再評価する。requestを変更した場合は新しいkeyを使う。linked Memory episodeは同じappraisalの`memoryEpisode`だけで保存し、別routeへ重複送信しない。

MCPを呼ばないturnも正常に完了でき、terminal保存はAffectの追加評価やenqueueに依存しない。呼出し省略・失敗・取消を別LLM評価、補完turn、変化なしeventで埋めない。turn中に保存が確定したevent／episodeは、その後の応答失敗・取消で巻き戻さない。Memory／Affectの利用説明は共通MCP instructionsとschemaを正本とし、provider別指示や専用Memory Skillへ複製しない。

旧Affect専用queueを含むV6 DBは、起動時のschema更新で`character_affect_turn_settlements`を削除する。pending、候補、retry、実行中、quarantineを再開せず、queue内の本文・候補を除去する。削除は再実行可能で、評価成功とは扱わない。保存済みevent／episode／一般Memoryとversion・idempotency情報は保持し、一部保存済みや保存結果不明の候補も再適用しない。queueの整理に旧lifecycleや回収処理を使わない。
