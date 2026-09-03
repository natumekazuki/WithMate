# V6 Memory Foundation

- 作成日: 2026-06-21
- 対象: V5 Character Core後のMemory access / storage / runtime API
- Status: Foundation implemented / agent-preview

## Goal

WithMate V6では、Memoryを毎turn promptへ常設注入する仕組みとしてではなく、coding agentが必要な時だけ検索・追加・忘却できるlocal Memory serviceとして再設計する。

V6 foundationは次を成立させる。

- agent-facing requestをactor SessionのCharacter、user、許可Projectへ安全に解決できる。
- agentがprovider共通MCP経由でMemoryを検索できる。
- agentがユーザーの明示依頼や作業中に得たdurable knowledgeをappendできる。
- agentまたはユーザー意図に基づき、entryを検索対象からforgetできる。
- parallel sessionでtarget推定に依存しない。
- app側Memory serviceは生成LLMを呼ばない。
- Memory accessを通常promptのtoken予算から分離する。

## Position

- 本書をV6 Memory foundationのsource of truthとする。
- V6 DB全体再設計、destructive reset、legacy data境界は`docs/design/v6-database-foundation.md`を優先する。
- V5 Character catalog / definition / snapshotは既存V5 source of truthを優先する。
- `docs/design/memory-architecture.md`のV1〜V4 Memory / Growth記述はhistorical / legacy contextとして扱う。
- legacy project identity detailは`docs/design/project-memory-storage.md`をhistorical contextとして参照できるが、V6 project scopeの正本にはしない。
- V6 Memory に紐づく暗号化 file object / quota / export / GC の拡張設計は`docs/design/v6-memory-protected-objects.md`を参照する。
- provider runtime boundaryは`docs/design/provider-adapter.md`へ反映する。
- current保存構造の棚卸しは`docs/design/database-schema.md`を参照する。

## Product Principles

1. coding agentとしての正確性とCLI parityを優先する。
2. Memoryは継続性を支えるが、作業promptを肥大化させない。
3. Character体験とMemory ownerを接続しても、Character definitionとMemory entryを混同しない。
4. Memory accessが失敗しても通常turnを壊さない。
5. delete / forget / privacyはUI表示だけでなく、search、projection、provider送信、cacheへ反映する。

## Non-Goals

foundationでは次を扱わない。

- Memoryの毎turn prompt常設注入
- mutableなSession working state管理
- session summary / next actionsの自動更新
- turn完了後の自動Memory抽出
- background Memory generation
- Mate Profile / Growthの復活
- Character definitionの自動更新
- Character Stream / Monologue連携
- vector DB / embedding model download
- Memory Management Window
- cloud sync
- export / import
- legacy Memoryの自動migration
- arbitrary SQL query
- generic hard delete / purgeのagent公開

## Architecture Summary

```text
Provider-common Memory MCP / operator CLI
  -> localhost Memory API
      -> Explicit Target Resolver
      -> Permission Gate
      -> Memory Application Service
        -> Search Service
        -> Append Service
        -> Forget Service
        -> Tag Catalog
      -> V6 Memory Storage
```

agent-facing Memory contractはMCP `tools/list`、内部のrequest / response contractはapplication serviceを正本にする。operator CLIとagent-bound CLI fallbackは同じapplication serviceへ接続するが、authority modeと入力schemaを共有しない。

## Entrypoint Policy

### Current

- provider共通MCPをagent-facing entrypointとし、initialize instructionsと`tools/list`でoperation contractを公開する。
- agent-facing targetはactor-relative schemaを使い、user / Character / Session identityを受け付けない。runtime bindingがactor Session、Character、user、許可Projectを解決する。
- `withmate-memory` Skillは配布、同期、検査しない。Memory運用方針をprovider instructionやsystem promptへ複製しない。
- operator CLIはlocalhost APIを呼ぶthin clientとし、operator credentialと明示target / identityを使う。
- agent-bound CLI fallbackはMCP initializeと`tools/list`取得後のtransport availability failureに限定し、MCP credential、binding、actor-relative schemaを維持する。operator modeへdowngradeしない。

## Domain Model

### Memory Principal

Memory requestを実行する主体。operator / app-internal操作の`local_user`と、bound Agent操作の`session_binding`を分ける。

```ts
type LocalUserMemoryPrincipal = {
  type: "local_user";
  bindingIdHash: "local-user";
  providerId: "local-user";
  permissions: MemoryPermission[];
};

type SessionBindingMemoryPrincipal = {
  type: "session_binding";
  bindingIdHash: string;
  sessionId: string;
  providerId: string;
  characterId: string;
  allowedProjectIds: readonly string[];
  permissions: MemoryPermission[];
};

type MemoryPrincipal = LocalUserMemoryPrincipal | SessionBindingMemoryPrincipal;

type MemoryPermission =
  | "memory.search"
  | "memory.append"
  | "memory.forget"
  | "memory.get_entry"
  | "memory.list_tags"
  | "memory.list_characters";
```

`local_user`はoperator CLIまたはapp-internal操作を表し、明示targetを扱う。`session_binding`はruntime bindingから解決したactor Sessionを表し、agent-facing actor-relative targetをcanonical user / Character / 許可Projectへ解決する。requestのidentity field、ambient workspace、process cwdをauthorityには使わない。

### Owner

Memoryが誰または何に属するか。

```ts
type MemoryOwnerRef =
  | { type: "character"; id: string }
  | { type: "project"; id: string }
  | { type: "user"; id: "local-user" };
```

初期公開:

- `character`
- `project`
- `user` owner + `global` scope

`user` ownerは`global` scopeとのexact pairだけを初期公開し、それ以外の`user` owner組み合わせは予約扱いにする。

### Scope

Memoryが有効な文脈。

