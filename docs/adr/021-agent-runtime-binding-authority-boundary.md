# ADR 021: Agent runtime bindingはgeneric authority snapshotとして所有する

## Status

Accepted

## Context

WithMateが起動したprovider executionからSession scopedなAgent APIを呼ぶ場合、request body、CLI引数、promptへ記載されたSession IDはactor identityの根拠にならない。callerが転記する値では、誤転記、stale context、別Sessionの指定を区別できない。

一方、現行のSession schemaにはSessionRole、root/parent hierarchy、Role contract revision、Session/Turn operation permissionのaccepted contractがない。runtime bindingの導入と同時にそれらの既定値を決めると、後続のSession orchestration APIより先にauthority contractを固定してしまう。

Codex SDKとGitHub Copilot SDKのstdio runtimeはいずれもclient作成時にchild runtimeへ渡すenvironmentを指定し、adapterはclientとthread/sessionをcacheする。Electron main processのglobal `process.env`をturn前後に書き換える方式では、並行Session間のidentity分離を保証できない。

## Decision

- Electron main processのagent runtime binding registryをopaque referenceの発行、解決、operation grant検証、generation、失効のcanonical ownerとする。active generationのreuseに必要なreferenceはprocess memory内だけに保持し、lookupと永続的なidentityにはhashを使う。provider processへは推測不能なopaque referenceだけを渡す。`expiresAt`は発行前に正規化・検証し、正規化後の期限もreuse identityへ含める。
- binding authorityはgeneric snapshotとする。actor Session ID、provider execution generation、任意のRole/hierarchy snapshot、operation grant、発行・期限・失効情報を保持できるが、registry自身はRoleの意味やdefault permissionを発明しない。
- Session CLI・MCPのapplication operationはbinding-requiredとし、`session.runtime.invoke` grantを共有のallowlistとして使う。bindingはactor Session identityを証明するが、対象Sessionを変更または暗黙選択するauthorityには使わない。現行operationの既存target validationを維持し、Role/hierarchy authorizationは追加しない。Coordination Event endpointは引き続き有効化しない。
- WithMate-owned endpointはroute tableで`required`、`optional`、`none`を必ず宣言する。aliasとruntime exchangeも同じpolicyへ収束させる。
- Session scopeのCharacter context / affectは`required`とし、解決済みactor Sessionをapplication requestへserver側で設定する。callerのSession IDはactorを上書きしない。
- agent-facing Memory CRUDは`optional`とする。bindingがある場合はactor Sessionとproviderをsource/idempotency principalへ使用するが、targetはrequestの明示selectorを維持する。Session bindingはuser-global、明示Project、actor自身のCharacter、actor自身のCharacter+Projectを操作でき、別Characterをownerに持つtargetは拒否する。bindingがない場合は既存の認証済みlocal-user/operator経路を利用できる。
- `memory.file_usage`も`optional`とする。quotaの集計値は従来どおりWithMate全体を示すが、binding principalへ返すlargest entry候補はuser-global、Project、actor自身のCharacterに限定し、別Characterのtitle、preview、entry IDを投影しない。
- runtime bindingで解決されたAgentはユーザーの代理として、許可された明示targetのMemoryを自律的に検索、取得、追加、訂正、forget、moveできる。訂正、forget、moveは具体的な理由とidempotency keyを伴わせ、変更後にread-backする。general Memoryのbulk forgetはdry-runを先行させる。relationship affect correction、session / relationship affect reset、relationship boundary変更は引き続き明示的なユーザー指示またはoperator authorityを必要とする。
- operator診断、Affect訂正・reset、migration系routeは`none`とし、bindingの存在によってauthorityを追加しない。
- provider binding capabilityをprovider runtime capabilityとして明示する。初期実装はclient-scoped environment injectionを確認したCodexとGitHub Copilotを対応providerとし、未確認providerではSession scoped Agent操作をcapability unavailableとして扱う。
- provider clientはbinding generationをcache identityへ含め、Session/provider execution単位で分離する。generationを維持するretryは同じbindingを再利用し、provider executionを再生成する場合は旧bindingを失効させて新しいclientを作る。
- `process.env`は変更しない。defined environment、binding reference、およびprovider executionではbinding省略を許さない非secret markerをprovider client作成時に明示的に渡す。managed MCP/CLI runtime clientはmarkerがあるのにreferenceが欠落した場合、optional Memoryをlocal-userへfallbackせずdispatch前に失敗する。外部terminalにはmarkerを渡さず、別の認証と明示targetによるoptional経路を維持する。
- Copilotのrecoverable connection retryは同じlogical provider execution generation内のtransport再接続として扱う。session bootstrap前に失敗した場合も含めてclient processを停止して作り直すが、同じbinding projectionを再利用する。Session/provider/app invalidationではsession cacheに加えて対応client processを停止する。
- Copilotの通常SessionとAuxiliary Sessionはbindingがない場合、client cacheを参照する前にfail closedとする。actorを持たないbackground structured promptだけがunbound clientを使用する。
- Auxiliary Sessionも独立したactor Sessionとしてbindingを発行する。parent Sessionのbindingを共有せず、Auxiliary終了、parent Session削除、provider execution generationの再生成、app shutdownで対応bindingとprovider clientを失効させる。
- Companion Modeは退役済みとし、新規CompanionSession作成、新規provider turn、Companion ReviewからのAuxiliary Session起動を受け付けない。既存履歴の閲覧、merge、discardは維持する。Companionはruntime bindingのactor scopeへ含めない。
- actor Sessionを持たないbackground structured promptはunbound clientを使う。ambient environmentにbinding referenceが存在しても、Windowsのenvironment key比較を考慮して大小文字を区別せず明示的に除去し、bound client cacheと共有しない。
- provider child runtimeにはopaque referenceをclient-scoped environmentとして渡す。providerが同じenvironmentで起動するchild processからの秘匿は保証せず、同一OS user上の攻撃的なprocessは本境界のthreat model外とする。WithMateはreferenceをprompt、UI、通常log、provider設定へ投影せず、third-party MCPへruntime credentialやWithMate MCP設定を自動付与しない。
- managed WithMate MCP/CLI runtime clientは、同一HTTP接続上のidentity challengeを検証した後、exchange requestのJSON envelopeへenvironmentのreferenceを格納する。challenge前のrequest、通常operation body、MCP transport session IDはactor identityに使用しない。
- managed MCPでbinding-required markerがあるのにreferenceが欠落した場合は、runtime operationをdispatchせず、non-retryableなauthority/usage rejectionを返す。transport availability failureへ変換しない。
- Session削除、provider execution generationの再生成、app shutdownでbindingを失効させる。same generation内ではresponse loss後のidempotent read-backに同じbindingを利用できる。
- opaque reference、runtime secret、binding hash、operation grant detailはprompt、UI、通常log、public errorへ投影しない。provider outputから作るlive state、監査raw item、metadata、artifact、public errorは、boundingや永続化より前に現在のbinding referenceの完全一致を固定markerへ置換する。providerへ送るuser input、logical prompt、transport payload、provider control identifierはこのprojection redactionの対象にしない。

