# ADR 015: Provider所有の実行設定とlive interaction契約

- Status: Accepted
- Date: 2026-07-31
- Refines: ADR 013のSession Provider、Run execution snapshot、pending interaction ownership

## Context

Runのmodel、reasoning、approval、sandboxはProviderの実行protocolとcapabilityに依存する。共通enumへ揃えると、Codex、GitHub Copilot、将来のCursorで意味が異なる設定を同じものとして扱うか、共通層がProvider固有の分岐を抱えることになる。一方、未検証のJSONをそのまま保存・送信すると、Run admission、retry、GUI、CLI、Provider requestで別々の解釈が生まれる。

Sessionは作成時にProviderを選び、途中で変更しない既存契約を持つ。pending approval、user input、MCP elicitationはruntime hostのmemory-only stateであり、Provider request IDやraw payloadをpublic identityまたは永続化の正本にできない。回答はProviderへの外部副作用を伴うため、clientやProvider transportのlifecycleから独立したdurable admissionとexact retryも必要になる。

## Decision

Providerの選択はSessionが所有する。Providerを変更する場合は新しいSessionを作成し、既存Session、Run、retry chainのProviderを置換しない。

Run execution settingsは、`providerId`、`definitionVersion`、exact validation済み`settings` objectからなる完全なversioned envelopeとして扱う。`providerId + definitionVersion`をProvider registryの唯一のlookup keyとし、同じProvider definitionがsettings schema、GUI definition、canonicalizer、dispatch compiler、interaction schemaを一体で所有する。共通Application層はenvelopeのlookup keyとSession Providerの一致を検証するが、Provider固有fieldの意味、default、組合せ、wire変換を解釈しない。各Provider definitionが次を所有する。

- settings schemaのexact validationとcanonicalization
- GUIが設定項目を構成するためのdeclarative definition
- Provider requestへ変換するdispatch compiler
- interactionの表示用projectionと回答payloadのexact validation

`definitionVersion`はWithMateが公開するsettings、interaction snapshot、responseの意味とshapeを識別するsemantic versionであり、Provider CLIのrelease versionではない。初期Codex definitionは`codex-provider-v1`とし、Codex CLIの更新だけではversionを増やさない。`initialize`で観測したCLI identityは接続診断へ記録するが、allowlist、SemVer range、definition lookupの入力にはしない。実際のstable protocol payloadをDecoderへ通し、必須fieldの欠落、既知fieldの不正値、既知variantの競合、resource limit違反をoperation errorまたはconnection failureへ収束させる。外部stable protocolのobjectは、既知fieldをcanonical projectionしたうえで未知の加算fieldを無視する。WithMateが所有するpublic settings、snapshot、responseは引き続きunknown fieldを拒否するclosed contractとする。

初期implementation scopeではCodex definitionだけを登録する。GitHub CopilotとCursorは、それぞれのdefinitionとruntime evidenceを追加するまで利用可能として公開しない。Provider definitionはversion、feature、initialize capability、runtime evidenceから利用可能な設定とinteractionを決定し、protocol上にfieldやserver requestが存在するだけで利用可能と判定しない。GUIはregistryから得た同じ`providerId + definitionVersion`のdeclarative definitionだけを描画し、canonicalizerとdispatch compilerを別versionへ差し替えない。workspace path、additional directory、CharacterはApplication scopeに残し、Provider settingsからowner scopeを拡張できないようにする。

Run startは完全なProvider settings envelopeをsnapshotする。retryでoverrideを省略した場合はsource Runに記録された`providerId + definitionVersion + settings`をそのまま継承し、指定する場合は同じProviderの完全なversioned envelopeで置換する。共通層でProvider固有objectのpartial mergeを行わない。startと明示overrideは`modelSelection=explicit`、overrideを省略したretryは`modelSelection=inherited`として、同じmodel値でも選択由来をProvider Adapterまで保持する。過去Runのsettingsを現行definitionへ暗黙upgradeしない。

