# V6 Memory Foundation

- 作成日: 2026-06-21
- 対象: V5 Character Core後のMemory access / storage / runtime API
- Status: Foundation implemented / agent-preview

## Goal

WithMate V6では、Memoryを毎turn promptへ常設注入する仕組みとしてではなく、coding agentが必要な時だけ検索・追加・忘却できるlocal Memory serviceとして再設計する。

V6 foundationは次を成立させる。

- agentが明示したCharacter / project / user-global targetを安全に解決できる。
- agentがglobal Skill経由でMemoryを検索できる。
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
- MCP entrypoint
- vector DB / embedding model download
- Memory Management Window
- cloud sync
- export / import
- legacy Memoryの自動migration
- arbitrary SQL query
- generic hard delete / purgeのagent公開

## Architecture Summary

```text
Global Memory Skill
  -> withmate-memory CLI
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

Skill、CLI、MCPはentrypointであり、Memory capabilityの正本ではない。request / response contractとapplication serviceを正本にする。

## Entrypoint Policy

### Initial

- global Skillのみをagent-facing entrypointとして登録する。
- Skillは`withmate-memory` CLIの使い方を説明する。
- CLIはlocalhost APIを呼ぶthin clientとする。
- Skill本文にbinding tokenやsession IDを埋め込まない。
- Skill / CLI callerはproject path / project ID / Character ID / user-global targetを明示する。

### Future

- MCPは同じapplication contractを包むthin adapterとして追加可能にする。
- SkillとMCPで同一capabilityを同時公開する場合は、二重write防止とentrypoint selection policyを先に定義する。

## Domain Model

### Memory Principal

Memory requestを実行する主体。agent-facing runtimeでは、principalは`local_user`のみを扱う。

```ts
type LocalUserMemoryPrincipal = {
  type: "local_user";
  bindingIdHash: "local-user";
  providerId: "local-user";
  permissions: MemoryPermission[];
};

type MemoryPrincipal = LocalUserMemoryPrincipal;

type MemoryPermission =
  | "memory.search"
  | "memory.append"
  | "memory.forget"
  | "memory.get_entry"
  | "memory.list_tags"
  | "memory.list_characters";
