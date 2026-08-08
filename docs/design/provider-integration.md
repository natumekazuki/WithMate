# Provider Integration

- 作成日: 2026-07-10
- 対象: WithMate 新実装の Provider 接続、会話履歴、実行状態、CLI 境界
- 状態: 設計の基準

## 目的

WithMate の中核機能を画面に依存させず、CLI と将来の GUI が同じ Application Service を利用できる構造にする。

Codex と GitHub Copilot は SDK をアプリケーションへ直接組み込まず、それぞれの CLI を別 process として起動し、公開された JSON-RPC 系 protocol で接続する。Provider 固有の会話・実行・event は Adapter 内で WithMate 共通 contract へ変換する。

## 対象範囲

新実装で対応する Provider は次の 2 つに限定する。

| Provider       | 接続先                  | Transport                         | Protocol                    |
| -------------- | ----------------------- | --------------------------------- | --------------------------- |
| Codex          | `codex app-server`      | runtime hostが所有するstdio JSONL | Codex App Server protocol   |
| GitHub Copilot | `copilot --acp --stdio` | stdio の NDJSON を第一候補とする  | Agent Client Protocol (ACP) |

Cursor その他の Provider は今回の再実装対象に含めない。

## 設計判断

### 1. アプリケーション機能の正式な窓口を先に設計する

- WithMate の use case は画面に依存しない Application Service として提供する。
- CLI と GUI は Application Service の client として扱う。
- CLI に business logic、DB 直接操作、Provider process の状態遷移を埋め込まない。
- GUI の本格実装は後段とし、主要 use case を CLI から実行・観測できることを先に目標とする。
- GUI 固有の layout や一時的な表示状態は CLI 対応の対象外としてよい。

```text
Long-lived WithMate Runtime Host
├─ Provider Adapter ── Codex App Server / GitHub Copilot ACP
├─ Application Service
├─ Persistence Worker
└─ Live State
        ↑ local IPC
      CLI / GUI
```

### 2. Provider CLI を別 process に分離する

- Codex と GitHub Copilot の CLI は WithMate と別 process で実行する。
- process 起動、終了監視、標準入出力、標準エラー、timeout、protocol version、CLI version の記録は共通 infrastructure 候補とする。
- wire protocol の message 型と lifecycle は Provider ごとに異なるため、Codex App Server と ACP を 1 つの汎用 protocol 型へ統合しない。
- SDK 内部の非公開または SDK による互換処理を前提とする JSON-RPC へ直接依存しない。

Provider process、Persistence Worker、live Run、assistant draft、pending interactionは、CLIやWindowから独立した長寿命WithMate runtime hostが所有する。runtime hostは1 current OS user / 1 application data rootにつき1つとし、operational CLIとGUIは同じApplication Serviceへclientとして接続する。

- Codexはruntime hostが`codex app-server --stdio` childを直接所有する。Codex managed daemon、WebSocket、experimental APIを初期構成の必須依存にしない。
- Codex executableは`WITHMATE_CODEX_EXECUTABLE`で指定したabsolute native executableだけを使う。PATH検索、npm shim、shell commandへfallbackせず、設定不備はProvider runtimeを必要としたRunのpre-dispatch failureとして扱う。選択理由はADR 013を正本とする。
- CLIはWindows named pipeまたはUnix domain socketのOS-local IPCを使い、version handshake後にboundedなrequest / responseを交換する。TCP listenerやProvider protocolをpublic CLIへ公開しない。
- CLI connection終了はRun cancel、runtime host shutdown、Provider disconnectへ変換しない。cancelは明示operationだけが行う。
- runtime host不在時はsingle-owner起動を調停し、readyとprotocol versionを確認する。one-shot Persistence WorkerやProvider直接接続へfallbackしない。
- owner、起動、IPC、recoveryの判断理由は`docs/adr/013-runtime-host-and-run-mutation-control-plane.md`を正本とする。

### 3. GitHub Copilot は ACP で接続する

- GitHub Copilot は Copilot SDK を使用せず、GitHub Copilot CLI の ACP server に接続する。
- ACP は外部 client、専用 frontend、multi-agent system から利用する公開 protocol として扱う。
- ACP は 2026-07-10 時点で public preview のため、protocol 変更を前提に version negotiation、capability detection、CLI 対応 version、契約 test を設計する。
- ACP に必要な機能が存在しない場合、SDK 内部 protocol への切り替えを暗黙に行わない。欠落機能、代替手段、初期 scope への影響を再評価する。

### 4. 会話履歴は WithMate が保持する

WithMate は複数 Provider の会話を同じ CLI / GUI から参照できる必要があるため、表示・管理用の共通会話履歴を WithMate 側で保持する。