Session Providerと異なるenvelope、registryに存在しない`definitionVersion`、invalid settingsはProvider runtimeを起動する前に拒否する。新規admissionでは、canonical commandに対するread-only exact replay probeを先に行い、durable replayが存在しない場合だけProvider runtimeのcurrent catalogでmodel、reasoning、input modalityをpreflightする。unsupportedまたはcatalog取得不能なら二度目のread-only replay probeで競合commitを回収し、それでも未admitの場合だけdurable Run、Thread、Turnを作らず失敗する。exact replayは過去に受理済みのcommandの再観測であり、現在のcatalog driftやruntime停止に依存させないためlive preflightを省略する。mutation時にも同じcapability検証を残し、preflight後のcatalog変化を安全側に拒否する。

Sessionが固定するのは`providerId`であり、`definitionVersion`ではない。各Runがexactなdefinition versionとsettingsをsnapshotする。同じSessionの後続Runは、registryに登録済みで同じProviderに属する別versionを完全なenvelopeとして明示できるが、既存Run、retry source、pending interactionを別versionへ書き換えない。retryのoverride省略はsource Runのversionを維持し、GUIが新しいdefinitionを既定表示しても過去Runへ暗黙適用しない。

Operational CLIはRunのProviderを選択しない。Session作成は`withmate session create --provider <providerId>`でProviderを固定する。Run start / retryは`--provider-settings-json <json>`で完全な`providerId + definitionVersion + settings` envelopeを受け取り、partial settings、別Provider、version省略を受理しない。GUIも新規SessionでProviderを選び、Runごとに選択した`providerId + definitionVersion`の設定formを同じdefinitionから描画する。既存SessionではProviderをread-only表示し、Provider切替は新規Session作成として扱う。

live interactionのpublic操作は、read-onlyな`run interactions`とwriteの`run respond-interaction`に分ける。Applicationでは`interactions()`と`respondInteraction()`、runtime IPCでは`run.interactions`と`run.respond_interaction`へ対応させる。public interaction IDはWithMateが発行するopaque IDとし、Provider request、Thread、Turn、item、approval、connection generationの各IDを流用または公開しない。

Codex App Serverのserver request IDは、connection generation内部のtype-sensitiveなidentityとして扱う。同じconnectionで同一type/valueのIDは一度だけ受理し、response送信または`serverRequest/resolved`受信後も、connection終了まで再利用を許可しない。遅延したduplicate resolutionを別interactionへ誤って相関させないため、安全なtombstone evictionは行わない。保持件数とIDのUTF-8 byte総量をprospectiveに制限し、上限へ達した場合はconnectionをfail-closeして新しいgenerationへ再接続する。raw IDとgenerationはpublic snapshot、永続化、diagnosticへ出さない。

pending interactionはcurrent Run / Attempt / Binding / external execution / connection generationへ相関したruntime hostのmemory-only stateとする。public snapshotは`interactionId`、`kind`、回答可否、boundedかつredactedな表示内容、snapshot時の`providerId + definitionVersion + kind`が許可する回答shapeだけを返す。runtime hostまたはProvider processの再起動後にDB履歴だけから回答可能状態を復元しない。

`respond-interaction`のJSONは、Provider definitionが公開するclosedなkind-discriminated unionとする。各variantは`interactionId`、snapshotと一致するliteral `kind`、そのkind固有の回答payloadだけを持つ。たとえばCodex definitionはcommand approval、file change approval、permission approval、user input、MCP tool approval、MCP server elicitationを別variantとして定義し、decision、permission profile、question answers、elicitation actionを相互流用しない。同じProvider methodで届いてもpayload discriminatorと回答shapeが異なるrequestは同じkindへ統合しない。Codex初期definitionのliteral kind、public snapshot / response shape、unknown-field拒否、静的な個数・文字列上限は`schema/providers/codex/interaction-v1.schema.json`を機械可読な正本とする。file changeの表示pathはslash区切りのworkspace相対pathへ安全に正規化でき、Unicode controlとbidi controlを含まない場合だけ回答可能とし、Provider item IDはopaque interaction IDへの内部相関に閉じる。

