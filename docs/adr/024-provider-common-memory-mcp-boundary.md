# ADR 024: Provider共通Memory MCPはactor-relative contractを所有する

## Status

Accepted

## Context

Memoryの通常操作は、providerごとに配布する`withmate-memory` Skillと、同じbundle内のCLI/MCP artifactに依存している。upgrade時にはWithMateがproviderのSkill directoryを検査・更新し、SettingsとdiagnosticsもSkill同期状態を表示する。一方、通常Sessionにはopaqueなruntime bindingがあり、actor Session、Character、local user、許可Projectをserver側で解決できる。agent-facing requestへ`userId`、`characterId`、`sessionId`を持たせ続けると、値をauthorityとして扱わない場合でも、caller-asserted identityとcanonical actorの二つの表現が残る。

CLIはoperator作業とMCP transport障害時のagent fallbackを兼ねる。両者が同じCLI adapter credentialを使うと、bound Agentがfallbackによってoperator routeへ昇格できる。Character contextも現在はactor identityと内部Memory targetを返すが、turn promptが必要とするのはAffect version、effective context、baseline参照、関連Memoryのpreviewであり、生のactor identityではない。

ADR 020の共通application boundary、ADR 021のruntime binding registry、ADR 018のAffect event/episode収束、ADR 023のruntime discoveryを基礎にしながら、agent-facing target、binding policy、CLI credential、fallback開始条件を置換し、MCP `tools/list`をagent-facing Memory contractの正本にする必要がある。

## 既存ADRとの関係

| ADR | ADR 024が置換する条項 | 維持する条項 |
| --- | --- | --- |
| ADR 020 | agent-facing Memoryの明示target、provider executionから使うCLIのoperator credential、MCP未初期化時を含むfallback開始条件 | 共通application boundary、SQLite非直結、effect certainty、idempotency、episode mutation owner、lifecycle/event-time appraisal |
| ADR 021 | Memory CRUDと`memory.file_usage`の`optional` policy、bindingなしのlocal-user/operator経路、explicit Character selector | binding registry、generation、operation grant、turn capability、runtime owner selection |
| ADR 023 | 置換なし | application instanceとadapter generationのexact selection、別instanceへfallbackしないruntime discovery |

競合する範囲ではADR 024を優先する。operator CLIはADR 020/021のexplicit target/identityとoperator credentialを維持する別authority modeであり、provider executionから使うMCPまたはagent-bound CLI fallbackの非binding経路にはしない。

## Decision

### 配布とcanonical artifact

- `withmate-memory`の生成済みCLI/MCP artifactのrepository canonical pathを`resources/cli/withmate-memory.mjs`とする。packaged pathは`<process.resourcesPath>/resources/cli/withmate-memory.mjs`とする。
- `resources/skills/withmate-memory`はSkill catalogとして配布しない。実装移行で同directoryをrepositoryから除去し、build、installer、Windows alias、macOS/Linux shim、isolated artifact smokeは新pathだけを参照する。
- WithMateは起動、upgrade、Settings操作のいずれでも、provider側の既存`withmate-memory` Skill directoryを削除、更新、digest検査、collision検査しない。過去versionがprovider directoryへ置いたcopyは自動migrationまたはcleanupの対象にせず、利用者所有のlegacy artifactとして残す。
- provider別のMemory instruction、Memory Skill同期、system promptへのMemory運用方針追加は行わない。通常操作の説明はMCP initialize instructions、`tools/list`のdescription、input/output schema、annotationへ置き、operator手順だけをrunbookへ置く。

### actor-relative Memory target

agent-facing general Memory toolのtargetは、次のstrictなdiscriminated unionを使う。discriminator名は`kind`とし、列挙値とfieldをMCP `tools/list`のexact schemaへ公開する。

```ts
type ActorRelativeMemoryTarget =
  | { kind: "user-global" }
  | { kind: "project"; project: ProjectTargetRef }
  | { kind: "character" }
  | { kind: "character+project"; project: ProjectTargetRef };
```

