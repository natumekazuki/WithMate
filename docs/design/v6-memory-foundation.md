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
- V5 Character catalog / definition / snapshotは既存V5 source of truthを優先する。
- `docs/design/memory-architecture.md`のV1〜V4 Memory / Growth記述はhistorical / legacy contextとして扱う。
- project identity detailは`docs/design/project-memory-storage.md`を参考にするが、V6 schemaの正本にはしない。
- provider runtime boundaryは`docs/design/provider-adapter.md`へ反映する。
- current保存構造は`docs/design/database-schema.md`へ反映する。

## Product Principles

1. coding agentとしての正確性とCLI parityを優先する。
2. Memoryは継続性を支えるが、作業promptを肥大化させない。
3. Character体験とMemory ownerを接続しても、Character definitionとMemory entryを混同しない。
4. Memory accessが失敗しても通常turnを壊さない。
5. delete / forget / privacyはUI表示だけでなく、search、projection、provider送信、cacheへ反映する。

## Non-Goals

foundationでは次を扱わない。

- Memoryの毎turn prompt常設注入
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

type MemoryEntry = {
  id: string;
  owner: MemoryOwnerRef;
  scope: MemoryScopeRef;
  kind: MemoryEntryKind;
  title: string;
  body: string;
  preview: string;
  state: MemoryEntryState;
  tags: MemoryTag[];
  source: MemorySource;
  supersedes: string[];
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
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
```

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
- idempotency keyはbinding / operation / owner / scopeと組み合わせて保存し、retryで同じresponseを返せるようにする。

### Forget

- agent-facing APIは`forget`とする。
- 初期実装ではhard deleteしない。
- entryを`forgotten`へ遷移し、通常searchから即時除外する。
- `privacy` reasonではentry本文を空文字へ縮退し、fingerprint / metadata / mutation eventだけを残す。
- `incorrect`、`outdated`、`user_request`、`other` reasonでは本文を保持してよいが、通常search、Skill result、provider送信には出さない。
- forgotten情報をSkill result、prompt、provider instruction、search cacheへ残さない。

### No Generic Update / Delete

初期公開しない。

- `memory.update`
- `memory.delete`
- `memory.purge`
- arbitrary patch
- arbitrary state transition

## API Contract

全request / responseはversionを持つ。

### `memory.resolve_context`

Request:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "context": { "mode": "self" }
}
```

Response:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "session": { "id": "..." },
  "character": { "id": "...", "name": "..." },
  "project": { "id": "...", "displayName": "..." },
  "permissions": ["memory.search", "memory.append"]
}
```

### `memory.search`

```ts
type MemorySearchRequest = {
  schemaVersion: "withmate-memory-v1";
  context: { mode: "self" } | ExplicitMemoryContext;
  query: string;
  domains?: Array<"project" | "character">;
  kinds?: MemoryEntryKind[];
  tags?: MemoryTag[];
  limit?: number;
  cursor?: string;
};
```

Responseはpreview中心とする。

```ts
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
  match: {
    strategy: Array<"lexical" | "tag" | "kind" | "recency">;
  };
};
```

- raw numeric trust scoreは初期契約に含めない。
- ranking internal scoreはdebug surfaceに限定する。
- forgotten / superseded entryは通常結果へ出さない。

### `memory.get_entry`

- ID指定でfull bodyを取得する。
- binding permissionとowner / scope accessを再検証する。
- searchで返したIDであっても無条件取得しない。

### `memory.list_tags`

- current contextで利用可能なactive tag catalogを返す。
- search refinementとappend時のtag reuseに使う。

### `memory.append`

```ts
type MemoryAppendRequest = {
  schemaVersion: "withmate-memory-v1";
  context: { mode: "self" } | ExplicitMemoryContext;
  owner: "character" | "project";
  scope: "character" | "project";
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

app側validation:

- length / null byte / invalid Unicode
- owner / scope allowlist
- binding permission
- referenced entry ownership
- tag normalization
- idempotency
- transaction integrity

app側で行わないこと:

- LLMによる保存価値判断
- LLMによるpreview生成
- LLMによるtag生成
- prompt-based duplicate判定

### `memory.forget`

```ts
type MemoryForgetRequest = {
  schemaVersion: "withmate-memory-v1";
  context: { mode: "self" } | ExplicitMemoryContext;
  entryIds: string[];
  reason?: "user_request" | "incorrect" | "outdated" | "privacy" | "other";
  sourceMessageId?: string;
  idempotencyKey?: string;
};
```

## CLI Contract

例:

```text
withmate-memory context --self --json
withmate-memory search --self --query "approval modeの方針" --domain project --json
withmate-memory get --self --id <entry-id> --json
withmate-memory tags --self --json
withmate-memory append --self --input <payload.json> --json
withmate-memory forget --self --input <payload.json> --json
```

### Bound Mode

次のいずれかからbindingを解決する。

- `WITHMATE_MEMORY_ENDPOINT`
- `WITHMATE_MEMORY_BINDING`
- `WITHMATE_MEMORY_CONTEXT_FILE`
- `WITHMATE_MEMORY_CLI`

実際に採用する変数はprovider spike後に固定する。

### Explicit Mode

bindingが無い通常CLIでは、`--owner`、`--scope`、認証情報の明示を要求する。

`--self`をbinding無しで実行した場合はmachine-readable errorを返す。

```json
{
  "error": {
    "code": "MEMORY_BINDING_REQUIRED",
    "message": "--self requires a WithMate session binding"
  }
}
```

## Runtime Binding

### Registry

Main Process memoryに次を保持する。

```ts
type MemoryBindingRecord = {
  bindingId: string;
  tokenHash: string;
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

- token本体はDBへ保存しない。
- binding IDは意味を持たないopaque valueにする。
- session closeだけではrunning turnが継続する可能性があるため、revoke timingはsession lifecycleと合わせる。
- app quit、session delete、provider execution invalidation時に失効させる。

### Provider Injection Strategy

providerごとの差分をadapterへ閉じる。

```ts
type MemoryBindingInjectionStrategy = {
  capability: "env" | "context_file" | "unsupported";
  buildRuntimeBinding(input: MemoryBindingInput): Promise<MemoryBindingRuntimeProjection>;
  revokeRuntimeBinding(bindingId: string): Promise<void>;
};
```

- provider SDKがchild process envを受けられるかを確認する。
- env不可の場合はsession-local context fileを検討する。
- working directoryから暗黙探索しない。
- provider runtimeがbinding非対応なら、V6 bound modeをそのproviderへ表示しない。

## Localhost Transport Security

- `127.0.0.1` / `::1`のみlistenする。
- LAN interfaceへbindしない。
- binding tokenは十分なrandomnessを持つ。
- tokenはAuthorization headerまたは同等の専用headerで送る。
- URL queryへtokenを載せない。
- token、context file内容、endpoint secretをaudit / app logへ出さない。
- request body size、rate、concurrencyを制限する。
- state-changing requestはidempotency keyを受けられるようにする。
- bindingごとにpermissionとowner / scope accessを検証する。
- app shutdownでserverを停止する。

## Storage

既存legacy tableをV6の正本として意味変更しない。V6用tableを新設する。

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
  source_message_id TEXT,
  source_provider_id TEXT,
  superseded_by_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  forgotten_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_entry_tags_v6 (
  entry_id TEXT NOT NULL REFERENCES memory_entries_v6(id) ON DELETE CASCADE,
  tag_type TEXT NOT NULL,
  tag_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag_type, tag_value)
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
  description TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tag_type, tag_value)
);

CREATE TABLE IF NOT EXISTS memory_mutation_events_v6 (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  entry_id TEXT,
  binding_id_hash TEXT,
  session_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_idempotency_keys_v6 (
  key TEXT NOT NULL,
  operation TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  response_entry_id TEXT,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, operation, owner_type, owner_id, scope_type, scope_id)
);
```

実装時にtable名へversion suffixを付けるかはmigration方針と合わせて決める。重要なのはlegacy tableとの意味分離である。

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

後続で次を設計する。

1. read-only legacy viewer
2. import preview
3. explicit migration
4. source / confidence / legacy marker

## Failure Policy

- Memory unavailableでも通常turnは継続可能。
- CLIはnon-zero exit codeとJSON errorを返す。
- unauthorizedとnot foundを区別する。
- app側timeoutは短くboundedにする。
- append / forgetはtransactionalにする。
- duplicate retryで二重writeしない。
- provider binding unsupportedは明示的capabilityとして扱う。

## Implementation Order

1. docs / contract
2. shared types / validation
3. schema / storage
4. application service
5. localhost server
6. CLI
7. provider binding spike
8. providerごとのbinding connection
9. global Skill install / update
10. diagnostics
11. optional UI / retrieval enhancement

## Docs To Update

- `docs/design/documentation-map.md`
- `docs/design/memory-architecture.md`
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

追加すべきtest:

- contract validation
- append idempotency
- supersede transaction
- forget exclusion
- permission denial
- binding isolation
- binding revoke
- token redaction
- localhost non-loopback rejection
- provider capability fallback
- Skill install collision
- legacy table non-mutation

## Open Questions

- Session working stateをfoundationに含めるか。
- provider SDKからCLI child processへenvを渡せるか。
- global Skill / CLIのpackagingとupdate単位。
- explicit modeをfirst releaseで公開するか。
- project scopeの既存table再利用範囲。