```ts
type MemoryScopeRef =
  | { type: "session"; id: string }
  | { type: "project"; id: string }
  | { type: "character"; id: string }
  | { type: "global"; id: "global" };
```

OwnerとScopeは別概念とする。

例:

- Character owner + project scope: そのCharacterが特定projectで共有した継続文脈
- Project owner + project scope: Characterに依存しないproject decision
- Character owner + character scope: 関係性や継続した好み

初期APIでは組み合わせをallowlistし、任意組み合わせを許可しない。

初期allowlist:

| Owner | Scope | Use |
| --- | --- | --- |
| `character` | `character` | Character単位の関係性、好み、継続境界 |
| `character` | `project` | 特定projectでそのCharacterと共有した作業文脈 |
| `project` | `project` | Characterに依存しないproject decision / convention |
| `user` | `global` | provider / host / projectに依存しないuser preference / convention / constraint |

`project` owner + `character` scope、`session` scope、`user` owner + `global` scope以外の`user` owner、`user` owner以外の`global` scopeはschema上予約してもよいが、append対象にはしない。`user` owner + `global` scopeはexact pairだけを許可し、secret、token、project固有の非公開情報ではなく、user共通のpreference / convention / constraintに限定して扱う。
session中に得た決定・制約・継続文脈をagentがdurable Memory entryとしてappendすることは許可するが、V6 foundationはmutableなSession working stateをfirst-class domainとして扱わない。

### Entry

```ts
type MemoryEntryState = "active" | "superseded" | "forgotten";

type MemoryEntryKind =
  | "decision"
  | "constraint"
  | "convention"
  | "context"
  | "deferred"
  | "preference"
  | "relationship"
  | "boundary"
  | "note";

type MemoryEntrySummary = {
  id: string;
  owner: MemoryOwnerRef;
  scope: MemoryScopeRef;
  kind: MemoryEntryKind;
  title: string;
  preview: string;
  state: MemoryEntryState;
  tags: MemoryTag[];
  createdAt: string;
  updatedAt: string;
};

type MemoryEntryDetail = MemoryEntrySummary & {
  body: string;
  source: MemorySource;
  supersedes: string[];
  supersededBy: string | null;
  forgottenAt: string | null;
};

type MemoryTag = {
  type: string;
  value: string;
};

type MemorySource = {
  type: "agent" | "manual" | "migration";
  sessionId: string | null;
  messageId: string | null;
  providerId: string | null;
};

type ActiveMemoryEntryDetail = MemoryEntryDetail & {
  state: "active";
  supersededBy: null;
  forgottenAt: null;
};

type SupersededMemoryEntryDetail = MemoryEntryDetail & {
  state: "superseded";
  supersededBy: string;
  forgottenAt: null;
};

type ForgottenMemoryEntryDetail = MemoryEntryDetail & {
  state: "forgotten";
  forgottenAt: string;
};
```

Entry stateはMemory entryが通常利用対象かどうかを表す論理状態である。

- `active`: 現在有効な記憶。通常searchに出してよい。
- `superseded`: 新しいentryに置き換えられた旧entry。通常searchには出さない。
- `forgotten`: 明示的に利用対象から外されたentry。通常search、Skill result、provider送信には出さない。

entry stateと関連fieldの整合性はcontractとstorage hydrationで検証する。

- `active`: `supersededBy = null`、`forgottenAt = null`
- `superseded`: `supersededBy`が新entry ID、`forgottenAt = null`
- `forgotten`: `forgottenAt`がforget時刻。superseded entryを後からforgetした場合は`supersededBy`を保持してよい。

`forgotten`は通常利用対象から外す論理状態である。privacy reasonではtitle / body / preview / tagsを縮退し、fingerprint / mutation eventだけを残す。
generic hard delete、archive、purge、irreversible redactionは別操作として扱い、foundationのagent-facing APIには公開しない。

### Character Snapshot Boundary

- persistent Character Memory ownerはV5 catalogの`characterId`を参照する。
- evidence / auditはMemoryを作ったsessionと、そのsessionに保存されたCharacter snapshotを追跡できるようにする。
- Memory ownerをsnapshot hashへ直接固定しない。
- 通常session / companionに保存されたCharacter snapshotは不変であり、agent-facing Memory検索時のownerはruntime bindingのactor Characterから解決する。operator CLIだけが明示Character IDを使う。`character-authoring` sessionは例外としてturn開始時にcanonical definitionからsnapshotを再生成する。詳細は`docs/design/character-storage.md`を参照する。

## Mutation Policy

### Append

- append-orientedとする。
- canonical entry本文のin-place overwriteをagent APIとして公開しない。
- 訂正は新entryをappendし、`supersedes`で旧entryを参照する。
- transaction内で旧entryを`superseded`へ遷移させる。
- exact duplicateはidempotency keyを第一候補とし、content fingerprintを補助として抑制する。
- idempotency keyはprincipal / operation / owner / scopeと組み合わせて保存し、retryで二重writeしない。
- idempotency recordにはcontent-bearingなresponse JSONを保存しない。
- append retryでは現在のpermission、owner / scope access、entry stateを再検証してから現在のentry summaryを組み立てる。
- append responseの`created`は「元のidempotent append operationが新entryを作成したか」を表す。retry request単体が今回新規作成したかではない。
- retry対象entryがforgotten、forbidden、not foundになった場合は、保存済みpreview / title / tagsを再露出せず、現在状態に基づくerrorを返す。

### Forget

- agent-facing APIは`forget`とする。
- 初期実装ではhard deleteしない。
- entryを`forgotten`へ遷移し、通常searchから即時除外する。
- `privacy` reasonではtitle / body / preview / tagsを縮退し、fingerprint / mutation eventだけを残す。
- `incorrect`、`outdated`、`user_request`、`other` reasonでは本文を保持してよいが、通常search、Skill result、provider送信には出さない。
- forgotten entryは通常search、Skill result、provider送信には出さない。
- forgotten情報をSkill result、prompt、provider instruction、search cacheへ残さない。
- generic hard delete、archive、purgeはfirst release対象外とする。

