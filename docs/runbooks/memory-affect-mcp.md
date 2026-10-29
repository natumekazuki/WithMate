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

CLIとMCPは27の公開操作を同じtool registry、input schema、runtime clientで提供する。操作一覧は[対応表](#cli-commandとmcp公開範囲)を参照する。CLIのJSON bodyはMCP tool inputと同じであり、top-levelの`schemaVersion`、user / Character / Session identity、authorityをcallerから渡さない。Affect candidate等のnested schemaは各toolの定義に従う。runtimeが必要な内部値を補完し、application serviceが最終検証する。

`memory.append`、`memory.forget`、`memory.move_entry`はidempotency keyを必須とし、`memory.forget`と`memory.move_entry`はreasonも必須とする。`memory.forget`の`dryRun: true`はMemory、protected object、監査event、idempotency stateを変更しない。`memory.move_entry`はdry-runを受け付けない。成功responseの`replayed: true`は同一requestの再送を表す。keyを異なるrequestへ再利用した結果はdomain conflictであり、availability failureではない。

`memory.get_file`と`memory.export_files`は、target照合後に新しい出力fileだけを作成する。既存fileを上書きしないためdestructive annotationは付けないが、external side effectを持ち、同じrequestの再実行は既存file errorになり得るためread-onlyまたはidempotentとは表示しない。

Characterのget/search/inspectと一般Memoryの検索・取得・一覧・診断はread-onlyである。Characterのappraise/append_episodeと一般Memoryのappendはbounded writeである。明示target、具体的な理由、idempotency key、変更後のread-backを満たす場合、Character Memoryのcorrect/forgetと一般Memoryのforget/move_entryをユーザーの代理として実行できる。一般Memoryのbulk forgetは実行前にdry-runする。Affectのcorrect/resetは `explicitUserRequest: true` と具体的な `reason` を必要とし、expectedVersionによる競合検証を維持する。

### 認証とSession binding

両入口とも既存のローカルruntime credential、loopback制限、runtime owner / generationの検証を維持する。Session bindingの要否はtransport名ではなく対象情報で決まる。

- Character context、Affect、Character所有Memory、`characters`は有効なbindingが必須。対象は現在のCharacter / Sessionと許可Projectから解決し、caller identityを受け付けない。Character共有のMemoryやrelationship層を作成Sessionだけに狭めない。
- 一般Memoryのuser-global / Projectは明示targetがあればbindingなしで利用できる。`{kind:"user-global"}` または `{kind:"project",project:{type:"id",id:"..."}}` / 絶対pathのproject refを使う。
- 複数targetにCharacter対象が含まれる場合、要求全体でbindingを必要とする。無bindingの `audit allTargets` とfilter省略の `list_targets` は暗黙のCharacter横断要求として拒否し、一部targetだけを黙って除外して成功にしない。無bindingの一覧にはuser-global / Project filterを明示する。
- status / instances / metrics / 容量等の診断集計はbindingなしで利用できる。bindingを提示した場合は、その許可範囲と失効を検証する。無効bindingを無視してunboundへ降格しない。
- bound mutationはcurrent turn capabilityを検証する。readはcapability省略を許すが、提示されたcapabilityがstaleなら拒否する。取消・失効後の未確定副作用も同じapplication境界で停止する。

Session Graphもbinding必須であり、Memoryとは別の公開操作を持つ。詳細は[Session Graph](../design/session-graph.md)を参照する。

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

27操作はCLI/MCPで同じ意味のinput、JSON result、domain error、対象解決、保存効果を持つ。CLIのhyphen名はMCPのunderscore名へ対応する。`schema` / `validate` はローカルな説明・形式検証であり、runtime認可や保存を実行しない。helpとmcp-serverは表示・bootstrap用commandで、domain操作ではない。

| CLI command | MCP tool | 入力・対象 / 返却 |
| --- | --- | --- |
| `status` | `memory.status` | runtime identity。CLI `--all` / MCP `all:true` はinstancesと同じ一覧 |
| `instances` | `memory.instances` | safe runtime inventoryと選択結果。bindingありでは選択ownerへ限定 |
| `characters` | `memory.characters` | binding必須、現在Characterのid/name/descriptionのみ |
| `file-usage` | `memory.file_usage` | 全体容量集計。`largest:true,limit` で許可範囲のentry詳細 |
| `list-targets` | `memory.list_targets` | `filter,includeEmpty,limit,cursor`。無bindingはuser-global/Project filter必須 |
| `list-entries` | `memory.list_entries` | `target,states,kinds,tags,includeBody,limit,cursor` |
| `audit` | `memory.audit` | 明示 `targets` または `allTargets:true`、staleBefore/limit/cursor。allTargetsはbinding必須 |
| `search` | `memory.search` | 明示 `targets,query` と任意filter / pagination |
| `get-entry` | `memory.get_entry` | `target,entryId` |
| `get-file` | `memory.get_file` | `target,objectId,outputPath`。絶対path・非上書き |
| `export-files` | `memory.export_files` | `target,entryId,outputDirectoryPath`。絶対path・非上書き |
| `list-tags` | `memory.list_tags` | target 1件、withCounts/sampleLimit/limit/cursor |
| `append` | `memory.append` | 明示target、本文・preview・kind・title、idempotencyKey |
| `forget` | `memory.forget` | target/entryIds/reason/idempotencyKey。dryRunで非変更preview |
| `move-entry` | `memory.move_entry` | entryId/from/to/reason/idempotencyKey。entry identityを保持 |
| `context-get` | `character_context.get` | binding必須。任意query、memoryLimit既定3 |
| `affect-appraise` | `character_affect.appraise` | binding必須。candidates、任意expectedVersion |
| `affect-inspect` | `character_affect.inspect` | binding必須。現在Character / Sessionのevent・reset・version |
| `affect-correct` | `character_affect.correct` | binding必須。eventId/expectedVersion/explicitUserRequest/reason/replacement |
| `affect-reset` | `character_affect.reset` | binding必須。layer/expectedVersion/explicitUserRequest/reason/resetAt/idempotencyKey |
| `character-memory-search` | `character_memory.search` | binding必須。query、明示scope、limit既定5 |
| `character-memory-append-episode` | `character_memory.append_episode` | binding必須。episode/idempotencyKey |
| `character-memory-correct` | `character_memory.correct` | binding必須。entryId/reason/idempotencyKey/replacement、read-back |
| `character-memory-forget` | `character_memory.forget` | binding必須。entryId/reason/idempotencyKey、read-back |
| `character-metrics` | `character_context.metrics` | 本文を含まないruntime/DB全体の診断counter |
| `schema` | `memory.schema` | 共通registryの全tool input schema |
| `validate` | `memory.validate` | command/inputの形式検証。CLIは `--command` とJSON入力 |

完全な入力schemaは `schema` / `memory.schema` またはMCP `tools/list` で確認する。CLIの `--json`、`--file`、`@file`、`--stdin` は同じpublic inputの入力方法である。project等のshorthandも同じpublic bodyへ正規化する。複雑なwriteには `--stdin` / `--file` を使う。

診断の容量集計とmetricsは全体値であり、Session別の値と解釈しない。largest entry詳細は、bindingなしでは一般user-global / Projectだけ、bindingありでは現在Character・許可Project・共有user-globalへ限定する。object store path、key、hashを返さない。scope filterはpagination前に適用する。

## CLIでのinspectと再照合

Session bindingを受け継いだprocessでは、通常CLIをMCP障害の有無にかかわらず利用できる。Character inspectのpublic inputは空objectでよい。

```powershell
'{}' | withmate-memory affect-inspect --stdin
```

`affect-correct` / `affect-reset` は明示指示の `explicitUserRequest:true`、具体的なreason、最新expectedVersionを渡す。authorityやCharacter/Session IDは渡さない。`character-memory-correct`のreasonは自由記述、`character-memory-forget`は `user_request`、`incorrect`、`outdated`、`privacy`、`other` のいずれかである。

`--fallback-from mcp` は通常CLIの開始条件ではなく、MCPの実transport障害後に同じ要求を明示的に再照合する限定経路である。MCP initializeと `tools/list` の正常送出後、serverが `details.fallbackEligible:true` を返した場合だけ使用する。同じruntime generation、binding、current turn、method/path/bodyへ発行された短命admissionをconsumeし、接続selectorやcaller identityを受け付けない。structured domain error、authority拒否、version/idempotency conflict、migration/storage errorは開始理由にならない。変更request、期限切れ、stale turnも拒否する。

writeの `effect:unknown` は保存結果不明を表す。idempotent writeは入力とkeyを変えず再照合する。`memory.get_file` / `memory.export_files` は非idempotentな出力操作であり、このfallbackでは自動再試行せず、出力先をread-onlyで確認して明示的な復旧判断を行う。

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