runtime validatorはstatic schemaに加え、current snapshotの`interactionId + providerId + definitionVersion + kind`、`answerable`、許可decisionをdurable admission前に照合する。command approvalではProvider requestの`availableDecisions`をsnapshotへそのまま投影し、未指定または`null`の場合だけversion定義の全decisionを補う。明示された部分集合に含まれないdecisionは、schema上の一般形として有効でもcurrent requestへの回答として拒否する。user inputではquestion IDと各question内のoption labelが重複しないsnapshotだけを回答可能とし、Providerの`isOther`を各questionの必須boolean `allowOther`へ投影する。responseは全question IDを過不足なく1回ずつ持ち、各回答を1件に限定する。回答はcurrent option label、または`allowOther=true`のquestionだけが許可する2,048 code point以下の自由入力とする。`isSecret=true`はsecure入力経路を実装して実測するまでunavailableとする。MCP formではfield IDが重複しないsnapshotだけを回答可能とし、accept時のkeyをcurrent field集合の部分集合、required fieldを全件必須、各valueをsnapshot固有の`maxLength`以内とする。required fieldがなければ空の`values`も受理する。Provider request ID、raw schema、transport responseはpublic JSONへ含めない。

command、path、change集合、permission、question、option、form schemaなど、回答判断へ必要なProvider contentをpublic上限内へ完全かつ安全に投影できない場合は、切り詰めた表示を`answerable=true`で公開しない。command内のworkspace absolute pathは完全に識別できる場合だけ`<workspace>`起点へ置換し、外部absolute path、UNC、device path、file URI、home-relative path、parent traversal、または曖昧なpath表現が残るrequestはunavailableとする。初期Codex definitionはProvider側の安全判断を推測しない。bounded snapshotを返せる場合でも、必要情報の一部を省略した表示から回答を許可してはならない。

Codex `0.145.0`ではMCP tool approvalとMCP server elicitationがともに`mcpServer/elicitation/request`で届く。stable protocolのmetadata fieldは`_meta`であり、live probeでは同じmetadataが`meta`として届く経路も観測したため、Codex definitionは両方を同じ意味のschema-evidenced input aliasとして受理する。`codex_approval_kind=mcp_tool_call`をtool approvalのdiscriminatorとし、空schemaへplain accept / decline / cancelを返すvariantと、同fieldがなく`mode=form`であるrequestへProvider serverが提示したbounded formのcontentを返すvariantを分離する。MCP formはtool approvalの`serverRequest/resolved`より後に届いたrequestだけを次段として受け入れ、先行formはdeclineしてTurnをinterruptする。MCP formのpublic responseはacceptの`{action: "accept", values}`と、値を持たない`{action: "decline" | "cancel"}`を別shapeにする。Adapterは前者だけを`{action: "accept", content: values}`、後者を`{action, content: null}`へ変換する。未知の`codex_approval_kind`、discriminatorなしの非form mode、未検証のform field種別はinteractionとして公開しない。metadataの`persist`はProviderが利用可能な永続choiceを広告するfieldであり、userが選択していないsession / always grantを共通層またはAdapterが補わない。request単位の`serverRequest/resolved`、MCP item terminal、Turn terminalは別々の事実として追跡する。

回答mutationはcaller-generated idempotency keyを要求する。Providerへ回答する前にSession / Run scopeとsemantic responseのdurable admissionを確定する。same-key exact retryはProvider responseを再送せず、same-key conflict、別keyによる二重回答、stale owner、terminalまたは解決済みinteractionを外部副作用前に拒否する。response write、`serverRequest/resolved`、Turn lifecycleを別の事実として扱い、effect certaintyを後退させない。解決済み事実だけをboundedなRunEvent、必要なsummaryだけをRunOutputItemへ保存し、pending requestやraw responseを保存しない。