### No Generic Update / Delete

初期公開しない。

- `memory.update`
- `memory.delete`
- `memory.purge`
- arbitrary patch
- arbitrary state transition

## API Contract

全request / responseはversionを持つ。
response shapeは操作ごとに自然な形にし、統一のためだけの共通envelopeは強制しない。
LLM agent向けのcommandと入出力shapeはMCP `tools/list`を正本とする。operator CLIの操作手順はrunbookで管理する。
error responseは共通envelopeよりもmachine-readable `code`、人間向け`message`、必要に応じた`field`を優先する。

### `memory.search`

```ts
type MemorySearchRequest = {
  schemaVersion: "withmate-memory-v1";
  targets: MemoryTargetSelector[];
  query: string;
  kinds?: MemoryEntryKind[];
  tags?: MemoryTag[];
  limit?: number;
  cursor?: string;
};

type MemoryTargetSelector =
  | { owner: "project"; project: ProjectTargetRef; scope: "project" }
  | { owner: "character"; character: CharacterTargetRef; scope: "character" }
  | { owner: "character"; character: CharacterTargetRef; scope: "project"; project: ProjectTargetRef }
  | { owner: "user"; scope: "global" };

type ProjectTargetRef =
  | { type: "id"; id: string }
  | { type: "path"; path: string };

type CharacterTargetRef =
  | { type: "id"; id: string };
```

Responseはpreview中心とする。

```ts
type MemorySearchResponse = {
  schemaVersion: "withmate-memory-v1";
  items: MemorySearchHit[];
  relatedTags?: MemoryTag[];
  nextCursor?: string;
};

type MemorySearchHit = {
  id: string;
  owner: MemoryOwnerRef;
  scope: MemoryScopeRef;
  kind: MemoryEntryKind;
  title: string;
  preview: string;
  tags: MemoryTag[];
  createdAt: string;
  updatedAt: string;
  match?: {
    fields: ("title" | "preview" | "body" | "tags")[];
    snippet?: string;
  };
};
```

- search hitにfull `body`を含めない。
- `match.fields`はbody hitを示してよいが、`match.snippet`はtags / title / preview由来に限定し、body断片は`memory.search`権限だけでは返さない。
- public APIの`query`は非空文字列を必須とする。storage層は防御的に空queryでもactive entry pageを返すが、agent-facing contractでは空queryをsearch requestとして受け付けない。
- active filterはSQL / search service側でpagination前に行う。
- response builderはpagination済みのactive hit pageだけを受け取り、inactive entryを黙って捨てない。
- searchはtitle / preview / body / tagsをtoken単位で照合し、`delivery-cleanup`と`delivery cleanup`のようなtag表記揺れを吸収する。
- 0件時は近いtag候補を`relatedTags`で返してよい。
- relevance scoreはpublic contractに含めない。match metadataはmatched fieldsと短いsnippetに限定する。
- V4以前のautomatic relevance selection / prompt injectionは復活させない。
- 初期searchはtarget / kind / tag / query filterを優先し、agentがpreviewを見て必要なら`get_entry`する。
- forgotten / superseded entryは通常結果へ出さない。

### `memory.get_entry`

```ts
type MemoryGetEntryResponse = {
  schemaVersion: "withmate-memory-v1";
  entry: MemoryEntryDetail;
};
```

- ID指定でfull bodyを取得する。
- operation permissionとowner / scope accessを再検証する。
- `local_user` requestでは明示targetを必須とし、entryのowner / scopeがtargetと一致する場合だけ返す。targetなしはshared validatorで`MEMORY_INVALID_FIELD` / `target`として拒否し、target不一致は`not_found`に畳む。
- search hitのpreviewが現在の回答、実装、判断に影響しそうな場合に使う。
- 正確な文言、理由、制約、過去の決定が重要な場合はpreviewだけで断定しない。
- search hitを全件機械的に取得しない。必要な最小件数を、関係ありそうなpreviewから順に取得する。
- forgotten / superseded entryは通常の`get_entry`対象にしない。

### `memory.list_tags`

```ts
type MemoryListTagsResponse = {
  schemaVersion: "withmate-memory-v1";
  tags: MemoryTag[];
};
```

- 明示targetで利用可能なactive tag catalogを返す。`withCounts`指定時はentry count、latest update、bounded sampleを同じresponseへ加える。
- search refinementとappend時のtag reuseに使う。

### Maintenance inventory / audit

Memoryの明示的な保守作業では、`memory.list_targets`、`memory.list_entries`、`memory.audit`を使う。通常recallへ自動適用しない。

- `list_targets`はactive entryを持つtargetを列挙し、`includeEmpty`指定時だけ既知のproject、Character、user-globalのempty targetを加える。Character×projectの空組合せは生成しない。
- `list_entries`は単一の明示targetをqueryなしでpaginationする。既定はactive entryで、bodyは`includeBody`指定時だけ投影する。
- `audit`はtarget単位のkind/tag集計と保守候補を返す。候補はheuristicであり、forgetやmoveのauthorityにはしない。bodyは返さない。
- pagination、owner/scope filter、public projectionの実行契約は`src/memory-v6/memory-validation.ts`、`src-electron/memory-v6-storage.ts`、`src/memory-v6/memory-response-contract.ts`を正本とする。

### `memory.append`

```ts
type MemoryAppendRequest = {
  schemaVersion: "withmate-memory-v1";
  target: MemoryTargetSelector;
  kind: MemoryEntryKind;
  title: string;
  body: string;
  preview: string;
  tags: MemoryTag[];
  supersedes?: string[];
  sourceMessageId?: string;
  idempotencyKey?: string;
  dryRun?: boolean;
};
```

