# ADR 013: Runtime hostとRun mutation control plane

- Status: Accepted
- Date: 2026-07-20
- Amends: ADR 002、ADR 006、ADR 011、ADR 012のApplication / CLI process ownership

## Context

CP2のCLIはoperationごとにApplication ServiceとPersistence Workerを起動し、response出力後にshutdownする。このlifecycleでは、CLI process終了後もCodex Run、Provider接続、assistant draft、pending interactionを継続して所有できない。Run開始、retry、supplemental input、active cancelはdurable mutationとProvider side effectをまたぐため、one-shot CLI自身をownerにすると、response lossとprocess終了をRun cancelやProvider切断から区別できない。

`codex-cli 0.144.6`の公式資料、stable生成schema、隔離runtime probeでは、App Serverの標準transportはstdio JSONLであり、WebSocket transportはexperimental / unsupportedである。`turn/steer`と`turn/interrupt`はstable schemaに存在する。current CLI helpにはmanaged daemonとcontrol socketへのstdio proxyが存在するが、公式App Server資料はdaemonのclient lifecycleを定めておらず、Windowsでは`codex app-server daemon` lifecycleを実測できない。

Runtime probeでは、`turn/interrupt`の空response後に`thread/status/changed(idle)`、`turn/completed(interrupted)`が届いた。`turn/steer`は`expectedTurnId`不一致とactive Turn不在を拒否し、一致時は同じTurnへ追加user Messageを反映した。agentMessageは`commentary`と`final_answer`を明示して正常完了した。App Server process crash時にpersistent Turnが`interrupted`へ収束し、欠落eventやdraftを再配信しない既存実測も維持されている。

## Decision

WithMate専用の長寿命local runtime hostを、CLIやWindowから独立したprocessとして1 current OS user / 1 application data rootにつき1つ所有する。runtime hostだけが次を所有する。

- Persistence Workerのlifecycleとrepository access
- Provider Adapter、`codex app-server` child process、Provider connection
- live Run、live activity、assistant draft、pending interaction
- durable admission後のdispatch、supplemental input配送、cancel、terminal確定
- startup reconciliationとProvider照合

Provider mutation前に、Workspace scope / Session / Run / active RunAttempt / ProviderBinding / runtime connection generationを1つのowner tupleとして解決する。各値をruntime connection generationと一律比較せず、次をそれぞれの正本と照合する。

- RunがSessionとWorkspace scopeに属し、active RunAttemptがRunに属する。
- ProviderBindingが同じSessionとProviderに属し、Run execution snapshotのProvider-neutralな`providerId`と一致する。
- start / retryのDispatch、send-inputのMessageとDelivery、cancel request、interaction responseが、対象Run / RunAttempt / Sessionに属する。
- send-inputの`expectedTurnId`、cancel対象、interaction requestの外部Turn IDが、active RunAttemptのexternal execution IDとcurrent connectionのactive Turnに一致する。
- ephemeral Bindingのlive ownership tokenがcurrent connection generationへ登録されている。persistent Bindingはdurableな外部conversation IDだけでlive ownerを代用せず、現在のactive Turnとの相関を別に要求する。

いずれかが不一致、欠落、または複数候補になる場合はProviderへ送信しない。connection generationはlive ownerの識別にだけ使う。

Codexの初期transportは、runtime hostが直接所有する`codex app-server --stdio`のJSONLとする。Codex managed daemon、WebSocket、Unix socket transportを必須にせず、Provider connectionをCLIまたはRendererへ公開しない。

CLIと将来のGUIはruntime hostのclientとする。Operational CLIはOS-localなduplex streamへ接続し、version handshake、request ID、operation、bounded request / responseをnewline-delimited UTF-8 JSONで交換する。Windowsはnamed pipe、Unix系はUnix domain socketを使用し、TCP listenerを開かない。endpointはcurrent OS userとapplication data rootへscopeし、別userから接続できないfilesystem permissionまたはpipe ACLを要求する。wire fieldと上限は実装時のtype、validator、contract testを正本とし、CLIの`withmate-cli-v1`出力へ内部IPC fieldを流用しない。

runtime hostが存在しないとき、operational CLIは同一ownerの起動を調停してhostを開始し、readinessとprotocol versionを確認してからrequestを送る。起動競合では複数hostを許可せず、version不一致やowner確認不能時はoperation前に拒否する。one-shot runtimeへのfallback、同じDBを開く第二Persistence Worker、Providerへの直接接続は行わない。help、version、argv parseは従来どおりhostを起動しない。

CLI connectionのclose、timeout、SIGINT、stdout failureは、Run mutationまたはsubscriptionについてはclient requestの待機終了であり、Run cancel、runtime host shutdown、Provider connection closeへ変換しない。Run cancelは明示的なmutationだけが要求できる。

Runと独立したclient-scoped operationは同じ扱いにしない。output exportのtimeout、SIGINT、connection lossはruntime hostへcancelを伝播し、ADR 012のbounded deadline内にexport helperを停止してpublication outcomeを確定または`unknown`へ収束させる。

GUI / Electron processの終了と再起動もruntime hostを停止せず、再起動後のclientはlive snapshotとRunEvent cursorから再接続する。runtime hostはnon-terminal Runまたはpending interactionが存在する間は自動終了しない。idle時の終了policyは実装詳細にできるが、終了前にlive ownerがないことを確認し、active stateを破棄してはならない。

