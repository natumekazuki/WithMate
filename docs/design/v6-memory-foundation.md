# V6 Memory Foundation

## Goal

WithMate V6のMemoryは、coding agentが必要な時だけ検索・追加・忘却できるlocal Memory serviceである。

V6 foundationは次を成立させる。

- agent-facing requestをactor SessionのCharacter、user、許可Projectへ安全に解決できる。
- agentがprovider共通MCP経由でMemoryを検索できる。
- agentが日常の小さな好み・話題・共有した出来事も短いnoteやepisodeとしてappendできる。
- agentまたはユーザー意図に基づき、entryを検索対象からforgetできる。
- parallel sessionでtarget推定に依存しない。
- app側Memory serviceは生成LLMを呼ばない。
- Memory accessを通常promptのtoken予算から分離する。

## Position

- 本書をV6 Memory foundationのsource of truthとする。
- V6 DB全体再設計、destructive reset、legacy data境界は`docs/design/v6-database-foundation.md`を優先する。
- Character catalog / definition / snapshotは`docs/design/character-storage.md`を優先する。
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
- cloud sync
- Memory全体のexport / import
- legacy Memoryの自動migration
- arbitrary SQL query
- generic hard delete / purgeのagent公開

## Architecture Summary

```text
Provider-common Memory MCP / CLI
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

CLI/MCPの公開操作、input schema、handler、errorは`src-electron/platform/mcp/withmate-memory-mcp.ts`の共通tool registryを正本とする。両入口は同じruntime clientとapplication serviceへ接続し、内部のcanonical request / response contractを公開入力から区別する。

## Entrypoint Policy

### Current

- provider共通MCPをagent-facing entrypointとし、initialize instructionsと`tools/list`でoperation contractを公開する。
- agent-facing targetはactor-relative schemaを使い、user / Character / Session identityを受け付けない。runtime bindingがactor Session、Character、user、許可Projectを解決する。
- `withmate-memory` Skillは配布、同期、検査しない。Memory運用方針をprovider instructionやsystem promptへ複製しない。
- CLIもMCPもlocalhost APIを呼ぶthin adapterであり、ローカルruntime認証を維持する。通常CLIはMCP障害の有無に依存しない。
- Character context / Affect / Character所有Memoryはbindingを要求し、現在Character / Sessionと許可Projectを解決する。一般user-global / Project Memoryは明示targetがあればbindingなしでも利用できる。binding提示時は許可範囲・失効を検証し、無効bindingを無視してunboundへ降格しない。
- status / instances / metrics / 容量等の集計診断はbindingなしで利用できる。複数targetにCharacterを含む要求、filter省略の横断一覧、audit allTargetsは要求全体でbindingが必要である。

## Affectの更新とcontext

Affect更新も通常turn内のAgentによる`character_affect.appraise`を使う。記録する意味のある感情変化だけを保存し、毎turnの必須呼出し、変化なしevent、別LLMによる後処理や補完turnは設けない。linked episodeは同じappraisalの`memoryEpisode`だけに送り、単独episodeだけを`character_memory.append_episode`で保存する。

pre-turnのcontext取得・prompt注入と取得時のafterglow projectionは維持する。保存済みevent／episode／一般Memory、version、idempotency、authorityと`effect: unknown`の照合は既存application境界に従う。turn中に保存済みの更新は、後続の応答失敗・取消で巻き戻さない。旧Affect専用queueは[Database Schema](database-schema.md#起動時の移行とデータ保護)のschema更新で除去し、候補を再適用しない。

## Domain Model

### Memory Principal

Memory requestを実行する主体。認証済み無bindingの一般Memory / app-internal操作の`local_user`と、bindingを解決した操作の`session_binding`を分ける。

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

`local_user`は認証済み無bindingの一般Memoryまたはapp-internal操作を表す。公開入口からは明示user-global / Project targetを扱う。`session_binding`はruntime bindingから解決したactor Sessionを表し、同じpublic targetをcanonical user / 現Character / 許可Projectへ解決する。requestのidentity field、ambient workspace、process cwdをauthorityには使わない。

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
- 通常Main / Auxiliaryはstable ownerと保存済みsnapshotの表示metadataを維持し、active Characterの有効な定義変更だけを内部送信開始経路でsnapshotへ反映する。Archive後の継続と`character-authoring`固有の境界を含む詳細は[Character Storage](character-storage.md#runtime-snapshot)を参照する。
- Character所有Memoryのownerは両入口ともruntime bindingのactor Characterから解決する。callerの明示Character IDをauthorityとして受け付けない。

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

以下の型はapplication service内部のcanonical request / responseを示し、versionを持つ。CLI/MCPのpublic inputはactor-relative targetを使い、top-levelのschemaVersionやidentityをcallerから受け取らない。runtimeがcanonical requestへ変換する。
response shapeは操作ごとに自然な形にし、統一のためだけの共通envelopeは強制しない。
CLI/MCP共通の公開入出力shapeは`memory.schema` / CLI `schema`とMCP `tools/list`で確認する。27操作の対応・認可・操作手順は[Memory / Affect Runbook](../runbooks/memory-affect-mcp.md)を参照する。
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
  tags: Array<MemoryTag & {
    entryCount?: number;
    latestUpdatedAt?: string;
    samples?: Array<{ id: string; title: string }>;
  }>;
  nextCursor?: string;
};
```