response admission、Run cancel admission、対象requestの`serverRequest/resolved`、相関したTurn terminalは、runtime hostの同じper-Run mutation ownerへ投入して一つの順序に直列化する。ownerはresponse admission時にcurrent pending handleを検証し、`admitted`のdurable commit後、同じowner占有中にexact responseを一度だけ送る準備と`write_attempted`へのdurable遷移を確定してからtransport writeへ解放する。この区間に別処理がpending handleを解決済みにする隙間を作らない。既にownerへ受理されたresolved / terminalが先ならresponseをProvider write前に拒否し、response admissionが先ならqueued resolved / terminalはwrite attempt後に適用する。cancel admissionが先なら同様にresponseを拒否し、response admissionが先なら回答を送信してから後続cancelを処理する。response outcomeは少なくとも`admitted`、`write_attempted`、`resolved`、`ambiguous`のeffect certaintyを区別する。同じidempotency keyのretryは保存済みcertaintyを返し、どのcertaintyからもProvider writeを再送しない。write開始後のconnection lossは`ambiguous`とし、後続cancelはTurnをinterruptできても「回答の効果を防止した」と報告しない。このraceとconnection lossはApplication contract testの必須gateとする。

## Alternatives

- 全Providerへ共通のapproval / sandbox enumを定義する: Providerごとの意味と将来の選択肢を欠落させ、共通層に変換規則が分散するため採用しない。
- Provider settingsを未検証のopaque JSONとして扱う: invalid tupleをdurable admission前に拒否できず、GUI、CLI、retry、runtimeで解釈が分岐するため採用しない。
- Codex CLI releaseの完全一致またはSemVer rangeでruntime admissionを制御する: 実際に互換な加算変更まで停止し、version文字列とprotocol capabilityを混同するため採用しない。互換性はpayload Decoderとoperation contractで判定する。
- Provider protocolとWithMate public contractの両方で未知fieldを許可する: 外部protocolの加算互換性には有効だが、durable settingsと回答payloadの意味を曖昧にするため、外部stable protocol境界だけに限定する。
- Providerごとにpublic Application / CLI operationを作る: GUIとCLIがProvider protocolへ依存し、同じlive ownerとidempotency契約を再利用できないため採用しない。
- Run startまたはretryでProviderを変更する: Session履歴、Binding、owner tuple、capacity、recoveryの意味が途中で変わるため採用しない。
- pending interactionをSQLiteへ保存する: live request handleとcurrent generationを復元できず、古いProvider requestへの再送を安全に防げないため採用しない。

## Consequences

- Provider追加時はsettingsとinteractionのdefinition、runtime evidence、Adapterを追加し、共通Application contractは維持できる。
- Provider settingsのschema変更にはversion追加と明示的なdecoderが必要になる。
- retryはProviderとsettingsの履歴を保つが、別Providerで同じ会話を継続する操作にはならない。
- current pre-release schema v1で古いexecution snapshotを持つ開発DBは互換対象外であり、migrationやfallbackを追加せず明示的な再作成が必要になる場合がある。applicationは既存DBを自動削除しない。
- UIはProviderごとのformを描画できるが、Provider definitionに存在しない共通設定を先取りしない。
- interaction responseのclient timeout、SIGINT、IPC disconnectはruntime hostのownerまたはProvider connectionを終了させない。
- 長時間接続ではserver request IDの保持上限により再接続が必要になる場合がある。これは誤ったinteractionへ回答を相関させるより安全側のtrade-offである。

## Related decisions and evidence

- `docs/adr/013-runtime-host-and-run-mutation-control-plane.md`
- `docs/design/provider-integration.md`
- `docs/design/session-run-message-contract.md`
- `docs/design/multi-agent-persistence.md`
- `docs/design/codex-app-server-adapter-contract.md`
- `schema/providers/codex/interaction-v1.schema.json`
- `docs/investigations/codex-app-server/capability-matrix.md`
- `docs/investigations/codex-app-server/validation-results.md`