- WithMate の Session / Message を共通会話履歴の正本とする。
- Provider 側の Thread / Session は、その Provider で会話を継続するための外部状態として扱う。
- WithMate Session と ProviderBinding は Provider 種別と外部会話 ID の対応を保持する。protocol version、CLI version、capability は Binding へ混在させず、Provider process / 接続環境の診断として扱う。
- DB schema、event ledger、RunOutput payloadのSQLite BLOB構造はpersistence designで定める。
- 旧実装の「WithMate が共通会話履歴を保持する」という思想は踏襲するが、旧 DB schema と storage 実装は引き継がない。

```text
WithMate Session
├─ WithMate common message history
├─ Character snapshot
└─ Provider binding
   ├─ Codex Thread ID
   └─ Copilot ACP Session ID
```

### 5. Session と Run を分離する

- Session は会話全体を表す。
- Run は 1 件の initiating user message を起点とする Provider 実行を表す。実行中の追加指示は同じ Run の supplemental input として関連付けられる。
- Message は WithMate の共通会話履歴へ表示する単位を表す。
- 実行中状態は Session の永続的な性質ではなく、Session に属する active Run の状態として扱う。
- Session / Run / Message / RunEvent の責務と不変条件は `docs/design/session-run-message-contract.md` を正本とする。Codex App Server 固有の Thread / Turn / item / server request 変換は `docs/design/codex-app-server-adapter-contract.md` に従う。

```text
Session
├─ Run 1: completed
├─ Run 2: completed
└─ Run 3: running
```

### 6. Provider 共通の Run phase / live activity は WithMate が管理する

Providerは実際の処理状態とProvider固有eventを所有する。WithMateはそれらを永続化する共通Run phaseと、runtime hostでメモリ管理するlive activity / live interaction、terminal outcomeへ変換し、CLI / GUIへ提供する。

- phase は `queued`、`starting`、`active`、`canceling`、`finalizing` と terminal phase を表す。
- live activity はactive Runの`running`、`waiting_approval`、`waiting_input`を表し、DBへ保存しない。
- approval / user input / MCP elicitationのrequest本体はlive activityへ埋め込まず、WithMate発行のopaque IDごとのlive interactionとしてruntime hostのメモリで管理する。Provider request IDはAdapter内部相関に限定する。Provider設定とinteractionのversion境界、dynamic response validation、上限超過時のfail-closed projectionはADR 015、Codex初期interactionの機械可読なpublic shapeは`schema/providers/codex/interaction-v1.schema.json`を正本とする。

状態遷移、terminal outcome、retry / recovery の契約は `docs/design/session-run-message-contract.md` で定める。Provider の terminal event、WithMate process の crash、persistence failure を同一の失敗として扱わない。

runtime hostは、Provider mutation responseとAdapter eventをRunAttemptごとの直列処理へ合流させる。accepted Dispatchを永続化した後だけoutput、live activity、terminal eventを同じThread / TurnのRunへ適用する。mutation responseより先に、Adapterが同じpending mutationへ一意に相関したTurn開始またはterminal eventを観測した場合、その証拠をaccepted responseとしてEvent Serviceへ渡せる。responseまで受理有無が不明で、この証拠もない場合は自動再送せず、response後に届いた同一Thread / Turnのeventで新しい外部executionを一意に証明できた場合だけacceptedへ知識補正する。Dispatch resolutionの永続化結果が不明な間に届いた同じThread / Turnのeventはbounded bufferへ保持し、frozen resolution commandのexact confirmation後に同じAttempt queueで再生する。

RunOutputへ変換するeventはThreadとTurnの完全一致を要求する。Turnを持たないProvider metadataやdiagnosticはgeneration-scopedの診断に留め、現在のactive Turnで相関を補完しない。Dispatch begin、Provider送信前のrejected resolution、output、Dispatch resolution、terminal commandの永続化結果が不明な場合は、identityとcommandを固定したpersistence-only ownerを保持する。runtime hostは同じcommandのexact retryを自動継続し、generation解放、後続Provider eventの無視、または同じpublic requestの再実行へ依存しない。Provider mutationは再送しない。Provider送信前のbeginでresponseを失った場合も、同じcommandの再実行またはread-backで`dispatching`を確認したownerは未送信としてpre-dispatch terminalへ収束させ、Providerへ送らない。

accepted Dispatch resolutionはProvider executionを受理した証拠なので、永続化結果が不明な間もownerをgeneration解放で捨てない。terminal commandは、先行する未確認RunOutputを同じidentityとcommandで確定してから送る。これらのlive ownerはruntime全体で同じ128 Runの上限へ数え、Dispatch beginの未確認ownerだけで上限を迂回しない。上限到達時も既存owner自身のexact retryは新しい枠として数えず、別Runのhandoffだけを拒否する。