- 明示targetで利用可能なactive tag catalogを返す。`limit`と`cursor`で結果を区切り、続きがあれば`nextCursor`を返す。`withCounts`指定時はentry count、latest update、bounded sampleを同じresponseへ加える。
- search refinementとappend時のtag reuseに使う。

### Maintenance inventory / audit

Memoryの明示的な保守作業では、`memory.list_targets`、`memory.list_entries`、`memory.audit`を使う。通常recallへ自動適用しない。

- `list_targets`はactive entryを持つtargetを列挙し、`includeEmpty`指定時だけ既知のproject、Character、user-globalのempty targetを加える。Character×projectの空組合せは生成しない。
- `list_entries`は単一の明示targetをqueryなしでpaginationする。既定はactive entryで、bodyは`includeBody`指定時だけ投影する。
- `audit`はtarget単位のkind/tag集計と保守候補を返す。候補はheuristicであり、forgetやmoveのauthorityにはしない。bodyは返さない。
- pagination、owner/scope filter、public projectionの実行契約は`src-shared/memory/memory-validation.ts`、`src-electron/memory/memory-v6-storage.ts`、`src-shared/memory/memory-response-contract.ts`を正本とする。

### `memory.append`

```ts
type MemoryAppendRequest = {
  schemaVersion: "withmate-memory-v1";
  target: MemoryTargetSelector;
  kind: MemoryEntryKind;
  title: string;
  body: string;
  preview: string;
  tags?: MemoryTag[];
  supersedes?: string[];
  mutationReason?: string;
  files?: MemoryAppendFileInput[];
  sourceMessageId?: string;
  idempotencyKey?: string;
};
```

```ts
type MemoryAppendResponse = {
  schemaVersion: "withmate-memory-v1";
  entry: MemoryEntrySummary;
  created: boolean;
  replayed?: true;
};
```

`created`は元のidempotent append operationが新entryを作成したかを表す。
入力の`tags`省略は空配列と同じ正規化値になり、タグを自動生成しない。`title`と`preview`は検索・一覧用の明示入力を必須とし、本文から自動補完しない。正規化後の`MemoryAppendRequest`と保存entryには常に`tags`配列がある。省略と明示的な空配列は同じidempotency keyで再送しても同一requestとして扱う。既存の全項目明示入力と保存形式は維持する。
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

requestの型とschemaVersionは[Memory Contract](../../src-shared/memory/memory-contract.ts)、pure request validationは[Memory Validation](../../src-shared/memory/memory-validation.ts)を正本とする。
responseの型とbuilderは[Memory Response Contract](../../src-shared/memory/memory-response-contract.ts)、entryのstateと不変条件は[Memory State](../../src-shared/memory/memory-state.ts)を正本とする。searchはbody / stateを含まないpreview hit、get_entryはactive entryのdetail、appendはbodyを含まないsummaryを返す。

