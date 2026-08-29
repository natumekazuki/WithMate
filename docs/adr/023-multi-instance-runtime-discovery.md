# ADR 023: 複数WithMate instanceのruntime discoveryをregistryで管理する

## Status

Accepted

## Context

Memory CLI/MCPが単一のcurrent pointerだけを解決すると、後から起動したinstanceや終了済みruntimeがpointerを書き換え、稼働中instanceへ接続できなくなる。終了時にpointerを以前の値へ戻すだけでは、crash、同時publish、stale owner、別instanceへの誤接続を閉じられない。

MemoryとSessionは異なるadapter runtimeを持つが、OSユーザー単位のinstance識別、公開状態、lease、stale判定、選択結果の安全な投影は共有できる。一方、credential schema、generation、binding owner、公開errorのprefixはadapter固有であり、同一generationを要求してはならない。

## Decision

### Identity and registry ownership

- WithMate main processは起動ごとに`applicationInstanceId`（UUID）を一度だけ生成し、userDataへ永続化しない。Memory runtimeは起動ごとに`runtimeGenerationId`（UUID）を生成し、再起動時に必ず変更する。Session runtimeは同じapplication instance IDを使用できるが、独自のgenerationを持つ。MemoryとSessionのgeneration一致は契約にしない。
- `multi-instance-runtime-discovery`のsemantic ownerを共有runtime registry coreとする。Windowsの既定rootは`%LOCALAPPDATA%\WithMate\runtime-discovery\v1`で、テストは注入した一時directoryを使う。entryのfile nameにはraw instance IDを使わず、entryはapplication instance、adapter/runtime kind、adapter generation、build channel、process diagnostics、lease、generation fileへの安全な参照だけを保持する。secret、credential内容、binding reference、Memory本文、個人pathは保持しない。
- registryは複数のactive entryを正本とし、legacy current pointerは6.3.25の互換projectionに限定する。registryとpointerが同じruntimeを指す場合は一候補へ重複排除し、別runtimeが同時に有効なら暗黙選択せずambiguousとする。

### Publish, lease, cleanup

- 公開順序はlistener開始、adapter credentialのexclusive create、ACL/permission検証とread-back、entry temporary fileのatomic rename、lease heartbeat開始、legacy pointerのbest-effort更新とする。credential準備またはACL検証に失敗した場合はentryを公開しない。
- heartbeatは既定5秒、stale thresholdは20秒、capacity cleanup graceは60秒、retentionは24時間、entry上限は64件とする。lease期限切れだけではstaleにせず、operation前のidentity challengeも省略しない。lease期限切れかつchallenge失敗のentryだけをstaleとする。PID存在だけでactiveへ戻さない。
- publish前にstale entryと参照されないgenerationをboundedに回収する。freshまたはchallenge成功したentryはcapacity pressureでも削除しない。上限を下げられない場合はcredential公開前にregistry capacity errorで失敗する。
- cleanupは自分のidentity tuple（application instance、runtime generation、adapter kind）とgenerationだけを対象とする。正常終了はunpublish、listener停止、自generation削除の順序で行い、ownerでないruntimeのcleanupはactive集合を変更しない。commit後に結果が不明な場合は同じtupleをread-backして公開状態を判定する。

### Selection and binding

- shared resolverはadapter固有errorを生成せず、unavailable、instance mismatch、generation changed、ambiguous、stale、capacityの内部outcomeを返す。Memoryの公開codeはそれぞれ`WITHMATE_RUNTIME_UNAVAILABLE`、`WITHMATE_RUNTIME_INSTANCE_MISMATCH`、`WITHMATE_RUNTIME_GENERATION_CHANGED`、`WITHMATE_RUNTIME_AMBIGUOUS`、`WITHMATE_RUNTIME_STALE`、`WITHMATE_RUNTIME_REGISTRY_CAPACITY`とし、`WITHMATE_NOT_RUNNING`は互換期間だけのlegacy aliasとする。
- binding-requiredなMemory MCPとGlossary経路は、provider executionごとのclient-scoped environmentからapplication instance IDとMemory runtime generation IDを受け取る。完全一致するentryだけをchallengeし、欠落、mismatch、generation変更、stale、unavailableでは別instanceへのfallback、別generationへのrebind、operator/local-userへのdowngradeを行わずdispatchを0回にする。challenge一致前にcredentialやoperation bodyを送らない。
- provider clientのcache identityにはMemory generationを含め、`process.env`は変更しない。Codex/GitHub Copilotのbackgroundまたはunbound clientからselectorを大小文字を区別せず除去する。静的global MCP registrationへ特定instance selectorを固定しない。
- operator CLIとunbound MCPはactive candidateが0件ならunavailable、1件ならそのcandidate、2件以上ならambiguousとする。`--instance <applicationInstanceId>`と任意のgeneration指定は完全一致だけを許可し、起動順、更新日時、publish順、build channelを優先順位に使わない。`instances`と`status --all`はsafe metadataだけを返す。

### Diagnostics and security

- status、diagnostics、一覧、error detailsはapplication instance、build channel（installed/development/visual-check/unknown）、runtime generation、lease/stale判定、error codeだけを投影し、secret、credential path、userData path、binding reference、Memory本文を含めない。
- build channelはmain processが明示的に決定し、path名やlast writerから推測しない。identity challengeはselectorとruntimeが一致するまでoperationを実行しない。stale artifact回収はboundedで、稼働中runtimeまたは別instanceのartifactを削除しない。

## Consequences

- instanceの起動、正常終了、crash、後発runtimeのcleanupが別instanceのCLI/MCP接続を無効化しない。operatorが候補を暗黙に選べない場合は、利用者が識別可能なambiguous errorで明示選択できる。
- MemoryとSessionはregistryのidentity/lease/selection境界を共有できるが、credentialとgenerationはadapter単位で独立する。6.4.0ではSession runtimeへこのregistry core、owner cleanup、bound exact selection、safe diagnosticsを論理移植し、Session固有generationを追加する。MemoryのgenerationをSessionへ同期・共有するmigrationは行わない。
- 6.3.25ではlegacy pointerを残すため旧CLIとの互換性を保てる。ただし新resolverのcanonical sourceはregistryであり、legacy pointerの削除releaseは別判断とする。

## Alternatives

### 終了時に単一pointerを以前の値へ戻す

crash時に復元できず、同時publishのlast-writer競合、stale owner、別instanceへの誤接続を解消できないため採用しない。

### instanceごとにdiscovery namespaceを分ける

bound経路の固定には有効だが、operatorの候補一覧、stale回収、legacy互換、Memory/Session共通のactive集合を別実装にしやすく、共有registry coreより責務が分散するため単独案としては採用しない。

### registryとactive leaseをadapterごとに別実装する

credentialやgenerationの独立性は保てるが、owner限定cleanup、capacity、safe diagnosticsの不変条件がadapter間でずれるため採用しない。registry coreを共有し、adapter schemaだけを分離する。

## References

- `docs/adr/021-agent-runtime-binding-authority-boundary.md`
- `docs/adr/022-repository-glossary-boundary.md`