- `ProjectTargetRef`は既存どおり`{ type: "id"; id: string } | { type: "path"; path: string }`とし、pathは絶対pathだけを受け付ける。serverは保存済みProjectとbindingに許可されたProject scopeへcanonicalizeする。
- `user-global`のuser、`character`と`character+project`のCharacterはruntime bindingから解決する。agent-facing targetは`userId`、`characterId`、`sessionId`、`owner`、`scope`を受け付けない。unknown fieldはdispatch前に拒否する。
- bindingのMemory authority snapshotは`{ userId: "local-user"; characterId: string; allowedProjectIds: string[] }`を一つのtupleとして保持する。`allowedProjectIds`はbinding発行時にactor Sessionのworkspaceを既存Project resolverでcanonicalizeしたIDをsort/deduplicateした値とし、解決不能なworkspaceはProject authorityを持たない。将来別Projectを許可する場合も発行時にcanonical IDへ解決してtupleを更新し、binding generationを再発行する。request時は現行actor SessionのCharacterとsnapshotを照合し、targetのProjectを同じresolverでcanonicalizeして許可集合と比較する。ambient workspace、process cwd、caller pathをauthorityへ使わない。
- agent-boundのMemory/Character mutationとfile exportは、bindingに加えて現在のlogical turn capabilityを必要とする。`SessionRuntimeService`はprovider turnのbegin/end順序を所有し、genericな`ProviderAgentRuntimeTurnCoordinator`はactor Session/providerごとのactive lease、capability発行、照合、失効のcanonical ownerとなる。Glossary proactive createとMemory/Character副作用は同じcoordinatorの兄弟consumerとし、別のactive mapを作らない。MCPとagent CLI fallbackはprovider environmentのcapabilityをruntime challenge後のexchange envelopeだけへ渡し、serverはapplication dispatchと外部file side effectより前にcurrent leaseへ照合する。前turnのcapability、欠落、空値は`effect: none`で拒否する。capabilityはadmissionだけに使い、idempotency fingerprintやMemory source identityへ含めない。read-only route、operator CLI、lifecycleの同process内部呼び出しには要求しない。
- idempotency keyを持つmutationは、同じlogical turn内のretryでは同じcapabilityを使い、response loss後の後続turnでは変更していないrequest/keyと新しいcurrent capabilityでreconcileする。`memory.get_file`と`memory.export_files`は既存fileを上書きしない非idempotent operationであり、idempotency keyを追加しない。dispatch後のresponse lossは`effect: unknown`として自動再試行せず、意図した出力先のread-only確認またはoperatorのmanual recoveryで結果を確定する。未作成が確認できた場合、または別の新規出力先を明示した場合だけ新しいoperationとして実行する。
- general Memory toolはbindingを必須とする。bindingなしのlocal-user/operator互換をMCPへ残さない。operator CLIは既存のexplicit `MemoryTargetSelector`を維持し、actor-relative schemaと共有しない。
- `memory.list_targets`のfilterも同じ`kind`語彙を使い、生のuser/Character identityを受け付けない。Projectを絞る場合だけ`ProjectTargetRef`を明示する。返却targetもactor-relative shapeとし、resolved user/Character IDを投影しない。
- actor-relative schemaのpublic canonical ownerは`tools/list`を生成する`scripts/withmate-memory-mcp-general.ts`とする。Memory authority snapshotの型は`src/agent-runtime/agent-runtime-binding-contract.ts`、内部の永続化selectorは`src/memory-v6/memory-contract.ts`、actor-relative selectorから内部selectorへの解決とauthorityは`src-electron/memory-v6-http-server.ts`が所有する。public schema、binding authority、内部selectorを同じ型として扱わない。

### Character tool inputとcontext projection

- MCPの全Character tool inputとAffect candidateから`userId`、`characterId`、`sessionId`を除く。Character、Session、local userはruntime bindingから解決し、application requestへserver側で設定する。operator CLIのCharacter commandはexplicit identity inputを維持する。
- `character_memory.search`のscopeはactor Characterまたは明示Projectとの組合せだけを表し、Character identityを含めない。別Characterを指定するagent-facing入口は作らない。
- `CharacterContextResponse`からtop-levelの`characterId`、`sessionId`と`scope`全体を除く。`memory.items`は`id`、`title`、`preview`、`tags`、`updatedAt`だけのpreview projectionとし、Memory owner/scope/body/file/sourceを含めない。
- `schemaVersion`、`baseline.definitionSha256`、`baseline.snapshotAt`、`affect.mode`、全`affect.effective` component、`affect.evaluatedAt`、`affect.version`、`affect.updatedAt`、`memory.items`、`memory.relatedTags`、`memory.updatedAt`は維持する。provider prompt、lifecycle evaluator、MCP output、CLI context readは同じprojectionを使う。
- provider promptとpost-turn lifecycle evaluatorはCharacter Definitionとidentity-free contextだけをproviderへ送る。内部の`CharacterRuntimeSnapshot.characterId`はcontext取得、event保存、read-backのapplication authorityに維持するが、provider inputの`character.id`その他のuser/Character/Session identityへ投影しない。
- Character context public projectionのcanonical ownerは`src/character-context/character-context-contract.ts`とし、MCP output schemaはこのprojectionと完全一致させる。