service層で扱う:

- permission
- project path / id解決
- Character id解決
- referenced entry ownership
- idempotency persistence
- transaction integrity

文字列長のvalidationはtrim後のJavaScript文字列のUTF-16 code unit数（`string.length`）を基準にする。null byteと対になっていないsurrogateを拒否し、well-formedなsurrogate pairは許可する。
transportのbyte size limitは文字列長とは別の制約であり、HTTP request bodyのbyte数は[Memory HTTP Server](../../src-electron/memory/memory-v6-http-server.ts)のAPI境界で別途検証する。

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
  dryRun?: boolean;
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

`type` / `value`をそれぞれtrimした後、次のalgorithmでcanonical type / valueを作る。

```ts
value.normalize("NFC").toLowerCase()
```

- 同一性はcanonical type / valueの組で判定し、同一request内のduplicate tagをdedupeする。
- 同一requestで最初に現れたtrim後のdisplay type / valueを保持し、display value自体をNFC lowercaseへ置換しない。
- storageはdisplay type / valueとcanonical type / valueを別々に保存し、raw display valueだけをunique keyにしない。
- `memory_entry_tags_v6`はentry IDとcanonical type / valueの組、`memory_tag_catalog_v6`はcanonical type / valueの組をprimary keyとする。保存処理は[Memory Storage](../../src-electron/memory/memory-v6-storage.ts)、保存制約は[V6 Database Schema](../../src-electron/storage/database-schema-v6.ts)を正本とする。

## CLI Contract

CLIとMCPは共通tool registryの27操作を公開する薄いadapterであり、SQLiteやobject storeを直接開かない。起動中のWithMate runtimeを選択・認証して同じapplication boundaryへ要求を送る。停止中は別の保存先へfallbackせずmachine-readable errorを返す。操作対応とbinding要否は[Memory / Affect Runbook](../runbooks/memory-affect-mcp.md)を参照する。

一般user-global / Project Memoryは明示targetがあればbindingなしでも利用でき、`local_user` principalとして保存する。この場合 `source.sessionId` はnullである。有効なbinding付き要求は `session_binding` principalを使い、actor Sessionをsourceとidempotency principalへ保存する。Character context / Affect / Character所有Memory / charactersはbinding必須である。

公開targetは `{kind:"user-global"}`、`{kind:"project",project:ref}`、`{kind:"character"}`、`{kind:"character+project",project:ref}` の4種類である。project refはidまたは絶対pathを明示し、cwdやambient workspaceから推定しない。Character identity、user identity、Session identity、authorityは入力しない。無bindingの一覧はuser-global / Project filterを明示し、暗黙Character対象を含む横断要求を成功扱いしない。binding提示時は対象・許可Project・失効を検証し、無効bindingを無視しない。

`--json`、`--file`、`@file`、`--stdin` は同じpublic bodyの入力方法であり、project等のshorthandも同じbodyへ正規化する。write等の複雑な入力は `--stdin` / `--file` を使う。`schema` / `validate` はruntimeへ接続せず共通registryの説明・形式検証だけを行い、認可や保存の成功を保証しない。

```text
withmate-memory status
withmate-memory instances
withmate-memory status --all
withmate-memory list-targets --json '{"filter":{"kind":"project"}}'
withmate-memory search --project <absolute-project-path> --query "approval modeの方針"
withmate-memory get-entry --project-id <project-id> --entry-id <entry-id>
withmate-memory append --file payload.json
withmate-memory affect-inspect --json '{}'
withmate-memory schema
withmate-memory validate --command append --stdin
```

Character系の例はSession bindingを受け継いだprocessで実行する。通常CLIはMCP initializeや障害を開始条件にしない。`--fallback-from mcp` は実transport障害後にserverが発行する限定admission付きの同一要求再照合であり、通常操作やoperator権限への昇格ではない。非idempotentなfile exportはこのfallbackに含めない。

CLI stdoutはJSONが基本で、`audit --format jsonl|markdown` だけが表示用projectionを選択する。CLI exit codeは `0` が成功、`1` がusage、`2` がdiscovery選択、`3` が公開操作の失敗、`4` がCLI transport失敗である。業務上の判定には両入口で共通のJSON error codeとeffectを使う。