Provider connectionのcloseは、Adapter、transport、process ownership、native handleの各層でin-flight dedupeと完了結果を分ける。失敗したPromiseや`closed`状態を成功結果としてcacheせず、同じownerを保持して後続closeで再駆動する。processまたはnative handleのpartial acquisitionもstructured cleanup ownerとしてtransportへ渡し、startup failure後のcloseで同じownerを回収する。startup後にschema不一致などでAdapterを公開できない場合も、factoryがtransport cleanupを所有し、cleanup成功前のsuccessor spawnを拒否する。shutdownでcloseが未解決ならruntime hostのsingle-owner claimを解放しない。

runtime factoryは、設定不備とcapability不一致を決定的なstartup failure、processまたはtransportの開始失敗をinterruptionとして型付きで返す。Codex executableはcurrent OSの形式を検証し、WindowsではPE、LinuxではELF、macOSではthin / fat Mach-Oだけを設定値として受理する。wrong-OSまたは破損したartifactをprocess起動失敗へ持ち越さない。Applicationはstartup failureの種別をADR 005のpre-dispatch outcomeへ変換する。

Adapterのcloseは新しいProvider eventの受信を止めるが、close開始前に正規化済みのevent queueを破棄しない。runtime hostはAdapterから取得したeventをEvent Serviceの受理完了までexact ownerとして保持し、受理失敗時は同じeventから再開する。Event ServiceもoperationのrejectだけではAttemptとfrozen commandを破棄しない。runtime hostはclose後も残queueをEvent Serviceへ受け渡し、drain完了後にだけgenerationを解放する。これにより、Provider terminal eventとfinal Messageの確定をprocess interruptionへ置き換えない。

Adapterがredaction判定を完了していない本文は保存せず、RunOutputの`omitted_redaction`へ写像する。Provider terminal outcomeとassistant contentの検証失敗は別に扱い、content failureはbounded diagnostic outputとして記録しても、Providerが報告したcompleted / failed / interruptedを別outcomeへ置き換えない。

## Provider 共通境界

Provider Adapter が WithMate へ公開する最小操作候補:

- 新しい外部会話を開始する
- 既存の外部会話を再開する
- message を送信して Run を開始する
- 実行中の Run へ追加指示を送る
- Run を cancel する
- pending interactionのbounded snapshotを取得する
- kind-discriminated responseでpending interactionへ回答する
- Provider capability、model、protocol version を取得する
- 外部会話を終了または解放する

Provider Adapter が WithMate へ公開する最小 event 候補:

- Run 開始
- assistant message の途中出力
- tool / command 実行の開始、更新、終了
- Provider固有kindを保ったpending interaction request
- Run の正常完了、失敗、cancel、中断
- Provider process または transport の異常
- 未対応の Provider event

未対応 event は無視して消失させず、secret を除去した診断情報として記録できるようにする。

## CLI 境界

CLIのversion付きJSON envelope、exit code、projectionはADR 006 / 011を維持する。Run mutationのpublic operation名は次で固定し、Provider method名を公開しない。

- `withmate run start`
- `withmate run retry`
- `withmate run send-input`
- `withmate run cancel`
- `withmate run interactions`
- `withmate run respond-interaction`

operational CLIはruntime hostへlocal IPCで接続する。help、version、argv parseだけはhostを起動しない。connection closeやSIGINTはclient lifecycleだけを中断し、`run cancel`へ暗黙変換しない。

Session作成は`withmate session create --provider <providerId>`でProviderを固定する。definition versionはSessionへ固定せず、各Runが完全な`providerId + definitionVersion + settings` envelopeをsnapshotする。Run start / retryの`--provider-settings-json <json>`は同じSession Providerに属する登録済みdefinitionだけを受理し、partial mergeやRun単位のProvider切替は行わない。retryでoverrideを省略した場合はsource Runのversioned envelopeを継承し、後続versionへ暗黙upgradeしない。詳細はADR 015を正本とする。

共通CLI contractとして次を維持する。

- machine-readable な結果は stdout へ JSON で出力する。
- human-readable な diagnostic は stderr へ出力する。
- 成否と主要な失敗種別を exit code で判別できるようにする。
- destructive operation は明示確認または confirmation token を要求する。
- retry されうる write operation は idempotency key を受け取れるようにする。
- 長時間実行は開始、状態取得、event 追跡、結果取得、cancel を分離できるようにする。

## 検証方針