```ts
type MemoryAppendResponse = {
  schemaVersion: "withmate-memory-v1";
  entry: MemoryEntrySummary;
  created: boolean;
};
```

`created`は元のidempotent append operationが新entryを作成したかを表す。
idempotent replayでは現在のpermission、entry state、owner / scope accessを再検証し、現在のentryからsummaryを再構築する。
idempotency storageには旧title / preview / tagsを含むresponse JSONを保存しない。

app側validation:

- length / null byte / invalid Unicode
- owner / scope allowlist
- tag normalization
- idempotency
- transaction integrity

contract / pure validationで扱う:

- schemaVersion
- required fields
- enum values
- owner / scope allowlist shape
- duplicate tags
- length / null byte
- well-formed Unicode
- provider-specific unknown field rejection

Phase 1aではrequest contractとpure request validationに限定する。
response / state contractはPhase 1bで固定する。

service層で扱う:

- permission
- project path / id解決
- Character id解決
- referenced entry ownership
- idempotency persistence
- transaction integrity

文字列長のPhase 1a validationはJavaScript文字列のUTF-16 code unit数を基準にする。
transport / HTTP / IPCのbyte size limitはAPI境界で別途検証する。

app側で行わないこと:

- LLMによる保存価値判断
- LLMによるpreview生成
- LLMによるtag生成
- prompt-based duplicate判定

### `memory.forget`

```ts
type MemoryForgetRequest = {
  schemaVersion: "withmate-memory-v1";
  target: MemoryTargetSelector;
  entryIds: string[];
  reason?: "user_request" | "incorrect" | "outdated" | "privacy" | "other";
  sourceMessageId?: string;
  idempotencyKey?: string;
};
```

```ts
type MemoryForgetResponse = {
  schemaVersion: "withmate-memory-v1";
  results: Array<{
    entryId: string;
    status: "forgotten" | "already_forgotten" | "not_found";
  }>;
};
```

request-levelのprincipal不足、operation permission不足、target permission不足は`MEMORY_PRINCIPAL_REQUIRED` / `MEMORY_UNAUTHORIZED` / `MEMORY_FORBIDDEN`のerrorとして返す。
`memory.forget`はfirst releaseでは単一target必須とし、serviceがentry IDからtargetを推論して複数targetへ分割しない。
entry単位では、明示targetからアクセス不能なIDを`not_found`へ畳む。
内部auditではアクセス不能とnot foundを区別してよいが、agent-facing responseで他ownerのentry存在確認に使える差分を出さない。
`dryRun`は実forgetと同じtarget照合結果とpreviewを返すが、entry、protected object、mutation event、idempotencyを変更しない。

### `memory.move_entry`

wrong-scope entryは、単一entry IDと明示した異なる`from` / `to` targetでretargetする。entry ID、relation、protected object attachmentを保持し、entry rowのtarget tupleとmove audit eventを一つのtransactionで確定する。idempotency key replayではrequest fingerprintと現在のdestination targetを再検証する。判断理由は`docs/adr/017-memory-entry-retarget-identity.md`を参照する。

### Tag Canonicalization

request上のtagはdisplay valueとして`type` / `value`を保持する。
同一性判定にはcanonical keyを使う。

Phase 1aのcanonical algorithm:

```ts
value.normalize("NFC").toLowerCase()
```

- 同一request内のduplicate tagはcanonical keyでdedupeする。
- 最初に現れたdisplay valueを保持する。
- Phase 2 storageではraw display valueだけをunique keyにしない。
- tag catalogはcanonical type / valueへunique constraintを持つ。

## CLI Contract