### Runtime discovery

current CLIは`WITHMATE_MEMORY_API_URL`、OSユーザー共通runtime registry、または互換用runtime discovery fileからlocalhost APIを発見する。registryは複数のactive entryを正本とし、selectorなしではactive候補が一意な場合だけ選択する。複数候補は`WITHMATE_RUNTIME_AMBIGUOUS`を返し、`--instance <applicationInstanceId>`で明示選択できる。
registry entryはsafe metadataとhash化したcredential参照だけを保持する。credential documentはapplication instanceとMemory固有runtime generationを分離して持つ。legacy generation fileは`withmate-memory-discovery-v2` documentとして`baseUrl`、credential、`applicationInstanceId`、`runtimeGenerationId`、legacy aliasの`runtimeInstanceId`、`publishedAt`を公開し、CLIはloopback HTTP URL以外を拒否する。`memory-v6.current.json`はgenerationを指すpair pointerであり、canonical registryのactive候補が一意な場合だけcleanup時にchallenge済みgenerationへhandoffする。
`--api-url`または`WITHMATE_MEMORY_API_URL`で明示したURLがloopback HTTP URLでない場合、CLIはusage errorで終了し、discovery fileへfallbackしない。
Windows registry rootは`%LOCALAPPDATA%\WithMate\runtime-discovery\v1`とする。既定のlegacy discovery fileは`WITHMATE_MEMORY_RUNTIME_DIR`があればその直下、なければOS temp配下のuser-specific runtime directoryに置く。
app側writerはruntime directoryをOS userだけが読める権限で作成し、POSIXではsymlink directory、他user所有、group / other readableなdirectoryを拒否または修正する。discovery fileは0600相当でexclusive temporary fileから置き換える。
current app起動配線は`src-electron/memory/memory-v6-runtime.ts`で行う。main processは起動ごとに`applicationInstanceId`を一度だけ生成し、Memory runtimeは起動ごとに独立した`runtimeGenerationId`を生成する。app ready後に`withmate-v6.db`をbest-effortでbootstrapし、localhost API、credential generation、registry entry、lease heartbeatの順でpublishし、最後にlegacy pointerをbest-effort更新する。app shutdown時は自分のpublication IDとidentity tupleが一致するentryだけをunpublishし、listener停止後に自generationを削除する。V6 DB、ACL、capacity validationなどでMemory runtimeだけ起動できない場合でも通常app bootは継続し、未完成entryやcredentialを公開しない。
全 window close では app process を終了せず、Windows でも runtime API / CLI discovery を維持する。`app.requestSingleInstanceLock()` と `second-instance` handler により、Start Menu などから再起動された場合は既存 process の Home を再表示・focus する。
Settings の `launchAtLoginEnabled` が有効な場合、packaged app だけが Electron login item へ `--background` 付きで登録する。dev / visual-check の unpackaged app は、引数なしの `electron.exe` をOSの起動先へ登録しないため、保存済み設定にかかわらずlogin itemを変更しない。`--background` 起動では Boot window / Home window を表示せず、runtime API と CLI discovery だけを立ち上げる。
runtime APIはapp起動ごとの短命`apiSecret`、`applicationInstanceId`、Memory `runtimeGenerationId`を要求する。CLI/MCPはoperation bodyやsecret headerを送る前に、secretを送らない`GET /v1/status?nonce=...`でapplication instance、generation、owner challengeを検証する。lease期限切れでもchallenge成功runtimeはactiveとし、期限切れかつchallenge失敗だけをstaleとする。app log、status、diagnostics、error detailsにはruntime endpoint URL、credential path、userData path、binding reference、secretを出さない。V6 bootstrap後はboot diagnosticsを再取得し、fresh userDataでも`withmate-v6.db`が`foundation-ready`として見える状態にする。

### Target resolutionと診断範囲

projectの絶対pathはruntime側でGit repositoryへ解決する。repository subdirectoryでもroot / common dir / remoteからproject scopeを決定し、同じrepositoryの別worktreeは同一project scopeとして扱う。relative pathを受け付けない。owner / scopeのallowlist、entry access、mutation permissionはapplication serviceで再検証する。