### operator CLIとagent-bound CLI fallback

- operator CLIはprovider binding markerがないprocessから起動し、CLI operator credentialを使用する。explicit target/identityを入力でき、operator allowlistにあるinspect、audit、correct、reset、maintenance routeを実行できる。provider binding markerがあるprocessからの通常CLI操作は、read/writeを問わずCLIでdispatchする前に拒否する。serverもbinding referenceを伴うoperator CLI requestを拒否し、`--fallback-from mcp`はoperator authorityの根拠にならない。
- agent-bound CLI fallbackは、validなbinding-required marker、runtime owner tuple、opaque binding reference、`--fallback-from mcp`のすべてが揃う場合だけ選択する。callerが渡したidentityを使用せず、MCPと同じactor-relative input、route allowlist、authority、error contractを使う。
- agent-bound fallbackはoperator credentialを読み取らない。runtime discoveryへagent CLI専用projectionを増やさず、MCP credential projectionを読み、exchange上では`agent_cli_fallback` adapterとしてMCP-equivalent allowlistへ認証する。serverはvalid binding、current turn capability、`fallbackFrom: "mcp"`、server-side fallback admissionをすべて要求する。いずれかが欠ける場合はdispatch前に`effect: none`で拒否し、operator modeへdowngradeしない。
- agent-bound CLI fallbackは、同じprovider executionがMCP initializeに成功し、`tools/list` responseを正常に送出した後に発生したtransport-level availability failureだけを開始条件とする。MCP processは通常のMCP operation credentialとは別にruntime registryが当該generationへ発行するfallback admission reporter credentialを読み、`tools/list`成功時にruntime generation、binding、turn capabilityへ結び付く短命な`listed` stateをserverへ登録する。その後の実transport exception時だけ、同じreporter credentialでmethod、path、bodyのfingerprintを持つ`eligible` stateへ遷移させる。通常のMCP credentialだけではcontrol stateを作成または更新できない。state transitionは`listed`から`eligible`、`eligible`から`consumed`への一方向とし、CLI requestは同じbinding、current turn、operation fingerprintに一致するadmissionだけを原子的にconsumeできる。同じfingerprintのresponse loss retryを除いて再利用できず、`consumed`から別fingerprintへ再武装できない。変更request、期限切れ、stale turnはdispatch前に拒否する。
- MCP未設定、process起動不能、initialize失敗、`tools/list`取得またはresponse送出の失敗、reporter credentialを解決できない場合、MCP processからserverへ障害を報告できないprocess terminationでは、fallback admissionを発行せずMemory capability unavailableとして扱う。domain validation、authority、version、idempotency、migration、storageのstructured errorはtransport failureではなく、fallback admissionを発行しない。非idempotentな`memory.get_file`と`memory.export_files`もagent-bound CLI fallbackの対象外とし、client側の判定に加えてserverのfallback route allowlistでも拒否し、出力先確認またはoperator manual recoveryで閉じる。
- common runtime secretは接続先本人確認だけに使う。operation authorityはadapter credential、route allowlist、resolved bindingから導き、requestのtransport名、identity field、`--fallback-from`単独からは導かない。
- 同一OS user上の攻撃的processからprovider environmentやdiscovery credentialを秘匿することはADR 021と同じくthreat model外とする。ただし、正規のbound adapterがoperator credentialを選ぶ経路は設けない。

### tools/list operation contract

MCP `tools/list`はprovider非依存のagent-facing正本として、各toolに次をexactに公開する。