CLIはoperator操作と、MCP契約取得後の限定的なagent-bound fallbackに使う薄いclientとする。
CLIはDBを直接触らず、起動中のWithMateが提供するruntime Memory APIへ接続する。
WithMateが起動していない場合、CLIはすべてのMemory操作を拒否し、machine-readable errorを返す。
WithMate起動中は、operator CLIからMemory target inventory、明示targetのentry一覧・検索・取得・tag統計・audit・append・forget preview/mutation・retargetを扱える。
operator CLI requestは、runtime secretとnonce challengeを通過した同一OS userの`local_user` principalとして扱う。明示targetだけを扱い、`character: current`やsession-bound project inferenceは使えない。
agent-bound CLI fallbackはMCPと同じ`session_binding` principal、actor-relative input、route allowlistを使い、caller指定identityやoperator credentialを使わない。provider binding markerがあるprocessではflagなしの通常CLI操作を拒否し、serverもbinding reference付きoperator requestを受け付けない。fallbackは通常MCP credentialと分離したgeneration-bound reporter credentialにより、MCPの`tools/list` response送出と後続の実transport exceptionをserverへ登録し、同じruntime generation、binding、current turn、method/path/bodyへ発行した短命admissionがある場合だけ実行できる。stateは`listed → eligible → consumed`の一方向であり、structured domain error、変更operation、期限切れ、stale turn、非idempotent file exportはclientとserverの両方で対象外とする。
retrieval ranking、暗黙target注入、毎turn prompt注入は行わない。
bindingなしの外部CLIによるappend / forgetではMemory entryの`source.sessionId`を`null`として保存する。WithMateが起動したagent executionからbinding付きで操作する場合は、runtimeが解決したactor Sessionをsourceとidempotency principalへ保存する。
`--self` flagは採用しない。
current CLIは`WITHMATE_MEMORY_API_URL`、OSユーザー共通runtime registry、または互換用runtime discovery fileからlocalhost APIを発見する。registryは複数のactive entryを正本とし、selectorなしではactive候補が一意な場合だけ選択する。複数候補は`WITHMATE_RUNTIME_AMBIGUOUS`を返し、`--instance <applicationInstanceId>`で明示選択できる。
registry entryはsafe metadataとhash化したcredential参照だけを保持する。credential documentはapplication instanceとMemory固有runtime generationを分離して持つ。legacy generation fileは`withmate-memory-discovery-v2` documentとして`baseUrl`、credential、`applicationInstanceId`、`runtimeGenerationId`、legacy aliasの`runtimeInstanceId`、`publishedAt`を公開し、CLIはloopback HTTP URL以外を拒否する。`memory-v6.current.json`はgenerationを指すpair pointerであり、canonical registryのactive候補が一意な場合だけcleanup時にchallenge済みgenerationへhandoffする。
`--api-url`または`WITHMATE_MEMORY_API_URL`で明示したURLがloopback HTTP URLでない場合、CLIはusage errorで終了し、discovery fileへfallbackしない。
Windows registry rootは`%LOCALAPPDATA%\WithMate\runtime-discovery\v1`とする。既定のlegacy discovery fileは`WITHMATE_MEMORY_RUNTIME_DIR`があればその直下、なければOS temp配下のuser-specific runtime directoryに置く。
app側writerはruntime directoryをOS userだけが読める権限で作成し、POSIXではsymlink directory、他user所有、group / other readableなdirectoryを拒否または修正する。discovery fileは0600相当でexclusive temporary fileから置き換える。
current app起動配線は`src-electron/memory-v6-runtime.ts`で行う。main processは起動ごとに`applicationInstanceId`を一度だけ生成し、Memory runtimeは起動ごとに独立した`runtimeGenerationId`を生成する。app ready後に`withmate-v6.db`をbest-effortでbootstrapし、localhost API、credential generation、registry entry、lease heartbeatの順でpublishし、最後にlegacy pointerをbest-effort更新する。app shutdown時は自分のpublication IDとidentity tupleが一致するentryだけをunpublishし、listener停止後に自generationを削除する。V6 DB、ACL、capacity validationなどでMemory runtimeだけ起動できない場合でも通常app bootは継続し、未完成entryやcredentialを公開しない。
全 window close では app process を終了せず、Windows でも runtime API / CLI discovery を維持する。`app.requestSingleInstanceLock()` と `second-instance` handler により、Start Menu などから再起動された場合は既存 process の Home を再表示・focus する。
Settings の `launchAtLoginEnabled` が有効な場合、packaged app だけが Electron login item へ `--background` 付きで登録する。dev / visual-check の unpackaged app は、引数なしの `electron.exe` をOSの起動先へ登録しないため、保存済み設定にかかわらずlogin itemを変更しない。`--background` 起動では Boot window / Home window を表示せず、runtime API と CLI discovery だけを立ち上げる。
runtime APIはapp起動ごとの短命`apiSecret`、`applicationInstanceId`、Memory `runtimeGenerationId`を要求する。CLI/MCPはoperation bodyやsecret headerを送る前に、secretを送らない`GET /v1/status?nonce=...`でapplication instance、generation、owner challengeを検証する。lease期限切れでもchallenge成功runtimeはactiveとし、期限切れかつchallenge失敗だけをstaleとする。app log、status、diagnostics、error detailsにはruntime endpoint URL、credential path、userData path、binding reference、secretを出さない。V6 bootstrap後はboot diagnosticsを再取得し、fresh userDataでも`withmate-v6.db`が`foundation-ready`として見える状態にする。
operator CLIはsession由来の暗黙targetを扱わず、Memoryのowner / scope targetをcommand引数またはinput payloadで明示する。agent-bound CLI fallbackはactor-relative targetをruntime bindingから解決する。

current raw JSON CLI:

```text
withmate-memory status
withmate-memory status --all
withmate-memory instances
withmate-memory status --instance <application-instance-id>
withmate-memory characters
withmate-memory list-targets
withmate-memory list-entries --project <absolute-project-path> --limit 100
withmate-memory audit --all-targets --format markdown
withmate-memory schema
withmate-memory validate --command append --stdin
withmate-memory search --json '<MemorySearchRequest>'
withmate-memory get-entry --json '<MemoryGetEntryRequest>'
withmate-memory list-tags --json '<MemoryListTagsRequest>'
withmate-memory append --json '<MemoryAppendRequest>'
withmate-memory forget --json '<MemoryForgetRequest>'
withmate-memory forget --file payload.json --dry-run
withmate-memory move-entry --file payload.json
withmate-memory search --file payload.json
withmate-memory search @payload.json
withmate-memory search --project <absolute-project-path> --query "delivery cleanup" --tag delivery-cleanup
withmate-memory search --project <absolute-project-path> --tags topic:delivery-cleanup,topic:relaygraph
```

`--json`、`--file`、`@file`、`--stdin`はrequest bodyの入力方法である。CLI outputは原則JSONとし、`audit --format jsonl|markdown`だけは明示した保守用projectionをstdoutへ出す。
Windows PowerShell / `.cmd` wrapper経由ではinline JSONのquoteが壊れやすいため、request bodyを渡すcommandでは`--stdin`または`--file <path>`を推奨する。
`schema`と`validate`はruntime APIへ接続せずにCLI process内で完結する。`validate`はMemory entryを作成、更新、forgetしない。
API errorもtransportできた場合はruntime APIのJSON responseをそのままstdoutへ出す。
CLI request timeoutは10秒を既定とする。structured JSONの正本は`WITHMATE_RUNTIME_UNAVAILABLE`、`WITHMATE_RUNTIME_INSTANCE_MISMATCH`、`WITHMATE_RUNTIME_GENERATION_CHANGED`、`WITHMATE_RUNTIME_AMBIGUOUS`、`WITHMATE_RUNTIME_STALE`、`WITHMATE_RUNTIME_REGISTRY_CAPACITY`であり、`WITHMATE_NOT_RUNNING`はunavailableのlegacy aliasとして必要な互換期間だけdetailsへ残す。
CLI fetchはHTTP redirectを追従しない。初期URLがloopbackでも、POST bodyを別endpointへ転送しないためにredirectは接続失敗と同じ扱いにする。
stable exit codeは次とする。