- 設計で確定できない Provider 挙動だけを小規模検証の対象とする。
- 検証コードは product implementation ではなく、破棄可能または隔離された investigation asset として扱う。
- 検証には手順、期待結果、実行環境、結果記録、設計への影響を必ず揃える。
- GitHub Copilot を契約していない現在の開発環境では ACP の runtime 検証を実行しない。
- Copilot ACP 検証は契約済みの別環境で実施し、`docs/investigations/github-copilot-acp/validation-results.md` に記録する。
- raw protocol log を保存する場合は token、account 情報、private repository 情報、絶対 path、prompt 内の secret を除去する。

## Codex App Server 調査で確定した前提

- stdio 上の newline-delimited JSON で初期化、model 取得、Thread 作成、Turn 実行、assistant streaming、正常完了を確認した。
- WithMate Session / Run / event は Codex Thread ID / Turn ID / item ID と対応付ける。
- Run の terminal 判定には `turn/completed` の status を使う。`thread/status/changed(idle)` だけでは正常完了と判定しない。
- Codex Turn status は `inProgress`、`completed`、`failed`、`interrupted` を持つ。
- Provider 側の永続 Thread item は完全な event ledger ではないため、WithMate の共通会話履歴と Run event を正本にする。
- ephemeral Thread は `thread/read(includeTurns=true)` を利用できない。transport の smoke test と、永続履歴・resume の検証を分ける。
- completed persistent ThreadはApp Server process再起動後に履歴をread / resumeできる。
- stdio App Server processをactive Turn中に終了すると、再起動後は同じTurnが`interrupted`となる。切断前の未確定assistant deltaはProvider履歴から復元できない。streaming deltaを永続化しない方針に従い、crash時の未確定draft消失を許容し、復旧時に推測でpartial outputを生成しない。
- model catalog は `model/list`、Provider featureは`modelProvider/capabilities/read`から取得できる。version / account による差分を前提に、起動時または明示refreshでvisible / hidden両catalogとcapabilityを取得する。
- `codex-cli 0.144.6`では、`turn/interrupt`の空response後にThread idleと`turn/completed(interrupted)`が届く。user cancelはterminal eventとの相関後に確定する。
- `turn/steer`はactive Turn ID不一致とactive Turn不在を拒否し、一致時は同じTurnへsupplemental user Messageを反映する。
- `gpt-5.6-luna` / `high`の3 Turnでexplicit agentMessage phaseの`commentary`と`final_answer`を実測した。stable schemaが許可する`null`はphase unknownとしてfallbackし、受信時点でfinalと断定しない。
- `codex-cli 0.145.0`でもWindowsのmanaged daemon lifecycleはUnix限定として拒否された。CLI helpにはexperimental WebSocket endpointが存在するが、初期CP3はWithMate runtime hostがstdio App Server childを所有し、CLI client-only切断をWithMate local IPC境界へ置く。
- `codex-cli 0.145.0`ではcommand / file approvalのaccept / decline、turn scopeのpermission approval、`request_user_input`を実測した。MCPはdirect callとephemeral Thread上のLuna Turnで完全round tripを実測した。model Turnでは同じ`mcpServer/elicitation/request`で届くMCP tool approvalとserver formをmetadataの`codex_approval_kind`で分離し、tool approvalの`serverRequest/resolved`より後に届くformだけを次段として扱う。stable protocolの`_meta`に加え、live probeで観測した`meta` aliasを同じschema-evidenced inputとして受理する。各requestの解決、fixture response、MCP item terminal、Turn terminalを確認し、`serverRequest/resolved`だけをinteraction round trip完了とみなさない。

詳細は `docs/investigations/codex-app-server/capability-matrix.md` と `docs/investigations/codex-app-server/validation-results.md` を参照する。

## 未決事項

- Provider を変更する linked Session へ、どの context を引き継ぐか。
- 将来 1 つの Session に複数 active Run を許可する場合、branch / merge contract をどう定義するか。
- Provider 側 conversation history と WithMate message の欠落・重複をどう照合するか。
- Provider間でapproval / sandboxの意味を共通enumへ揃えない。各Provider definitionが設定UI、validation、interaction kindを所有し、共通層はADR 015のversioned envelopeとgeneric interaction操作だけを維持する。
- ACP で Session list、resume、steering、cancel、並行実行をどこまで利用できるか。
- Copilot ACP で Provider model catalog を取得できない場合の fallback。

## 参照

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [GitHub Copilot CLI ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- [GitHub Copilot SDK and CLI compatibility](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility)
- `docs/feature-inventory.md`
- `docs/issue-triage.md`
- `docs/design/session-run-message-contract.md`
- `docs/design/codex-app-server-adapter-contract.md`
- `docs/adr/013-runtime-host-and-run-mutation-control-plane.md`
- `docs/investigations/codex-app-server/capability-matrix.md`
- `docs/investigations/codex-app-server/validation-plan.md`
- `docs/investigations/codex-app-server/validation-results.md`