- strict input/output schema、actor-relative target、unknown field拒否、annotation。
- semantic Memory append前に同じexact targetで`memory.search`を行い、activeな同義entryがあればappendせず、訂正authorityなしに競合replacementを作らないduplicate preflight。
- affect eventとCharacter episodeは意味の類似では重複とせず、同一eventのretryだけを同じrequestとidempotency keyへ収束させる。
- Affect eventに属するlinked episodeは`character_affect.appraise.memoryEpisode`だけがmutation ownerであり、`character_memory.append_episode`へ重複送信しない。standalone episodeだけが後者を使う。
- idempotency keyを持つwriteのresponse loss時のunchanged request/key retry、changed requestでのnew key、`replayed`とnew effectの区別。
- 非idempotentな`memory.get_file`と`memory.export_files`ではresponse loss後に自動再試行せず、`effect: unknown`、意図した出力先のread-only確認、operator manual recovery、新規出力先を使う明示的な再実行を区別する。
- `effect: none | committed | partial | unknown`、`saved`/`rejected`/`replayed`、read-backを推測で補完しないeffect certainty。
- authority/version/migration/domain errorはtransport availability failureと区別し、fallback禁止を明示する。pre-dispatch failureは`effect: none`、dispatch後にwrite結果を確認できない場合だけ`effect: unknown`とする。
- agent-bound CLI fallbackのcommand、mode、actor-relative schema、開始条件と、transport error responseの`details.fallbackEligible`を公開する。Agentは同fieldが`true`の場合だけ変更していないoperationをCLIへ渡し、initializeまたは`tools/list`取得前の失敗、structured domain error、非idempotent file exportではfallbackを開始しない。

descriptionで表すoperation sequenceとschemaで表す形を同じ`tools/list` contract testで固定する。WithMate system promptやprovider instruction sampleへ同じ方針を複製しない。

### diagnostics projection

managed Skill停止後の`MemoryV6Diagnostics`は次のtop-level fieldだけを持つ。

```ts
type MemoryV6Diagnostics = {
  generatedAt: string;
  runtime: MemoryV6RuntimeDiagnostics;
  cliShim: MemoryV6CliShimDiagnostics;
  lastErrors: MemoryV6DiagnosticEvent[];
};
```

- `providers`、`skillSync`、managed Skill status、provider instruction sample/copy actionを削除する。
- Settings DiagnosticsはMemory API、CLI Shim、Last Errorだけを表示する。runtime projectionはinstance metadataだけのredacted summaryを維持し、credential、binding reference、Memory本文、個人pathを含めない。
- diagnostics projectionのcanonical ownerは`src/memory-v6/memory-diagnostics-state.ts`とする。

### 維持する境界

- lifecycle-owned post-turn appraisalとMCP event-time appraisalは別event producerとして維持する。同一event retry以外を意味で統合せず、linked episodeのmutation ownerを重複させない。
- CLIとMCPは同じrunning WithMate application serviceへ接続し、SQLite直結やfallback storeを作らない。
- runtime challenge後だけcredentialとmutation bodyを送る。runtime instance/generation mismatch時に別instanceへfallbackしない。
- public API、永続化schema、既存Memory data、Affect event、idempotency recordをこの移行のために書き換えない。

## Alternatives

### `resources/tools`または`resources/runtime`へ置く

Skill catalog外という条件は満たすが、artifactは利用者が直接起動するCLIでもある。`resources/cli`がconsumer purposeを最も直接表し、追加の`bin`階層も単一生成物には不要なため採用しない。外部command名は変わらないため、この内部path選択で利用者操作は変えない。

### 既存provider Skillをupgrade時に削除する

provider directoryは利用者の編集やprovider固有管理と衝突し得る。新規配布停止を過去copyの破壊的cleanupへ拡張しない。

### agent-bound fallbackもCLI operator credentialを使う

MCP障害がoperator authorityへの昇格条件になり、binding route allowlistを迂回するため採用しない。

### agent-facing targetへCharacter IDを残してserverで一致確認する

spoofは拒否できるが、caller-asserted identityとcanonical actorの二表現が残り、schema consumerがIDをauthorityと誤認しやすいため採用しない。

### Character contextの既存responseを維持しprompt組み立て時だけredactする

MCP/CLI consumerには生identityと内部Memory targetが残る。public application projection自体を最小化する。

## Consequences

- providerはMemory Skillのinstall/syncなしで、同じMCP tool contractを利用する。
- operator CLIとagent fallbackは同じexecutableを使うが、入力schema、credential、route authorityはmodeごとにfail closedで分離される。
- MCPを初期化できないprovider executionではagent-bound CLI fallbackを開始できず、Memory通常操作はcapability unavailableになる。operator CLIによるinspect、migration、manual recoveryはこの制約を受けない。
- actor-relative schemaへの変更はagent-facing breaking changeであり、旧MCP request shapeとのcompatibility fallbackは置かない。operator CLIのexplicit schemaは維持する。
- repository内の旧Skill source、Settings sample、managed Skill testsは実装移行時に削除または新契約のdirect testへ置換する。provider directoryに残る旧copyはWithMateが検査しないため、利用者が任意に削除するまで残り得る。
- 3実装レーンは本ADRのschema、path、projectionを参照し、独自のaliasや互換shapeを追加しない。