| Exit code | Meaning |
| --- | --- |
| `0` | success |
| `1` | CLI usage error |
| `2` | runtime discovery selection error (`WITHMATE_RUNTIME_*`) |
| `3` | runtime APIがnon-2xx JSON responseを返した |
| `4` | transport failure |

current convenience flags:

```text
withmate-memory search --project <absolute-project-path> --query "approval modeの方針"
withmate-memory characters
withmate-memory search --project-id <project-id> --query "approval modeの方針"
withmate-memory search --project <absolute-project-path> --query "delivery cleanup" --tag delivery-cleanup
withmate-memory search --project <absolute-project-path> --tags topic:delivery-cleanup,topic:relaygraph
withmate-memory get-entry --project <absolute-project-path> --entry-id <entry-id>
withmate-memory list-tags --project <absolute-project-path>
```

create / update / supersede系の複雑なrequestをすべてCLI flagsへ展開することは目指さない。write系の構造化requestは`--stdin`または`--file`を正本とする。

### Target Selection

operator CLIではMemory targetをcallerが明示する。agent-bound CLI fallbackはMCP `tools/list`と同じactor-relative targetを使い、Character / user identityを入力しない。
CLI利用者に認証tokenやcredential管理を要求しない。
ただし、CLIは起動中のWithMate runtime Memory APIにのみ接続し、offline CLI / direct DB accessは提供しない。

project target:

- `--project <absolute-path>`
- `--project-id <id>`

character target:

- `--character <character-id>`
- `withmate-memory characters`でactive Character catalogを取得し、明示IDを選択する。
- `withmate-memory characters` / `memory.list_characters`はoperator-onlyであり、agent-facing MCP `tools/list`には公開しない。operator responseも`id`、`name`、必要な`description`だけを返し、renderer用の`iconFilePath`、theme、default、timestamps、archived metadataは返さない。
user-global target:

- operator CLIではrequest bodyの`target`または`targets[]`に`{ "owner": "user", "scope": "global" }`を明示する。agent-bound CLI fallbackではMCPと同じ`{ "kind": "user-global" }`を使い、ownerまたはuser identityを入力しない。
- CLI shorthandは用意せず、`--file` / `--stdin` / `--json`でrequest bodyを渡す。
- user-global Memoryは全projectから見えるため、user-level preference / convention / constraintに限定し、secret、token、project固有の非公開情報は保存しない。

project targetはcurrent working directoryから暗黙推定しない。
`--project .`やrelative pathはCLI起動`cwd`に依存するため許可しない。callerは`--project <absolute-path>`、または`--project-id <id>`を使う。
`--project <absolute-path>`はWithMate runtime側でGit repositoryへ解決する。pathがrepository subdirectoryの場合もrepository root / common dir / remote情報からproject scopeを決定する。Git管理外directoryはproject targetとして解決せず、workspace target導線（例: `--workspace <path>`）を使う。
同じrepositoryの別worktreeは同一project scopeとして扱う。

appendはfirst releaseでは単一target必須とする。
searchは複数target対応を将来検討してよいが、初期実装では単一targetから始めてよい。
owner / scopeのallowlist、entry access、mutation permissionはapp service側で再検証する。

