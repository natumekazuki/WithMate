# V6 Memory Foundation

- 作成日: 2026-06-21
- 対象: V5 Character Core後のMemory access / storage / runtime binding
- Status: Draft

## Goal

WithMate V6では、Memoryを毎turn promptへ常設注入する仕組みとしてではなく、coding agentが必要な時だけ検索・追加・忘却できるlocal Memory serviceとして再設計する。

V6 foundationは次を成立させる。

- V5 Character sessionから、安全に現在のsession / Character / project contextを解決できる。
- agentがglobal Skill経由でMemoryを検索できる。
- agentがユーザーの明示依頼や作業中に得たdurable knowledgeをappendできる。
- agentまたはユーザー意図に基づき、entryを検索対象からforgetできる。
- parallel sessionでbindingが混線しない。
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
      -> Binding Resolver
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
- Skill本文にbinding token、session ID、Character IDを埋め込まない。

### Future

- MCPは同じapplication contractを包むthin adapterとして追加可能にする。
- SkillとMCPで同一capabilityを同時公開する場合は、二重write防止とentrypoint selection policyを先に定義する。

## Domain Model

### Memory Principal

Memory requestを実行する主体。初期実装ではWithMate session bindingだけを扱う。

```ts
type MemoryPrincipal = {
  bindingId: string;
  sessionId: string;
  providerId: string;
  permissions: MemoryPermission[];
  expiresAt: string | null;
};

type MemoryPermission =
  | "memory.search"
  | "memory.append"
  | "memory.forget"
  | "memory.get_entry"
  | "memory.list_tags"
  | "memory.resolve_context";
```

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

`user`はschemaで予約してもよいが、初期APIでのappend対象にはしない。

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

`project` owner + `character` scope、`user` owner、`session` scope、`global` scopeはschema上予約してもよいが、初期append対象にはしない。
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
- 過去sessionのCharacter snapshotは不変だが、Memory検索時のownerは現在requestのbinding contextから解決する。

## Mutation Policy

### Append

- append-orientedとする。
- canonical entry本文のin-place overwriteをagent APIとして公開しない。
- 訂正は新entryをappendし、`supersedes`で旧entryを参照する。
- transaction内で旧entryを`superseded`へ遷移させる。
- exact duplicateはidempotency keyを第一候補とし、content fingerprintを補助として抑制する。
- idempotency keyはbinding / operation / owner / scopeと組み合わせて保存し、retryで二重writeしない。
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

### `memory.resolve_context`

Request:

```json
{
  "schemaVersion": "withmate-memory-v1"
}
```

Response:

```ts
type MemoryResolveContextResponse = {
  schemaVersion: "withmate-memory-v1";
  session: { id: string };
  character: { id: string; name: string } | null;
  sessionProject: { id: string; displayName: string } | null;
  permissions: MemoryPermission[];
};
```

```json
{
  "schemaVersion": "withmate-memory-v1",
  "session": { "id": "..." },
  "character": { "id": "...", "name": "..." },
  "sessionProject": { "id": "...", "displayName": "..." },
  "permissions": ["memory.search", "memory.append"]
}
```

`memory.resolve_context`は、transport metadataから解決できるprincipal、permissions、current Character、session project、runtime状態を返す。
ここで返す`sessionProject`はdiagnostics / convenience用途であり、search / appendのtargetを暗黙決定しない。
CLI commandとしては`withmate-memory context`で呼ぶ。
`--self` flagは採用しない。

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
  | { owner: "character"; character: CharacterTargetRef; scope: "project"; project: ProjectTargetRef };

type ProjectTargetRef =
  | { type: "id"; id: string }
  | { type: "path"; path: string }
  | { type: "alias"; alias: string };

type CharacterTargetRef =
  | { type: "id"; id: string }
  | { type: "current" };