Session bindingによるtarget inventory・audit・largest entry詳細の権限絞り込みはpaginationとcursor生成より前に行う。bound scopeは現在Character・許可Project・共有user-globalであり、記憶を作成したSessionだけに狭めない。`characters`は現在Characterのid/name/descriptionのみを返し、renderer metadataは返さない。

status、instances、metrics、quota / usage集計はbindingなしでも利用できる。metricsとquota集計はruntime / DB全体値で、Session別集計ではない。binding付きinstancesは選択ownerへ限定する。largest entry詳細は無bindingでは一般user-global / Project、binding付きでは現在Character / 許可Project / 共有user-globalに限定し、object store path、key、hashを返さない。

## Runtime Memory API Security

runtime Memory APIはCLIとMCP adapterが使うapp/service内部境界であり、public APIとして公開しない。
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
SQL正本は`src-electron/storage/database-schema-v6.ts`に置く。
storage実装は`src-electron/memory/memory-v6-storage.ts`に置き、解決済みowner / scopeに対するinventory、query-free list、append、get、lexical/tag search、supersede、forget preview/mutation、retarget、tag catalog、mutation event、idempotencyを扱う。
storage helper型とtarget SQL helperは`src-electron/memory/memory-v6-schema.ts`に置く。
permission、project path / id解決、Character id解決はstorageへ入れず、application service層で扱う。
project pathのread/searchとdry-run、失敗したmutationではscopeを作らず、成功したappend/moveで必要なscopeを作る。
storageはvalidな`withmate-v6.db`だけを開き、legacy DB pathへV6 schemaを作らない。

## Application Service

Application serviceはversioned request contractとV6 storageの間に置く。
実装は`src-electron/memory/memory-v6-service.ts`、target解決は`src-electron/memory/memory-v6-context-resolver.ts`、permission gateは`src-electron/memory/memory-v6-permission.ts`に分ける。

Mainのreview操作（usage / export / GC / search / get / forget）、diagnostics、CLI shim操作の組み立ては`src-electron/memory/memory-v6-main-assembly.ts`が所有する。`main.ts`はcurrent runtime、quota、key protector等の依存とWindow dialogを接続し、runtime APIの起動・終了を管理する。Worker経由のstorage操作と認可境界は変更しない。

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
idempotencyは`binding_id_hash / key / operation / owner / scope`をidentityに含める。`binding_id_hash`は実行principalを識別し、無bindingの一般Memoryでは`local-user`、binding付きでは解決されたbindingのhashを保存する。
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
- provider SessionはMainの共有localhost HTTP MCPを使い、Memory／CharacterとGlossaryでlistenerを共有する。tool定義とruntime clientは`src-electron/platform/mcp/`を手動stdio CLIと共有する。HTTP tokenはruntime owner・binding generation・captured turnへ固定し、取消・終了・失効・runtime停止で無効化する。非同期actor解決、Worker queue、SQLite commit、file書出しでも共有失効stateを再確認する。
- CLI/MCP artifactはbuild時に`src-cli/memory/withmate-memory.ts`から生成し、repositoryでは`resources/cli/withmate-memory.mjs`をcanonical pathとする。生成artifactをcanonical CLIと別実装として保守しない。
- Windowsではinstall rootの`withmate-memory.cmd`と`Microsoft\WindowsApps\withmate-memory.cmd` aliasをinstallerが作成する。installerはuser `Path` registry値を直接編集しない。
- macOS / LinuxではSettings > Diagnosticsから`~/.local/bin/withmate-memory` shimをinstall / uninstallできる。shimが未導入または`PATH`外でもprovider Skill directoryへCLIを同期しない。
- CLI/MCPは同じpublic input・result・error・認可を持つ。通常CLIとは別に、MCPの実transport障害へserverが発行するadmission付き再照合経路を持つ。後者は同一runtime・binding・turn・要求に限定し、認可拒否やdomain errorの迂回に使わない。
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
manual correctionはappend + supersedesによる訂正方針を維持する。

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