WithMateが起動していない場合:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "error": {
    "code": "WITHMATE_RUNTIME_UNAVAILABLE",
    "message": "WithMate Memory runtime discovery could not select a runtime.",
    "details": {
      "discoveryCode": "WITHMATE_RUNTIME_UNAVAILABLE",
      "legacyCode": "WITHMATE_NOT_RUNNING"
    }
  }
}
```

## Runtime Memory API Security

runtime Memory APIはCLIや将来のMCP adapterが使うapp/service内部境界であり、public APIとして公開しない。
CLIはuser-facingだが、API endpointはユーザーが直接叩く前提にしない。

- 可能ならUnix domain socket / named pipeなどOS-local IPCを優先する。
- HTTPを使う場合も`127.0.0.1` / `::1`のみlistenし、LAN interfaceへbindしない。
- 固定portを避け、WithMateが管理するruntime discovery fileからCLIがendpointを取得する。
- discovery fileはOS userだけが読めるruntime directoryへ置き、永続userData pathを既定にしない。
- CLIは認証tokenをユーザーに要求しない。
- API側は必要に応じてapp内部のruntime secret / nonce / handshakeで公式CLIまたはmanaged adapterからの呼び出しを識別してよい。
- runtime secretを使う場合もDBへ保存せず、URL query、audit、app logへ出さない。
- CORSは許可しない。
- browser originからのrequestを拒否する。
- request body size、rate、concurrencyを制限する。
- state-changing requestはidempotency keyを受けられるようにする。
- principal、permission、owner / scope targetを検証する。
- app shutdownでserverを停止する。

## Storage

V6 MemoryはV6 DB foundation上の新規tableとして実装する。
legacy Memory tableは読まない、書かない、意味変更しない。
V5以前のsession / legacy MemoryはV6 first releaseのmigration対象にしない。
SQL正本は`src-electron/database-schema-v6.ts`に置く。
storage実装は`src-electron/memory-v6-storage.ts`に置き、解決済みowner / scopeに対するinventory、query-free list、append、get、lexical/tag search、supersede、forget preview/mutation、retarget、tag catalog、mutation event、idempotencyを扱う。
storage helper型とtarget SQL helperは`src-electron/memory-v6-schema.ts`に置く。
permission、project path / id解決、Character id解決はstorageへ入れず、application service層で扱う。
storageはvalidな`withmate-v6.db`だけを開き、legacy DB pathへV6 schemaを作らない。

## Application Service

Application serviceはversioned request contractとV6 storageの間に置く。
実装は`src-electron/memory-v6-service.ts`、target解決は`src-electron/memory-v6-context-resolver.ts`、permission gateは`src-electron/memory-v6-permission.ts`に分ける。

service層で扱う:

- request validation済みpayloadからstorage inputへの変換
- maintenance commandを含むMemory response contract生成
- runtime principalのpermission確認
- explicit project targetのID / path解決
- explicit Character targetのID解決
- owner / scope access再検証
- storage idempotency conflictやmissing entryのmachine-readable error変換
- `memory.forget`の単一target制約を保ち、全entry resultをstorage transaction / idempotency recordへ委譲する
- target外entry IDをagent-facing responseでは`not_found`へ畳むexistence oracle防止

service層で扱わない:

- localhost server / CLI transport
- arbitrary SQL query
- legacy Memory tableの読み書き
- LLMによる保存価値判断、preview生成、tag生成

`sourceMessageId`はprovider/source message IDとして扱い、V6 app message FKへは暗黙変換しない。
app message IDとの対応付けは、V6 session/message runtimeが接続された後に明示的なresolverで扱う。

```sql
CREATE TABLE IF NOT EXISTS memory_entries_v6 (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  preview TEXT NOT NULL,
  state TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_session_id TEXT,
  source_app_message_id INTEGER,
  source_provider_message_id TEXT,
  source_provider_id TEXT,
  superseded_by_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  forgotten_at TEXT,
  FOREIGN KEY (source_app_message_id, source_session_id)
    REFERENCES session_messages_v6(id, session_id) ON DELETE SET NULL,
  FOREIGN KEY (superseded_by_id)
    REFERENCES memory_entries_v6(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS memory_entry_tags_v6 (
  entry_id TEXT NOT NULL,
  tag_type TEXT NOT NULL,
  tag_value TEXT NOT NULL,
  tag_type_canonical TEXT NOT NULL,
  tag_value_canonical TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag_type_canonical, tag_value_canonical),
  FOREIGN KEY (entry_id) REFERENCES memory_entries_v6(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_entry_relations_v6 (
  source_entry_id TEXT NOT NULL REFERENCES memory_entries_v6(id) ON DELETE CASCADE,
  target_entry_id TEXT NOT NULL REFERENCES memory_entries_v6(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_entry_id, target_entry_id, relation_type)
);

CREATE TABLE IF NOT EXISTS memory_tag_catalog_v6 (
  tag_type TEXT NOT NULL,
  tag_value TEXT NOT NULL,
  tag_type_canonical TEXT NOT NULL,
  tag_value_canonical TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tag_type_canonical, tag_value_canonical)
);

CREATE TABLE IF NOT EXISTS memory_mutation_events_v6 (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  entry_id TEXT,
  binding_id_hash TEXT,
  session_id TEXT,
  result_status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_idempotency_keys_v6 (
  key TEXT NOT NULL,
  operation TEXT NOT NULL,
  binding_id_hash TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  response_entry_id TEXT,
  operation_created INTEGER NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (binding_id_hash, key, operation, owner_type, owner_id, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS memory_idempotency_forget_results_v6 (
  key TEXT NOT NULL,
  operation TEXT NOT NULL,
  binding_id_hash TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  result_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (binding_id_hash, key, operation, owner_type, owner_id, scope_type, scope_id, entry_id)
);
```

重要なのはlegacy tableとの意味分離である。
idempotencyは`binding_id_hash / key / operation / owner / scope`をidentityに含める。`binding_id_hash`は互換上の列名であり、current実装では`local-user` principalのhashを保存する。
`request_fingerprint`が同一idempotency identityで一致しない場合は、retryではなくconflictとして扱う。
batch forgetの再現結果は`memory_idempotency_forget_results_v6`にentryごとに保存する。
append / supersede / forgetはtransaction内で実行し、失敗時にpartial stateを残さない。
forgetは解決済みtargetを必須とし、target外entry IDは存在確認に使えないよう`not_found`へ畳む。
`privacy` reasonのforgetではtitle / body / preview / tagsを縮退し、通常searchとtag catalogから除外する。

## Retrieval

### Foundation

- active entryのみ対象
- owner / scope filter
- kind / tag filter
- normalized lexical match
- deterministic recency tie-break
- preview result
- stable pagination

### Fallback

- index recoveryやoptional retrieval backend失敗時もlexical / tag searchを継続する。
- Memory検索失敗で通常coding turnを失敗させない。

### Future

- FTS5
- local embedding
- hybrid rerank
- relation-aware search

`memory.search` contractはretrieval実装を隠蔽し、embedding-specific fieldsを公開しない。

## Audit And Privacy

記録する:

- mutation operation
-対象entry ID
- session ID
- result status
- reason category
- timestamp

既定では記録しない:

- binding token
- context file secret
-全文query
- full Memory bodyの複製

search監査は件数・latency・strategy程度に抑え、private query全文の常時保存を避ける。

## Agent InterfaceとCLI Distribution

- Agent向けMemory contractはprovider共通MCPのinitialize instructionsと`tools/list`が所有する。WithMateは`withmate-memory` Skillを新規配布せず、起動、upgrade、Settings操作でprovider側の既存Skill directoryを削除、更新、検査しない。
- CLI/MCP artifactはbuild時に`scripts/withmate-memory.ts`から生成し、repositoryでは`resources/cli/withmate-memory.mjs`をcanonical pathとする。生成artifactをcanonical CLIと別実装として保守しない。
- Windowsではinstall rootの`withmate-memory.cmd`と`Microsoft\WindowsApps\withmate-memory.cmd` aliasをinstallerが作成する。installerはuser `Path` registry値を直接編集しない。
- macOS / LinuxではSettings > Diagnosticsから`~/.local/bin/withmate-memory` shimをinstall / uninstallできる。shimが未導入または`PATH`外でもprovider Skill directoryへCLIを同期しない。
- operator CLIは明示target、operator credential、接続先selectorを扱える。agent-bound CLI fallbackはMCPのinitializeと`tools/list`取得後のtransport availability failureだけで使い、bound runtime、MCP credential、actor-relative schemaを維持する。
- WithMateはMemory運用方針、reflection、CLI fallback手順をprovider instruction fileやsystem promptへ追加しない。

## UI Policy

foundationではMemory Management Windowを戻さない。

最小UI:

- Settings DiagnosticsにMemory API状態を表示する。current実装ではruntime APIのrunning / stopped / failed、application instance、Memory runtime generation、build channel、discovery publish状態だけをread-onlyで返し、endpoint、DB path、discovery file path、secret有無は投影しない。
- CLI shimのsupport、install、PATH状態を表示する。
- last error summaryを表示する。current実装ではruntime起動/停止などの直近errorを最大3件保持する。
- runtime API secret、discovery documentのsecret値はdiagnostics stateへ含めない。UIにはsecret値を表示しない。
- diagnosticsは`generatedAt`、`runtime`、`cliShim`、`lastErrors`の4 fieldだけを持ち、provider別状態、managed Skill同期状態、provider instruction sampleを投影しない。

current実装では、Settings Diagnosticsから`Memory Review` windowを開き、active entryの検索、full body閲覧、agent-facing APIとは分離したapp-internal IPC経由のforgetを行える。
Review UIはruntime API secret、discovery documentのsecret値をrendererへ渡さず、main process側のReview serviceからV6 Memory storageを扱う。
manual correctionはappend + supersedesによる訂正方針を維持し、restore、exportは後続UI phaseとする。

## Legacy Data

- `session_memories`
- `project_scopes`
- `project_memory_entries`
- `character_scopes`
- `character_memory_entries`
- V4 Mate Growth table

これらを自動的にV6 active Memoryとして扱わない。
V6 first releaseではlegacy Memory import / viewer / migration compatibilityを提供しない。
V6 DB migration boundaryは`docs/design/v6-database-foundation.md`を正本にする。

## Failure Policy

- Memory unavailableでも通常turnは継続可能。
- CLIはnon-zero exit codeとJSON errorを返す。
- request-levelのunauthorized / forbiddenとentry-levelのnot foundを区別する。
- entry単位のアクセス不能IDはagent-facing responseではnot foundへ畳む。
- app側timeoutは短くboundedにする。
- append / forgetはtransactionalにする。
- duplicate retryで二重writeしない。

## Implementation Order

1. docs / contract - 完了
2. shared types / validation - 完了
3. schema / storage - 完了
4. application service - 完了
5. localhost server - 完了
6. CLI / runtime discovery - 完了
7. app起動配線 / discovery publish / app-internal API guard - 完了
8. provider共通MCP / operator CLI distribution - 完了
9. diagnostics - 完了
10. Memory Review UI - 完了
11. optional retrieval enhancement

## Docs To Update

- `docs/design/documentation-map.md`
- `docs/design/memory-architecture.md`
- `docs/design/v6-database-foundation.md`
- `docs/design/database-schema.md`
- `docs/design/provider-adapter.md`
- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/window-architecture.md`
- `docs/design/settings-ui.md`
- `docs/manual-test-checklist.md`

## Verification

Automated commandは実装時点の`package.json`を正本にする。2026-06-21時点の候補:

```bash
npm run typecheck
npm test
npm run build
```

実装済みtest:

- contract validation
- append idempotency
- supersede transaction
- forget exclusion
- legacy table non-mutation
- service permission denial
- service target access denial
- service get / forget existence oracle防止
- service idempotency conflict error mapping
- localhost API loopback guard
- localhost API app-internal secret guard
- localhost API browser-origin / content-type guard
- localhost API method / route / JSON / body size / concurrency guard
- localhost API service dispatch
- app起動時のV6 DB bootstrap / runtime API discovery publish
- discovery file cleanup
- invalid V6 DB時にdiscovery fileを残さない
- Settings DiagnosticsでMemory V6 runtime / CLI shim / last errorを表示する
- Memory V6 diagnostics stateにruntime API secretを含めない
- `current` target、`--session-project`、`memory.resolve_context`を拒否する
- Codex / Copilot adapterがMemory bindingなしでprovider client / session cacheを再利用する
- 起動、upgrade、Settings操作でprovider側の`withmate-memory` Skill directoryへアクセスしない
- Settings DiagnosticsからMemory Review windowを開き、active entryの検索、full body閲覧、forgetを実行できる

手動smoke gate:

- Settings DiagnosticsでMemory V6 runtime、CLI shim、latest error summaryを確認する。
- Codex / Copilot sessionでprovider共通MCPがactor-relative targetを同じcanonical user / Character / Projectへ解決することを確認する。
- operator CLIが明示project path / project ID / Character ID targetへ接続できることを確認する。
- stale thread retry相当のinternal retry後に通常turnが継続し、Memory CLI利用が壊れないことを確認する。
- provider rootに既存`withmate-memory` Skillがあっても、起動とSettings保存で内容とtimestampが変わらないことを確認する。

## Open Questions

- `context_file` transportを実際に使うproviderが出た場合のfile lifecycle。
- full entry閲覧、manual correction、forget、restore、exportをどのUI phaseで扱うか。
- Protected Object supportを実装する場合のkey storage、file export UI / CLI境界。