```

Responseはpreview中心とする。

```ts
type MemorySearchResponse = {
  schemaVersion: "withmate-memory-v1";
  items: MemorySearchHit[];
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
};
```

- search hitにfull `body`を含めない。
- active filterはSQL / search service側でpagination前に行う。
- response builderはpagination済みのactive hit pageだけを受け取り、inactive entryを黙って捨てない。
- relevance scoreはpublic contractに含めない。
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
- binding permissionとowner / scope accessを再検証する。
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

- runtime binding検証
- permission
- `--character current`解決
- project path / alias / id解決
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

request-levelのbinding不足、operation permission不足、target permission不足は`MEMORY_BINDING_REQUIRED` / `MEMORY_UNAUTHORIZED` / `MEMORY_FORBIDDEN`のerrorとして返す。
`memory.forget`はfirst releaseでは単一target必須とし、serviceがentry IDからtargetを推論して複数targetへ分割しない。
entry単位では、現在のbindingからアクセス不能なIDを`not_found`へ畳む。
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
`--self` flagは採用しない。
current CLIは`WITHMATE_MEMORY_API_URL`またはruntime discovery fileからlocalhost APIを発見する。
discovery fileは`withmate-memory-discovery-v1` documentとして`baseUrl`、`apiSecret`、`runtimeInstanceId`、`publishedAt`を公開し、CLIはloopback HTTP URL以外を拒否する。
`--api-url`または`WITHMATE_MEMORY_API_URL`で明示したURLがloopback HTTP URLでない場合、CLIはusage errorで終了し、discovery fileへfallbackしない。
既定のdiscovery fileは`WITHMATE_MEMORY_RUNTIME_DIR`があればその直下、なければOS temp配下のuser-specific runtime directoryに置く。
app側writerはruntime directoryをOS userだけが読める権限で作成し、POSIXではsymlink directory、他user所有、group / other readableなdirectoryを拒否または修正する。discovery fileは0600相当でexclusive temporary fileから置き換える。
current app起動配線は`src-electron/memory-v6-runtime.ts`で行う。app ready後に`withmate-v6.db`をbest-effortでbootstrapし、localhost APIを起動してdiscovery fileをpublishする。起動時は既存discovery fileのschema、loopback HTTP URL、`runtimeInstanceId`、nonce challengeを確認し、生きていないendpointだけstaleとして回収する。app shutdown時はcurrent fileの`runtimeInstanceId`が自分のpublishと一致する場合だけ削除する。V6 DBがinvalidなどでMemory runtimeだけ起動できない場合でも、通常app bootは継続し、discovery fileは残さない。
runtime APIはapp起動ごとの短命`apiSecret`と`runtimeInstanceId`を要求する。CLIはmutation bodyやsecret headerを送る前に、secretを送らない`GET /v1/status?nonce=...`で`runtimeInstanceId`と`HMAC-SHA256(apiSecret, nonce)` challengeを検証し、成功した場合だけdiscovery fileまたは`WITHMATE_MEMORY_API_SECRET`から取得したsecretを`X-WithMate-Memory-Api-Secret` headerで送る。app logにはruntime endpoint URLやapp-internal secretを出さず、discovery file publishの成否とaddress familyだけを記録する。V6 bootstrap後はboot diagnosticsを再取得し、fresh userDataでも`withmate-v6.db`が`foundation-ready`として見える状態にする。
CLIは毎回、process environmentに短命runtime bindingがあれば自動検証する。
bindingはprincipal / permission / current Character解決にだけ使い、Memoryのowner / scope targetはcommand引数またはinput payloadで明示する。

current raw JSON CLI:

```text
withmate-memory status
withmate-memory context
withmate-memory search --json '<MemorySearchRequest>'
withmate-memory get-entry --json '<MemoryGetEntryRequest>'
withmate-memory list-tags --json '<MemoryListTagsRequest>'
withmate-memory append --json '<MemoryAppendRequest>'
withmate-memory forget --json '<MemoryForgetRequest>'
withmate-memory search --file payload.json
```

`--json`と`--file`はrequest bodyの入力方法であり、output format指定ではない。CLI outputは常にJSONをstdoutへ出す。
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

future helper flags:

```text
withmate-memory search --project ../repo-a --query "approval modeの方針" --json
withmate-memory search --project-id <project-id> --query "approval modeの方針" --json
withmate-memory search --character current --query "呼び方の好み" --json
withmate-memory get --id <entry-id> --json
withmate-memory tags --project ../repo-a --json
withmate-memory append --project ../repo-a --input <payload.json> --json
withmate-memory forget --input <payload.json> --json
```

### Runtime Binding

WithMate内で起動したagent向けに、provider turnごとに短命runtime bindingを発行する。
WithMateはprovider process / runへopaque binding referenceを環境変数としてセットする。
agent / Skillにはbinding値を読ませず、Skill本文にも環境変数名や値の意味を書かない。
CLIだけが`--character current`やprincipal検証の実装詳細としてprocess environmentを読む。

bindingは次のlifecycleで失効する。

- turn終了
- session終了
- app終了
- 次turnのbinding発行
- provider execution invalidation

環境変数に入れる値はcredentialではなく、短命opaque referenceとする。
runtime API側はbinding reference、active session lifecycle、provider run、permission、owner / scope accessを再検証する。

providerへのbinding伝達はPhase 5 spikeで確認済み。
Codex / GitHub Copilot CLIはいずれもSDK client construction時のenvironment injectionを使う。
WithMateはprovider turnごとの`ProviderMemoryBindingRuntimeProjection`を`RunSessionTurnInput`へ渡し、adapterはbinding IDベースのsettings keyをclient cache keyに含めてturn / binding境界を分離する。
env injectionに載せるのは短命opaque referenceだけで、runtime API secretやprincipal detailは載せない。
fallbackとして`context_file` transportを型として予約するが、Codex / Copilotのcurrent strategyでは使わない。
binding transport未確認のproviderは`unsupported`として扱う。

### Target Selection

WithMate内外どちらのCLIでも、Memory targetはcallerが明示する。
CLI利用者に認証tokenやcredential管理を要求しない。
ただし、CLIは起動中のWithMate runtime Memory APIにのみ接続し、offline CLI / direct DB accessは提供しない。

project target:

- `--project <path>`
- `--project-id <id>`
- `--project-alias <alias>`

character target:

- `--character <character-id>`
- `--character current`

`--character current`はruntime bindingがある場合だけ使える。
WithMate外CLIではCharacterを暗黙解決せず、必要な場合はCharacter IDを明示する。
project targetはcurrent working directoryから暗黙推定しない。
`--project .`はcurrent directoryを使う明示指定として許可する。

appendはfirst releaseでは単一target必須とする。
searchは複数target対応を将来検討してよいが、初期実装では単一targetから始めてよい。
owner / scopeのallowlist、entry access、mutation permissionはapp service側で再検証する。

runtime bindingが必要なtargetをbinding無しで実行した場合はmachine-readable errorを返す。

```json
{
  "error": {
    "code": "MEMORY_BINDING_REQUIRED",
    "message": "current character requires a WithMate runtime binding"
  }
}
```

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

## Runtime Binding Registry

### Registry

Main Process memoryに次を保持する。

```ts
type MemoryBindingRecord = {
  bindingId: string;
  bindingReferenceHash: string;
  runId: string | null;
  sessionId: string;
  characterId: string | null;
  projectScopeId: string | null;
  providerId: string;
  permissions: MemoryPermission[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};
```

- binding reference本体はDBへ保存しない。
- binding IDは意味を持たないopaque valueにする。
- session closeだけではrunning turnが継続する可能性があるため、revoke timingはsession lifecycleと合わせる。
- app quit、session delete、provider execution invalidation時に失効させる。

current実装では`src-electron/memory-binding-registry.ts`がmain process memory内でbindingを管理する。`SessionRuntimeService`のturn開始時hookがregistryから`ProviderMemoryBindingRuntimeProjection`を作成し、provider adapterはopaque binding referenceだけをenv injectionする。`withmate-memory` CLIは`WITHMATE_MEMORY_BINDING_REFERENCE`を内部的にHTTP headerへ変換し、runtime APIは短命API secret検証後にbinding referenceをregistryでprincipalへ解決する。binding reference本体はDBへ保存せず、registry lookup用のhashだけを保持する。

失効はturn終了時の`revokeProviderMemoryBinding`、session delete時のsession単位revoke、runtime stop / app quit相当の全revokeで行う。revoke後または期限切れ後のbinding referenceはprincipalへ解決されず、Memory serviceは`MEMORY_BINDING_REQUIRED`として扱う。

### Provider Injection Strategy

providerごとの差分をadapterへ閉じる。

```ts
type MemoryBindingInjectionStrategy = {
  capability: "env" | "context_file" | "unsupported";
  buildRuntimeBinding(input: MemoryBindingInput): Promise<MemoryBindingRuntimeProjection>;
  revokeRuntimeBinding(bindingId: string): Promise<void>;
};
```

- provider SDKからprovider process / agent shell childへturnごとの環境変数を注入できるか確認する。
- current Codex / GitHub Copilot CLIは`env` injectionを使う。
- binding projectionは`src-electron/provider-memory-binding.ts`で共有し、`src-electron/session-runtime-service.ts`のoptional hookからadapterへ渡す。
- Codexは`Codex` client optionsの`env`へprojectionを重ねる。SDKが`env`指定時に`process.env`を継承しないため、WithMate側でdefined envだけをmergeする。
- GitHub Copilot CLIは`CopilotClient` optionsの`env`へprojectionを重ねる。
- どちらもbinding settings keyをprovider client/session cache keyへ含め、異なるbindingでcached provider process/sessionを再利用しない。settings keyにはbinding reference本体を含めない。
- env injection不可の場合だけsession-local context fileを検討する。
- working directoryから暗黙探索しない。
- provider runtimeがbinding非対応なら、current Characterなどruntime binding必須のcapabilityをそのproviderへ表示しない。

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
provider binding、permission、`--character current`解決、project path / alias解決はstorageへ入れず、application service層で扱う。
storageはvalidな`withmate-v6.db`だけを開き、legacy DB pathへV6 schemaを作らない。

## Application Service

Application serviceはversioned request contractとV6 storageの間に置く。
実装は`src-electron/memory-v6-service.ts`、target解決は`src-electron/memory-v6-context-resolver.ts`、permission gateは`src-electron/memory-v6-permission.ts`に分ける。

service層で扱う:

- request validation済みpayloadからstorage inputへの変換
- `memory.search` / `memory.get_entry` / `memory.list_tags` / `memory.append` / `memory.forget` / `memory.resolve_context`のresponse contract生成
- runtime principalのpermission確認
- explicit project targetのID / path / alias解決
- Character `current`のbinding context解決
- owner / scope access再検証
- storage idempotency conflictやmissing entryのmachine-readable error変換
- `memory.forget`の単一target制約を保ち、全entry resultをstorage transaction / idempotency recordへ委譲する
- target外entry IDをagent-facing responseでは`not_found`へ畳むexistence oracle防止

service層で扱わない:

- localhost server / CLI transport
- provider processへのbinding injection
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
idempotencyは`binding_id_hash / key / operation / owner / scope`をidentityに含め、別bindingの同一keyが衝突しないようにする。
`request_fingerprint`が同一idempotency identityで一致しない場合は、retryではなくconflictとして扱う。
batch forgetの再現結果は`memory_idempotency_forget_results_v6`にentryごとに保存する。
`binding_id_hash`はbinding本体ではなく短命referenceのhashだけを保存する。
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
- WithMateが管理する場合はmanaged marker / versionを持つ。
- user-created同名Skillを無断上書きしない。
- packaged CLI pathまたはshimをSkillが利用できるようにする。
- Skill updateとapp versionの互換範囲を定義する。
- Skill本文はCLI command、JSON schema、error recovery、when-to-use / when-not-to-useを説明する。
- CLIそのもののreferenceはSkill内の`reference/`配下に分ける。
- Skill本体はMemoryを使うタイミング、search / get / append / forget / tagsの判断基準、inactive entryの扱いを説明する。
- user-level `AGENTS.md`は詳細CLI仕様ではなく、WithMate Memory Skillを使うべきトリガーとhigh-level policyだけを持つ。
- `AGENTS.md`にはDB直読み禁止、Memory CLI / Skill経由の原則、append / forgetを検討する自然言語トリガーを短く書く。

## UI Policy

foundationではMemory Management Windowを戻さない。

最小UI候補:

- Settings DiagnosticsにMemory API状態
- providerごとのbinding capability
- global Skill install / version状態
- error count

full entry閲覧、manual correction、forget、restore、exportは後続UI phaseとする。

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
- provider binding unsupportedは明示的capabilityとして扱う。

## Implementation Order

1. docs / contract - 完了
2. shared types / validation - 完了
3. schema / storage - 完了
4. application service - 完了
5. localhost server - 完了
6. CLI / runtime discovery - 完了
7. app起動配線 / discovery publish / app-internal API guard - 完了
8. provider binding spike - 完了
9. providerごとのbinding connection - 前半完了
10. global Skill install / update
11. diagnostics
12. optional UI / retrieval enhancement

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

追加すべきtest:

- binding isolation
- binding revoke
- token redaction
- provider capability fallback
- Skill install collision

## Open Questions

- provider SDKからprovider process / agent shell childへturnごとの環境変数を注入できるか。
- global Skill / CLIのpackagingとupdate単位。