```

`local_user`は起動中WithMate runtime APIのsecret / status challengeを通過した同一OS userを表す。明示された`project` owner + `project` scope、`character` owner + `character` scope、または`user` owner + `global` scopeのMemoryを扱う。current Character、session context、session-bound project inferenceは使えない。

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
- 過去sessionのCharacter snapshotは不変だが、Memory検索時のownerはrequestで明示されたCharacter IDから解決する。

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
LLM agentはMemory Skill内のCLI reference / usage guideで各commandの出力shapeを読む前提とする。
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
- `local_user` requestでは明示targetを必須とし、entryのowner / scopeがtargetと一致する場合だけ返す。targetなしはentry存在に関係なく`MEMORY_TARGET_REQUIRED`、target不一致は`not_found`に畳む。
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

- 明示targetで利用可能なactive tag catalogを返す。
- search refinementとappend時のtag reuseに使う。

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

CLIはuser-facing entrypointであり、app外の人間やagentが自由に呼べる薄いclientとする。
CLIはDBを直接触らず、起動中のWithMateが提供するruntime Memory APIへ接続する。
WithMateが起動していない場合、CLIはすべてのMemory操作を拒否し、machine-readable errorを返す。
WithMate起動中は、WithMate外のCodex / shell / CLIからもproject owner + project scope、character owner + character scope、またはuser owner + global scopeのMemoryを明示targetで検索、取得、tag一覧、append、forgetできる。
CLI requestは、runtime secretとnonce challengeを通過した同一OS userの`local_user` principalとして扱う。
`local_user` principalは明示targetだけを扱い、`character: current`、WithMate session context、session-bound project inferenceは使えない。
retrieval ranking、暗黙target注入、毎turn prompt注入は行わない。
append / forget時のMemory entryの`source.sessionId`は`null`として保存する。
`--self` flagは採用しない。
current CLIは`WITHMATE_MEMORY_API_URL`またはruntime discovery fileからlocalhost APIを発見する。
discovery fileは`withmate-memory-discovery-v1` documentとして`baseUrl`、`apiSecret`、`runtimeInstanceId`、`publishedAt`を公開し、CLIはloopback HTTP URL以外を拒否する。
`--api-url`または`WITHMATE_MEMORY_API_URL`で明示したURLがloopback HTTP URLでない場合、CLIはusage errorで終了し、discovery fileへfallbackしない。
既定のdiscovery fileは`WITHMATE_MEMORY_RUNTIME_DIR`があればその直下、なければOS temp配下のuser-specific runtime directoryに置く。
app側writerはruntime directoryをOS userだけが読める権限で作成し、POSIXではsymlink directory、他user所有、group / other readableなdirectoryを拒否または修正する。discovery fileは0600相当でexclusive temporary fileから置き換える。
current app起動配線は`src-electron/memory-v6-runtime.ts`で行う。app ready後に`withmate-v6.db`をbest-effortでbootstrapし、localhost APIを起動してdiscovery fileをpublishする。起動時は既存discovery fileのschema、loopback HTTP URL、`runtimeInstanceId`、nonce challengeを確認し、生きていないendpointだけstaleとして回収する。app shutdown時はcurrent fileの`runtimeInstanceId`が自分のpublishと一致する場合だけ削除する。V6 DBがinvalidなどでMemory runtimeだけ起動できない場合でも、通常app bootは継続し、discovery fileは残さない。
全 window close では app process を終了せず、Windows でも runtime API / CLI discovery を維持する。`app.requestSingleInstanceLock()` と `second-instance` handler により、Start Menu などから再起動された場合は既存 process の Home を再表示・focus する。
Settings の `launchAtLoginEnabled` が有効な場合、Electron login item へ `--background` 付きで登録する。`--background` 起動では Boot window / Home window を表示せず、runtime API と CLI discovery だけを立ち上げる。
runtime APIはapp起動ごとの短命`apiSecret`と`runtimeInstanceId`を要求する。CLIはmutation bodyやsecret headerを送る前に、secretを送らない`GET /v1/status?nonce=...`で`runtimeInstanceId`と`HMAC-SHA256(apiSecret, nonce)` challengeを検証し、成功した場合だけdiscovery fileまたは`WITHMATE_MEMORY_API_SECRET`から取得したsecretを`X-WithMate-Memory-Api-Secret` headerで送る。app logにはruntime endpoint URLやapp-internal secretを出さず、discovery file publishの成否とaddress familyだけを記録する。V6 bootstrap後はboot diagnosticsを再取得し、fresh userDataでも`withmate-v6.db`が`foundation-ready`として見える状態にする。
CLIはsession由来の暗黙targetを扱わない。
Memoryのowner / scope targetはcommand引数またはinput payloadで明示する。

current raw JSON CLI:

```text
withmate-memory status
withmate-memory characters
withmate-memory schema
withmate-memory validate --command append --stdin
withmate-memory search --json '<MemorySearchRequest>'
withmate-memory get-entry --json '<MemoryGetEntryRequest>'
withmate-memory list-tags --json '<MemoryListTagsRequest>'
withmate-memory append --json '<MemoryAppendRequest>'
withmate-memory forget --json '<MemoryForgetRequest>'
withmate-memory search --file payload.json
withmate-memory search @payload.json
withmate-memory search --project C:\path\to\repo-a --query "delivery cleanup" --tag delivery-cleanup
withmate-memory search --project C:\path\to\repo-a --tags topic:delivery-cleanup,topic:relaygraph
```

`--json`、`--file`、`@file`、`--stdin`はrequest bodyの入力方法であり、output format指定ではない。CLI outputは常にJSONをstdoutへ出す。
Windows PowerShell / `.cmd` wrapper経由ではinline JSONのquoteが壊れやすいため、request bodyを渡すcommandでは`--stdin`または`--file <path>`を推奨する。
`schema`と`validate`はruntime APIへ接続せずにCLI process内で完結する。`validate`はMemory entryを作成、更新、forgetしない。
API errorもtransportできた場合はruntime APIのJSON responseをそのままstdoutへ出す。
CLI request timeoutは10秒を既定とし、discovery endpointへ接続できない、または応答が戻らない場合は`WITHMATE_NOT_RUNNING`として扱う。
CLI fetchはHTTP redirectを追従しない。初期URLがloopbackでも、POST bodyを別endpointへ転送しないためにredirectは接続失敗と同じ扱いにする。
stable exit codeは次とする。

| Exit code | Meaning |
| --- | --- |
| `0` | success |
| `1` | CLI usage error |
| `2` | `WITHMATE_NOT_RUNNING` |
| `3` | runtime APIがnon-2xx JSON responseを返した |
| `4` | transport failure |

current convenience flags:

```text
withmate-memory search --project C:\path\to\repo-a --query "approval modeの方針"
withmate-memory characters
withmate-memory search --project-id <project-id> --query "approval modeの方針"
withmate-memory search --project C:\path\to\repo-a --query "delivery cleanup" --tag delivery-cleanup
withmate-memory search --project C:\path\to\repo-a --tags topic:delivery-cleanup,topic:relaygraph
withmate-memory get-entry --project C:\path\to\repo-a --entry-id <entry-id>
withmate-memory list-tags --project C:\path\to\repo-a
```

create / update / supersede系の複雑なrequestをすべてCLI flagsへ展開することは目指さない。write系の構造化requestは`--stdin`または`--file`を正本とする。

### Target Selection

WithMate内外どちらのCLIでも、Memory targetはcallerが明示する。
CLI利用者に認証tokenやcredential管理を要求しない。
ただし、CLIは起動中のWithMate runtime Memory APIにのみ接続し、offline CLI / direct DB accessは提供しない。

project target:

- `--project <absolute-path>`
- `--project-id <id>`

character target:

- `--character <character-id>`
- `withmate-memory characters`でactive Character catalogを取得し、明示IDを選択する。
user-global target:

- request bodyの`target`または`targets[]`に`{ "owner": "user", "scope": "global" }`を明示する。
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
    "code": "WITHMATE_NOT_RUNNING",
    "message": "WithMate Memory API is not running or could not be discovered."
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
storage実装は`src-electron/memory-v6-storage.ts`に置き、解決済みowner / scopeに対するappend、get、lexical/tag search、supersede、forget、tag catalog、mutation event、idempotencyを扱う。
storage helper型とtarget SQL helperは`src-electron/memory-v6-schema.ts`に置く。
permission、project path / id解決、Character id解決はstorageへ入れず、application service層で扱う。
storageはvalidな`withmate-v6.db`だけを開き、legacy DB pathへV6 schemaを作らない。

## Application Service

Application serviceはversioned request contractとV6 storageの間に置く。
実装は`src-electron/memory-v6-service.ts`、target解決は`src-electron/memory-v6-context-resolver.ts`、permission gateは`src-electron/memory-v6-permission.ts`に分ける。

service層で扱う:

- request validation済みpayloadからstorage inputへの変換
- `memory.search` / `memory.get_entry` / `memory.list_tags` / `memory.list_characters` / `memory.append` / `memory.forget`のresponse contract生成
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

## Skill Distribution

- Skillはglobal provider skill rootへ配置する。
- current実装では、Settingsで解決できるprovider skill rootへ起動時と設定保存後に`withmate-memory`を同期する。provider skill root未設定時はskipする。
- WithMateが管理する場合はmanaged marker / versionを持つ。current実装では`.withmate-managed-skill.json`を持つ`withmate-memory`だけをapp version単位で更新する。
- user-created同名Skillを無断上書きしない。
- packaged CLI pathまたはshimをSkillが利用できるようにする。current実装ではWindowsのproviderへ同期するmanaged Skillは自己完結した`SKILL.md`とmanaged markerだけを持ち、CLI実体はinstalled app側のpackaged resourceをPATH shim経由で呼ぶ。Windowsではinstall rootの`withmate-memory.cmd`に加え、user PATH既定の`Microsoft\WindowsApps\withmate-memory.cmd` aliasをinstallerが作成する。installerはuser `Path` registry値を直接編集しない。macOS / LinuxではSettings > Diagnosticsから`~/.local/bin/withmate-memory` shimをinstall / uninstallできる。`~/.local/bin`がapp processの`PATH`に含まれてshimがusableな場合、providerへ同期するmanaged Skillは`SKILL.md`とmanaged markerだけになる。
- Skill updateとapp versionの互換範囲を定義する。
- Skill本文はCLI command、JSON schema、error recovery、when-to-use / when-not-to-useを説明する。
- CLIそのもののreferenceはsource bundleの`reference/`配下にも残す。Windowsまたはusable PATH shimがあるproviderへ配布される`SKILL.md`だけで基本のCLI利用、JSON shape、error handlingが完結する。macOS / Linuxでshim未導入または`PATH`外の場合は、source bundleの`reference/`と`bin/`を同期対象に含め、`node bin/withmate-memory.mjs` fallbackを維持する。
- Skill本体はMemoryを使うタイミング、search / get / append / forget / tagsの判断基準、inactive entryの扱いを説明する。
- Skill本文やreferenceにはruntime secret、runtime discovery file pathを記載しない。
- Settings Diagnosticsは、必要なproviderのuser-level instruction fileへ手動で貼り付けるためのprovider instruction sampleを表示し、clipboard copyできる。
- WithMateは初期agent-previewではprovider instruction fileを自動編集しない。repo root `AGENTS.md`、Codex home `AGENTS.md`、GitHub Copilot CLIのglobal instruction fileを丸ごと上書きせず、managed block同期も初期対象にしない。
- provider instruction sampleは詳細CLI仕様ではなく、WithMate Memory Skillを使うべきトリガーとhigh-level policyだけを持つ。
- sampleにはDB直読み禁止、Memory CLI / Skill経由の原則、append / forgetを検討する自然言語トリガーを短く書く。
- sampleにはruntime secret、discovery file path、internal header / env、local runtime identifierを書かない。

## UI Policy

foundationではMemory Management Windowを戻さない。

最小UI:

- Settings DiagnosticsにMemory API状態を表示する。current実装ではruntime APIのrunning / stopped / failed、baseUrl、DB path、discovery file path、secret有無だけをread-onlyで返す。
- global Skill install状態を表示する。current実装では直近managed Skill sync結果をproviderごとに表示し、collision / failed / unconfiguredを区別する。
- last error summaryを表示する。current実装ではruntime起動/停止とSkill sync失敗の直近errorを最大3件保持する。
- runtime API secret、discovery documentのsecret値はdiagnostics stateへ含めない。UIにはsecret値を表示しない。
- Settings Diagnosticsにprovider instruction sampleを表示し、clipboard copy導線を置く。このsampleはユーザーが必要なprovider instruction fileへ手動で貼り付けるための補助であり、WithMateはinstruction fileを自動同期しない。

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
8. global Skill install / update - 完了
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
- Settings DiagnosticsでMemory V6 runtime / managed Skill sync / last errorを表示する
- Memory V6 diagnostics stateにruntime API secretを含めない
- `current` target、`--session-project`、`memory.resolve_context`を拒否する
- Codex / Copilot adapterがMemory bindingなしでprovider client / session cacheを再利用する
- user-created同名`withmate-memory` Skillを上書きせずcollisionとしてskipする
- Settings DiagnosticsからMemory Review windowを開き、active entryの検索、full body閲覧、forgetを実行できる
- Settings Diagnosticsでprovider instruction sampleを確認し、clipboardへcopyできる

手動smoke gate:

- Settings DiagnosticsでMemory V6 runtime、managed Skill sync、latest error summaryを確認する。
- Codex / Copilot sessionで`withmate-memory` CLIが明示project path / project ID / Character ID targetへ接続できることを確認する。
- stale thread retry相当のinternal retry後に通常turnが継続し、Memory CLI利用が壊れないことを確認する。
- user-created同名Skillがあるprovider rootでmanaged Skill syncが`skipped-collision`になり、既存Skillが上書きされないことを確認する。

## Open Questions

- `context_file` transportを実際に使うproviderが出た場合のfile lifecycle。
- full entry閲覧、manual correction、forget、restore、exportをどのUI phaseで扱うか。