Provider-neutralなpublic CLI operation名を次で固定する。

| CLI operation | Application上の意味 | Provider Adapter mapping |
| --- | --- | --- |
| `withmate run start` | initiating Messageと新規Runをdurable admissionする | `thread/start`が必要なら先に相関し、`turn/start`へdispatchする |
| `withmate run retry` | `retryOfRunId`を持つ新規Runをdurable admissionする | 同じTurnを再送せず、新しいProvider executionを開始する |
| `withmate run send-input` | active Runへsupplemental Message / deliveryをdurable admissionする | active Turn IDを`expectedTurnId`に指定して`turn/steer`する |
| `withmate run cancel` | active Runを`canceling`へdurable transitionする | 相関するTurnへ`turn/interrupt`する |

各writeはcaller supplied idempotency keyを受ける。start / retryはadmission済みRun、send-inputはdelivery、cancelはcancel requestへ同じkeyとfingerprintで収束する。CLI response loss後のexact retryは同じdomain identityと現在のdelivery / cancel outcomeを返し、新しいProvider requestを作らない。

`turn/interrupt`のresponseだけではRunをterminalにしない。user cancel requestと`turn/completed(interrupted)`を相関できた場合だけ`canceled`とし、相関不能なprocess / transport failureは`interrupted`とする。`turn/steer`の不一致またはactive Turn不在はrejected deliveryとし、後続Runへ暗黙転用しない。

recoveryでは、durable `pending`かつProvider未送信を証明できるdispatch / deliveryだけを自動送信する。`dispatching`または`ambiguous`を`pending`へ戻さず、自動再送しない。runtime host crashまたはApp Server crash後はpersistent Threadを照合し、同じactive Turnと継続可能性を証明できる場合だけ監視を再開する。terminal、未送信、継続可能のいずれも証明できないRunは`interrupted`へ収束させ、Provider履歴から欠落Message、RunEvent、draftを推測生成しない。

public responseとdiagnosticはallowlist projectionとし、Provider固有の外部Thread / Turn / item / request ID、raw payload、private path、secret、IPC endpoint credentialを公開しない。これらの外部IDはruntime hostとPersistence Workerの内部相関にだけ使用する。Provider-neutralな`providerId`はProvider選択とcapacity scopeのpublic fieldであり、この禁止対象ではない。

## Alternatives

- CLI invocationをRun ownerにする: CLI終了、SIGINT、stdout failureでProvider connectionとlive stateを失い、明示cancelと区別できないため採用しない。
- Electron Main processだけをownerにする: GUIを起動していないCLI利用でRunを開始・継続できず、Window lifecycleとruntime lifecycleが再び結合するため採用しない。
- Codex managed daemonまたはcontrol socket proxyへCLIが直接接続する: Windowsでdaemon lifecycleを検証できず、利用可能なplatformでもWithMateのPersistence Worker、Provider-neutral operation、draft、interactionを所有しないため、初期control planeには採用しない。
- App ServerのWebSocketをWithMate IPCとして使う: experimental / unsupportedなProvider transportをpublic control planeへ昇格させ、Codex固有protocolとWithMate Application contractが混ざるため採用しない。
- operational CLIごとに現在のone-shot runtimeをfallbackする: runtime hostと別Persistence Workerが同じapplication dataを所有し、live stateとdispatch順序を分岐させるため採用しない。

## Consequences

- CLI process終了後もRun、Provider接続、draft、interactionをruntime hostが継続でき、GUIも同じApplication contractへ接続できる。
- CP3のproduction実装は、Run mutationより先にruntime host、single-owner起動、local IPC、version handshake、CLI compositionの移行を成立させる必要がある。
- CP2のstatus / events / follow / outputを含むoperational CLIも、runtime host導入時に同じIPCへ移行する。migration完了後にone-shot Persistence Worker経路をfallbackとして残さない。
- output exportのApplication / helper ownershipもruntime hostへ移すが、ADR 012のbounded cancel、no-clobber、publication outcome契約は維持する。
- named pipe / Unix domain socketのlifecycle、local authorization、host upgrade、stale endpoint cleanup、bounded subscriptionは実装時にexecutable contractが必要になる。
- CAS-017のCodex managed daemon client-only再接続はWindowsで`blocked`だが、採用したprocess modelではCLI disconnectがWithMate IPC境界で完結し、App Server connectionはruntime host内に残る。後続実装ではProvider daemon再接続ではなく、runtime hostへclientだけを再接続するprocess testをGateとする。
- 本ADRはprocess / public operation contractを確定する。production sourceは後続PRで実装する。

## Related decisions and evidence

- `docs/adr/003-application-service-operation-envelope.md`
- `docs/adr/005-pre-dispatch-run-terminal-resolution.md`
- `docs/adr/006-cli-session-control-plane.md`
- `docs/adr/011-run-observation-control-plane.md`
- `docs/adr/012-run-output-control-plane.md`
- `docs/design/session-run-message-contract.md`
- `docs/design/multi-agent-persistence.md`
- `docs/investigations/codex-app-server/runtime-contract-probe.mjs`
- `docs/investigations/codex-app-server/validation-results.md`
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