## Consequences

- Character context / affectのcallerはactor Session IDをMCP requestへ含めずに呼び出せる。
- Session CLI・MCPのcallerはactor Session IDとCharacter表示値をrequestへ含めず、bindingとcanonical stateからTurn initiatorを解決する。対象Session IDは兄弟operationの明示入力として維持する。
- Memoryのtarget contractは変わらず、旧current Project / Character targetは復活しない。
- Role/hierarchy contractの導入前にSession mutation authorityを誤って公開しない。
- provider client cacheはSession generation単位のentryを持つため、invalidateとSession deleteで明示的なcleanupが必要になる。CopilotではSDKの`stop()`をboundedに待ち、非空のerror result、reject、またはtimeoutでは`forceStop()`へ移行する。`forceStop()`自身も同じ上限でboundedに待ち、rejectまたはtimeoutでもcleanupをsettleする。app終了はprovider cleanup完了を待ってからpersistent storeを閉じ、終了処理を再開する。provider cleanup、binding revoke、store closeの個別失敗があっても終了状態をsettleし、再quitへ到達する。
- unsupported providerや外部terminalからのrequired操作は構造化されたbinding required/capability unavailable failureになる。
- provider child runtimeまたは同一OS userのprocessが意図的にenvironmentを読み取り、referenceとbinding-required markerを同時に除去してoperator経路を直接選ぶ攻撃は防御対象外である。通常のmanaged MCP/CLI経路ではreferenceの偶発的な欠落をfail closedにする。provider process自体をoperator経路から隔離する要件が生じた場合は、OS user分離またはprovider processへoperator credentialを到達させないbroker方式を別ADRで検討する。
- Copilot SDKのenvironment受け渡し、cache分離、retry、失効はaccount不要のadapter testで検証できる。一方、実Copilot accountを使ったchild shell / managed MCPからWithMate runtimeまでのend-to-end smokeは利用可能な検証環境で別途確認する。
- Companionの旧runtime実装と保存済み会話は履歴互換のため残るが、公開IPCとrendererは新規実行を拒否する。再導入する場合はruntime binding actor scopeとMemory authorityを新しいaccepted contractとして設計し直す。

## Alternatives

### Session IDをpromptへ書き、Agentに引数として渡させる

caller自己申告でありactor identityを保証しないため採用しない。

### Electron main processのprocess.envをturn前後に変更する

並行Sessionへ値が漏れ、例外時cleanupにも依存するため採用しない。

### 旧Memory bindingをそのまま復元する

旧実装はturnごとに発行・失効し、bound clientをcacheしない。provider execution generationとsame-generation retry/read-backの契約に一致せず、implicit Memory targetを復活させる危険もあるため採用しない。

### 現時点でroot RoleとSession permissionを定義する

accepted Role契約と公開consumerが存在せず、後続orchestration設計を先取りするため採用しない。

### GitHub Copilotを未対応providerとして残す

GitHub Copilot SDKのstdio connectionはclientごとの`env`をchild runtimeへ渡せるため、Codexと同じSession/generation分離を実装できる。未対応のままにすると、Session scoped操作を使えないだけでなく、ambient environmentに存在するstale referenceを明示的に除去できないため採用しない。

## References

- GitHub Copilot SDK Node.js README: <https://github.com/github/copilot-sdk/blob/main/nodejs/README.md>
- GitHub Copilot SDK MCP configuration: <https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/mcp>
