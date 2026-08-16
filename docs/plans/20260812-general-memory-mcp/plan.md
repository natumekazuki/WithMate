# 一般 Memory MCP 公開計画

## 目的と完了条件

既存の `withmate-character-context` stdio MCP serverへ一般 Memoryを `memory.*` namespaceで追加する。CLIとMCPは同じMemory V6 runtime endpointへ接続し、既存のCharacter系6 toolの名前と観測可能なcontractを維持する。

完了には、一般Memoryのread、write、destructive、protected object操作を完全なMCP input/output schemaとannotationで公開し、CLIとのcross-readback、target解決、authority拒否、retryとresponse loss、配布artifactを直接検証する必要がある。CLIの全commandは、MCP公開、既存MCPで代替、operatorまたは診断専用のいずれかへ分類してrunbookへ残す。

## Pre-Implementation Closure Plan

Gate status: `ready`

Unresolved contract decisions: なし。

### Closure Map

- Accepted contract / exact anchor:
  - ユーザー要求「一般Memoryを既存MCP serverへ公開する」の決定済み境界、必要tool範囲、受け入れ条件。
  - `docs/adr/020-memory-affect-mcp-application-boundary.md` の単一server、兄弟adapter、MCP専用credentialとroute allowlist、完全schema、annotation、response loss時のeffect certainty。
  - `src/memory-v6/memory-contract.ts`、`src/memory-v6/memory-validation.ts`、`src/memory-v6/memory-response-contract.ts` のMemory V1 request、validation、success/error projection。
  - `src-electron/memory-v6-http-server.ts` と `src-electron/memory-v6-service.ts` のroute、permission、target解決、transaction、protected object境界。
- Supported scope:
  - 新規toolは `memory.search`、`memory.get_entry`、`memory.list_targets`、`memory.list_entries`、`memory.list_tags`、`memory.append`、`memory.forget`、`memory.move_entry`、`memory.get_file`、`memory.export_files`、`memory.file_usage`。
  - targetはproject、user-global、character、character+projectの明示selectorを使う。project pathとproject IDは既存resolverで同じcanonical project IDへ収束する。
  - `memory.append`はMCPでidempotency keyを必須とする。`memory.forget`はreasonとidempotency keyを必須とし、dry-runを同じtoolで公開する。`memory.move_entry`はidempotency keyを必須とする。
  - protected objectのappend input、単一export、entry一括export、usageを既存service境界のまま公開する。export先は絶対path、既存file非上書き、target照合、quotaとatomic appendを維持する。
- Excluded scope:
  - `status`、`schema`、`validate`はMCP handshake、`tools/list`、tool schema validationで代替する。
  - `audit`、Character catalog、Affect inspect/correct/reset、metrics、migration、repair相当の運用操作はoperatorまたは診断専用として一般 `memory.*` へ公開しない。
  - SQLite直接参照、CLI subprocess、caller指定authority、別MCP server、`project_memory.*` namespaceは追加しない。
- Invariant IDs / canonical owners:
  - `GMCP-API`: tool名、完全schema、annotation、success/error projectionは `scripts/withmate-memory-mcp.ts` がMCP adapterとして所有し、Memory V1 contractを再解釈しない。
  - `GMCP-TARGET`: explicit target、path/ID canonicalization、owner/scope accessはMemory V6 validation、resolver、serviceが所有する。
  - `GMCP-AUTH`: MCP credential、route allowlist、destructive invocation authorityはruntime HTTP application boundaryが所有し、CLI operator credentialと混ぜない。
  - `GMCP-EFFECT`: idempotency、transaction、dry-run、replay、response loss後のeffect certaintyはservice/runtime exchangeとadapter error projectionが共同で所有する。
  - `GMCP-FILE`: protected objectのinput inspection、quota、atomic append、target照合、non-overwrite export、長時間timeoutはMemory V6 serviceとprotected object adapterが所有する。
- Sibling channels: general CLI、一般 `memory.*` MCP、既存 `character_memory.*`、`character_context.*`、`character_affect.*`、internal HTTP runtime route、配布済みbundle。
- State / operation sequences:
  - read: validate → MCP credential/allowlist → target resolve → service read → bounded public projection。
  - write: validate → credential/allowlist → target resolve → idempotency preflight → transaction/side effect → response。response loss後は同一request/keyでreconcileする。
  - destructive: dry-runまたは明示tool invocation → reason/target/idempotency検証 → mutation → read-back可能なpublic result。
  - protected object: target/path検証 → inspect/quota → prepare → atomic metadata commit。exportはtarget照合後に新規outputだけを作る。
- Major failure modes / consumer impacts / direct verifications:
  - schema漏れまたは既存6 toolのcontract変更: `tools/list` contract testでtool順、input/output schema、annotation、authority field不在を直接検証する。
  - unknown target、別owner、invalid tupleの迂回: runtime/service integration testでMemory domain error codeと無変更を検証する。
  - project pathとIDの分裂: 同一runtimeでpath appendとID read、ID appendとpath readをcross-readbackする。
  - MCP credentialのoperator route到達: HTTP security testでallowlist外routeを`MEMORY_FORBIDDEN`とし、公開routeだけ成功させる。
  - replayまたはresponse lossを新規commitと誤認:同じidempotency keyのMCP/CLI retryと、dispatch前 `effect: none`、dispatch後write `effect: unknown`、read `effect: none`を検証する。
  - dry-run、reason、protected境界の弱体化: forget dry-runの無変更、reason必須、move target保持、file target/path/non-overwrite/timeoutをserviceとMCP testで検証する。
  - 配布bundleだけでtool欠落: 分離temp directoryへbundleを生成し、stdio `tools/list` と代表read/writeを実runtimeへ接続してsmokeする。
- ADR / architecture gate: required。ADR 020へ `memory.*` namespace、公開tool範囲、operator除外の理由を追記する。新しい独立判断ではなく、ADR 020のapplication boundaryを一般Memoryへ具体化するため同ADRを更新する。
- Architecture document gate: 新規文書は不要。利用・運用contractはrunbookとmanaged Skillへ置き、sourceから復元できるAPI詳細は重複させない。
- Selected trigger matrices: Explicit Input / Authority / Capability、Public API / Validation / Projection、Coupled Invariant / Versioned Selection、Mutation / External Side Effect、Owner / Scope / Projection、Limit / Concurrency / Resource、Process / Resource Lifecycle。
- Not selected: Migration / Repair / Existing Dataはschemaや保存形式を変更しないため対象外。Reactive State / Cache / Async UIはUI stateを変更しないため対象外。

### Invariant Matrix

| Invariant ID | Sibling channel | Coupled values | State / evidence order | Failure mode / timing | Consumer impact / public projection | Owner / effect certainty | Direct verification / executable anchor | Cell status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GMCP-API` | `tools/list`、既存Character 6 tool、新規general 11 tool | namespace、name、required/optional、default、annotation、success/error | register → list → invoke | schema欠落、unknown field通過、既存contract drift | clientが誤入力またはerrorをsuccess扱いする | MCP adapter。readは`none` | `scripts/tests/withmate-memory-mcp.test.ts` の完全schema/annotation検査 | verified |
| `GMCP-TARGET` | search/get/list/append/forget/move/file | owner、scope、project path/ID、character ID、entry/object ID | validate → resolve → access → operation | unknown target、path/ID分裂、from/to mismatch、別target entry取得 | 誤project読取、not found、cross-owner mutation | validation/resolver/service。失敗は`effect: none` | runtime/service cross-readbackとtarget/error integration test | verified |
| `GMCP-AUTH` | read、bounded write、destructive、operator/diagnostic route | adapter credential、route allowlist、tool invocation、permission | runtime challenge → adapter認証 → allowlist → service permission | MCP secretでaudit/Affect operator routeへ到達、caller authority昇格 | auth bypass、意図しない破壊操作 | HTTP application boundary。拒否は`effect: none` | HTTP server security testとMCP request schemaのauthority field不在 | verified |
| `GMCP-EFFECT` | append、forget dry-run/write、move、response loss retry | request fingerprint、idempotency key、target、reason、dryRun、dispatch state | validate → preflight → commit → response/retry | key再利用競合、replayを新規save扱い、commit後response loss | duplicate、誤った成功表示、状態不明の上書き | storage/service/runtime adapter。none/committed/unknownを区別 | MCP/CLI cross-readback、replay/conflict、pre/post-dispatch failure test | verified |
| `GMCP-FILE` | append files、get_file、export_files、file_usage | target、object/entry、absolute output、quota、timeout | validate → target → inspect/export → commit/result | unauthorized read、上書き、partial text append、通常timeout誤適用 | private file露出、data loss、曖昧なappend | protected object/service。append response lossとexport I/O failureは`unknown`、検証・target拒否は`none` | service/file tests、HTTP timeout test、MCP schema/route test | verified |
| `GMCP-DIST` | source MCP、generated bundle、managed Skill/runbook/provider instruction | tool set、server identity/version、fallback rule | build → isolated launch → list/invoke | sourceのみ動作し配布artifact欠落、domain errorでCLI fallback | installed clientで利用不能またはauthority迂回 | build artifactとshared runtime client | temp directory distribution smoke、Skill contract test | verified |

## 実装sliceと検証

- Slice 1: shared runtime error projection、MCP専用route allowlist、一般tool schema/registration。`GMCP-API`、`GMCP-AUTH`、`GMCP-EFFECT`を対象とする。
- Slice 2: MCP/runtime/cross-readback/security/file operationのexecutable contract。Slice 1に依存する。
- Slice 3: ADR 020、runbook、managed Skill、provider instruction、CLI対応表。確定した公開surfaceに依存する。
- Slice 4: targeted test、integration/security test、distribution smoke、`npm run typecheck`、`npm run build`。完了candidateを凍結し、triggerされたlensで独立reviewを行う。

Full-review gateは現時点で `run` を予定する。public API、authority、外部file side effect、複数adapterとdistribution artifactをまたぎ、targeted checkだけではcomplete diffのcross-cutting contractを一度に反証できないためである。holistic complete-diff reviewは一回だけ実施する。

## Pre-review Evidence Ledger

- Targeted/integration/security: `npx tsx --test scripts/tests/withmate-memory-mcp.test.ts scripts/tests/withmate-memory-cli.test.ts scripts/tests/memory-v6-http-server.test.ts scripts/tests/memory-v6-runtime.test.ts scripts/tests/withmate-memory-mcp-integration.test.ts` — 89 passed、1 platform skip、0 failed。
- Full regression: `npm test` — 2332 passed、1 platform skip、0 failed。
- Type contract: `npm run typecheck` — Green。
- Distribution/build: `npm run build` — Green。既存のCSS `::highlight` とchunk-size warningのみ。
- Diff hygiene: `git diff --check` — errorなし。改行コード変換warningのみ。
- Structure convergence gate: `no-topology-evidence`。一般MCP schema/registrationは専用adapter module、route authorityはHTTP application boundary、effect/replayは既存runtime/service/storage ownerへ配置され、semantic ownerの分散やcanonical boundary迂回を示す具体的evidenceはない。
- Full-review gate: `run`。`GMCP-API`、`GMCP-AUTH`、`GMCP-EFFECT`、`GMCP-FILE`がpublic API、credential境界、外部file side effectを横断するため、現Candidateに対するspecialist review後、complete diffを一度だけholistic reviewする。

## C1 Specialist Finding Promotion

- `GMCP-TARGET / unknown Character`: accepted contractとの関係とproduction runtimeの到達性が確認できるため`blocking / current-scope repair`。runtime compositionで保存済みCharacter catalogをresolverへ接続し、unknown Characterを副作用前に拒否する。
- `GMCP-API / schema-validation drift`: `tools/list`の完全schema契約に対し、空states、sampleLimit依存、absolute path制約の欠落が確認できるため`blocking / current-scope repair`。MCP schemaとschema contract testをcanonical validationへ揃える。
- `GMCP-EFFECT / GMCP-FILE / concurrent replay cleanup`: 同一keyの並行file appendで後続prepared objectが孤立する到達性が確認できるため`blocking / current-scope repair`。storageがreplayを返したrequestの非canonical prepared objectを破棄し、並行回帰testで閉じる。
- 3件とも既存Invariant ID、semantic owner、supported scope内の修正であり、新しいboundary prerequisiteやhardening follow-upではない。C1はsource修正により失効し、修正後Candidateへdirect checkとfinding family限定のtargeted closureを引き継ぐ。

## Holistic Review Finding Promotion

- C3に対する一度だけのholistic complete-diff reviewで、archive済みCharacter targetがactive catalogから消えて到達不能になる`GMCP-TARGET`違反と、prepare/storage失敗後のcleanup failureを`effect: none`とする`GMCP-EFFECT / GMCP-FILE`違反を確認した。
- どちらもaccepted contract、production到達性、consumer影響、既存semantic ownerが確定しているため`blocking / current-scope repair`。新しいpublic contract、owner、subsystemを追加せず、Character identity resolverとprotected-object cleanup settlementを修正する。
- Holistic review entryはC3のimmutableな発見記録とし、修正後Candidateへcurrent evidenceとして再関連付けしない。complete diffの二度目の探索reviewは行わず、C4のdirect checkと2 finding familyのtargeted closureだけで閉じる。

## C4後続Finding Closure Plan

Gate status: `ready`

Unresolved contract decisions: なし。

### Finding Promotion

- `GMCP-EFFECT / GMCP-FILE / generic storage failureとcleanup failureの重複`: file付きappendのDB処理が通常のSQLite I/O errorで失敗し、prepared objectの破棄も失敗する経路はproductionで到達可能である。既知domain errorへ投影できない元errorでも、orphan objectが残った事実を`MEMORY_FILE_CLEANUP_FAILED`、`effect: partial`として返すaccepted contractに違反するため、`blocking / current-scope repair`とする。
- `GMCP-API / GMCP-EFFECT / discovery failure projection`: 不正な明示runtime URLでdiscoveryがthrowする経路はCharacterと一般Memoryの兄弟adapterから到達可能である。公開済みoutput schemaを満たすstructured errorとdispatch前の`effect: none`を失うため、`blocking / current-scope repair`とする。
- `GMCP-API / list-tags limit drift`: Memory V1 validationが許可する`sampleLimit: 50`をMCP adapterだけが20で拒否する。adapterがcanonical request contractを狭めるため、`blocking / current-scope repair`とする。
- 3件とも既存semantic ownerとsupported scope内で閉じられる。新しいpublic contract、authority、storage owner、subsystemを必要としないため、`boundary prerequisite`または`hardening follow-up`へ分離しない。

### Closure Map delta

- Accepted contract / exact anchor:
  - `src/memory-v6/memory-validation.ts` のMemory V1 validation上限と、`scripts/withmate-memory-mcp.ts` がMemory V1 contractを再解釈しないという `GMCP-API`。
  - `docs/adr/020-memory-affect-mcp-application-boundary.md` のstructured error、dispatch前後のeffect certainty、Character 6 tool contract維持。
  - protected object prepare後のcommit failureとcleanup failureを区別し、cleanup未完了を`effect: partial`として投影する `GMCP-EFFECT / GMCP-FILE`。
- Supported scope: `MemoryV6Service.append`のprepared object cleanup settlement、Character/general MCP runtime discovery、`memory.list_tags` input schema。
- Excluded scope: runtime discovery implementation自体、SQLite error分類の一般化、他のMemory request limit、operator route、二度目のholistic complete-diff review。
- Sibling Sweep:
  - storage error projectionを使うappend/forget/moveのうち、prepared object cleanupを伴うappendだけがcleanup settlementの対象。
  - runtime discoveryを共有する既存Character 6 toolと一般Memory 11 toolを同じpre-dispatch structured error contractで確認する。
  - Memory V1の50件上限を使う一般MCP query schemaを確認し、`list_tags.sampleLimit`だけの狭窄であることを検証する。
- Direct verification:
  - generic DB errorとcleanup failureを同時に注入するservice regression testで、`MEMORY_FILE_CLEANUP_FAILED`、`effect: partial`、`originalCode: MEMORY_STORAGE_UNAVAILABLE`を直接確認する。
  - 不正な明示URLからCharacter readとgeneral writeを呼び、各公開output schemaを満たすstructured error、`retryable: true`、dispatch前`effect: none`をMCP client境界で確認する。
  - `tools/list`の`memory.list_tags.sampleLimit.maximum`と、`sampleLimit: 50`がruntime routeへ到達することを確認する。

### Invariant Matrix delta

| Invariant ID | Sibling channel | Coupled values | State / evidence order | Failure mode / timing | Consumer impact / public projection | Owner / effect certainty | Direct verification / executable anchor | Cell status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GMCP-EFFECT / GMCP-FILE` | file付きappend | generic DB error、prepared object、cleanup result | prepare → DB failure → cleanup failure → public error | 元errorのdomain projectionがcleanup error生成前にrethrow | orphan objectが残るのにpartial effectを観測できない | Memory V6 service。cleanup未完了は`partial` | `scripts/tests/memory-v6-service.test.ts` のgeneric storage failure回帰test | covered |
| `GMCP-API / GMCP-EFFECT` | Character 6 tool、general 11 tool | explicit URL、discovery result、operation kind、dispatch state | discover → dispatch → response | discovery throwがtool handler外へ漏れる | output schema、retryable、effect certaintyを失う | MCP adapter。dispatch前は`none` | `scripts/tests/withmate-memory-mcp.test.ts` の兄弟tool discovery failure test | covered |
| `GMCP-API` | `memory.list_tags` | `withCounts: true`、`sampleLimit: 50` | tools/list → validate → runtime dispatch | adapter上限20でcanonical requestを拒否 | 正当なMemory V1 requestがMCPだけ利用不能 | Memory V1 contractとMCP schema | tools/list maximum検査とruntime route到達test | covered |

### C4後続Finding Direct Evidence

- 修正前再現: service/MCP targeted testはgeneric DBとcleanupの重複失敗、`sampleLimit: 50`、不正な明示runtime URLの4 assertionでRedになった。
- Targeted/integration/security: 133 tests中132 passed、1 platform skip、0 failed。
- Full regression: 2341 tests中2340 passed、1 platform skip、0 failed。
- Type contract: `npm run typecheck`はGreen。
- Distribution/build: `npm run build`はGreen。既存のCSS `::highlight` とchunk-size warningのみ。
- Diff hygiene: `git diff --check`はerrorなし。改行コード変換warningのみ。

Full-review gateは既存論理変更の`run`を維持し、C3でholistic complete-diff reviewを一度実施済みである。今回のcurrent-scope repair後は新Candidateのdirect check、finding family限定のtargeted closure、影響するspecialist cellの現行証拠で閉じ、complete diffの探索reviewを再実行しない。

## C7追加Finding Closure Plan

Gate status: `ready`

Unresolved contract decisions: なし。

### Finding Promotion

- `GMCP-TARGET / relative project path`: CLIとMemory V1利用手順が要求する絶対project pathをMCP schemaと共有validationが受理し、runtime processのcurrent working directoryへ解決する経路はproductionで到達可能である。別project scopeへのread/writeを許すため、`blocking / current-scope repair`とする。
- `GMCP-TARGET / read and dry-run inventory mutation`: path targetを解決するread、file read、forget dry-runがproject inventoryを作成または更新する経路はproductionで到達可能である。read-only annotationおよび`writeOccurred: false`と永続化結果が矛盾するため、`blocking / current-scope repair`とする。
- `GMCP-EFFECT / structured error certainty`: runtimeが返すstructured domain errorにeffectがない場合、target、authority、validation拒否の`none`と、write処理中のinternal failureの`unknown`をadapterが区別できない。安全なretryと照合判断を失うため、`blocking / current-scope repair`とする。
- `GMCP-EFFECT / forget dry-run response loss`: MCPとCLIが`dryRun: true`をwriteとして分類し、response lossを`unknown`へ投影する経路はproductionで到達可能である。Memory mutationが起きない契約と矛盾するため、`blocking / current-scope repair`とする。
- 4件とも既存の`GMCP-TARGET`、`GMCP-EFFECT`、Memory V1 validation、project resolver、共有runtime clientのsemantic ownerとsupported scope内で閉じられる。新しいpublic contract、authority、storage subsystemは追加しない。

### Closure Map delta

- Accepted contract / exact anchor:
  - `src/memory-v6/memory-validation.ts` とCLI利用手順のproject pathは絶対pathであり、adapterがprocess cwdを暗黙targetへ使わない。
  - read-only operationとforget dry-runはMemory entryだけでなくproject inventoryを含む永続状態を変更しない。actual writeだけが未登録project scopeを作成できる。
  - `docs/adr/020-memory-affect-mcp-application-boundary.md` のstructured errorとeffect certaintyに従い、拒否またはdispatch前failureは`none`、write dispatch後に結果を確定できないfailureは`unknown`、既存の明示effectは保持する。
- Supported scope: project target validation、Memory V6 serviceのproject path resolver選択、MCP/CLIのforget dry-run operation classification、共有runtime HTTP error projection。
- Excluded scope: project identity生成方式、既存project inventory migration、operator repair、HTTP service error code体系の再設計、二度目のholistic complete-diff review。
- Sibling Sweep:
  - project pathを受けるproject、character+project selectorをsearch/get/list/list-tags/append/forget/move/file operationで確認する。
  - read系全入口とforget dry-runはknown-only resolver、append、forget実行、move destinationはcreating resolverを使う。move sourceはknown-onlyとする。
  - MCPとCLIのresponse-loss classificationを同じdry-run判定へ揃える。
  - structured domain errorはread/write、4xx/5xx、既存effect有無の組を共有runtime clientで確認する。
- Direct verification:
  - shared validationと`tools/list` schemaでrelative project pathを拒否し、絶対pathをruntimeへ通す。
  - fresh DBでreadとforget dry-run後のproject inventoryが0のまま、append後だけ1になることをservice testで確認する。
  - structured 4xx errorはread/writeとも`effect: none`、structured 5xx internal errorはreadで`none`、writeで`unknown`、既存`partial`は保持することをruntime client testで確認する。
  - forget dry-runのdispatch後response lossをMCPとCLIで`effect: none`、実行時を`unknown`として確認する。

### Invariant Matrix delta

| Invariant ID | Sibling channel | Coupled values | State / evidence order | Failure mode / timing | Consumer impact / public projection | Owner / effect certainty | Direct verification / executable anchor | Cell status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GMCP-TARGET` | project、character+project selector | path kind、absolute path、process cwd、canonical project ID | schema → shared validation → resolve → access | relative pathをcwd基準で別projectへ解決 | 誤targetのread/write、owner scope混同 | Memory V1 validationとMCP schema。拒否は`none` | contract testとMCP tools/list/invocation test | planned |
| `GMCP-TARGET / GMCP-EFFECT` | read、file read、forget dry-run、append、forget write、move | operation kind、dryRun、source/destination、known/create resolver、inventory row | validate → resolve-known/create → operation → response | readまたはdry-runがscope rowをINSERT/UPDATE | read-only契約違反、`writeOccurred: false`との矛盾 | service/resolver。read/dry-runは永続effect `none` | fresh DB inventory regression test | planned |
| `GMCP-EFFECT` | runtime HTTP → CLI/MCP | operation kind、HTTP status、structured error、existing effect | dispatch → HTTP response → normalize → public error | effect欠落をそのまま返す | retry可否とread-back要否を判断不能 | shared runtime client。4xx拒否`none`、write 5xx不確定`unknown`、明示effect保持 | runtime client projection test | planned |
| `GMCP-EFFECT` | MCP/CLI forget | dryRun、dispatch state、response loss | parse → classify → dispatch → loss projection | dry-runをwrite扱い | mutation不能なのに`unknown` | sibling adapters。dry-runはread相当`none` | MCP/CLI response-loss regression test | planned |

Full-review gateは既存論理変更の`run`を維持し、holistic complete-diff reviewはC3で一度実施済みである。C7はdirect checkとtriggerされた`GMCP-TARGET`、`GMCP-EFFECT` cellのtargeted closureだけで閉じ、complete diffを再探索しない。

## C8追加Finding Closure Plan

Gate status: `ready`

Unresolved contract decisions: なし。

### Pre-Implementation Closure Plan

- Invariant ID: `GMCP-FILE-RETRY`
  - Accepted contract / exact anchor: file付きappendのidempotent retryは、commit済みentryだけでなく未完了のprepared-object cleanupも同じoperation結果として再通知する。`effect: partial`を受信できなかったretryを成功へ昇格させない。
  - Scope / semantic owner: `memory_idempotency_keys_v6`、Memory V6 storageのappend replay、serviceのprepared-object cleanup settlement。
  - Failure mode / consumer impact: redundant object cleanup failure後のresponse lossで、orphanが残るのにretryが成功となりoperator GC要否を失う。
  - State transitions / failure timing: append commit → replay側prepared object生成 → cleanup-required永続化 → cleanup試行 →成功時clear／失敗時partial維持 → response loss／retry／restart。
  - Direct verification: cleanup failure後の同一key retryとstorage再open後retryが`MEMORY_FILE_CLEANUP_FAILED`、`effect: partial`を維持し、cleanup成功時は通常replayになることをservice/storage testで確認する。
  - Independent review trigger: 永続化、response loss、retryをまたぐため`targeted_reviewer`で`GMCP-FILE-RETRY`を反証する。
  - Gate: `ready`
- Invariant ID: `GMCP-TAG-PAGE`
  - Accepted contract / exact anchor: 公開`memory.list_tags`はMemory V1 canonical request/responseで総処理量と応答件数をbounded paginationとして表現し、adapter独自制限にしない。
  - Scope / semantic owner: Memory V1 request/response/validation、Memory V6 storage query、service、MCP schema、CLI/runtime projection。
  - Failure mode / consumer impact: tag総数を全件同期読込し、counts時にtag数分の同期SQLを実行してElectron mainとMCP responseを無制限に占有する。
  - State transitions / failure timing: validate limit/cursor → resolved target read → SQL limit+1 page → bounded sample query → tags/nextCursor response。
  - Direct verification: canonical validation、tools/list schema、複数pageの重複なし走査、各page上限、counts sample上限、runtime route projectionをcontract/storage/service/MCP testで確認する。
  - Independent review trigger: public APIとresource limitを変更するため`targeted_reviewer`で`GMCP-TAG-PAGE`を反証する。
  - Gate: `ready`
- Invariant ID: `GMCP-FORGET-SOURCE`
  - Accepted contract / exact anchor: 公開`sourceMessageId`はforget request identityの一部であり、同じidempotency keyで値だけが変わればconflictになる。実mutationの監査帰属へ同じ値を保存する。
  - Scope / semantic owner: Memory V1 forget validation、service fingerprint、storage idempotency、`memory_mutation_events_v6`。
  - Failure mode / consumer impact: sourceだけ異なるrequestがreplayとなり、どのmessageに基づくforgetか監査から失われる。
  - State transitions / failure timing: validate tuple → fingerprint → idempotency preflight → mutation event commit → replay/conflict。
  - Direct verification: sourceMessageId変更時のconflict、同値retry、mutation eventのsource read-back、dry-run無変更をservice/storage testで確認する。
  - Independent review trigger: idempotency tupleとaudit永続化を変更するため`targeted_reviewer`で`GMCP-FORGET-SOURCE`を反証する。
  - Gate: `ready`
- Invariant ID: `GMCP-CHAR-ID`
  - Accepted contract / exact anchor: Memory target identityのID/name解決はactive/archiveを含むDB catalogを正本とし、Character definitionやnotes fileの可用性に依存しない。
  - Scope / semantic owner: Electron runtime compositionの`resolveCharacterById`と既存Character catalog API。
  - Failure mode / consumer impact: 保存済みCharacterの補助file欠損がMemory read/forgetを500にし、永続identityへ到達不能になる。
  - State transitions / failure timing: runtime request → catalog lookup → target resolution → permission／Memory operation。definition fileはruntime snapshot生成時だけ読む。
  - Direct verification: definition file欠損かつarchive済みcatalog rowをresolverが解決し、unknown IDは拒否するcomposition-level testで確認する。
  - Independent review trigger: target owner identity境界を変更するため`targeted_reviewer`で`GMCP-CHAR-ID`を反証する。
  - Gate: `ready`

### Closure Map

- `GMCP-FILE-RETRY`: public append、concurrent replay、restart retry、cleanup success/failure、partial error、idempotency schemaを対象とする。operator GC実装と一般repair routeは別ownerのため除外する。
- `GMCP-TAG-PAGE`: MCP、CLI raw request、runtime route、service、storageのlist-tagsだけを対象とする。searchのrelated-tag rankingは公開list-tags paginationのconsumerではないため除外する。
- `GMCP-FORGET-SOURCE`: forget dry-run/write、same-key replay/conflict、mutation event projectionを対象とする。appendは既にsourceをfingerprintとentry sourceへ保存し、moveはfingerprintへ含めているためsource fieldの同じ欠落はない。
- `GMCP-CHAR-ID`: active/archive/unknown IDと補助file欠損を対象とする。Character runtime snapshotやauthoringはdefinition本文を必要とする別capabilityのため変更しない。

Full-review gateはC3で一度実施済みのため再実行しない。C8は各Invariantのdirect checkと、現Candidateに対するtriggered targeted reviewで閉じる。

### C8 Direct Evidence

- `GMCP-FILE-RETRY`: 同時file appendのreplay側cleanup failure後、`cleanup_pending_count = 1`の永続read-back、別storage instanceからのreplay state、同一key retryの`MEMORY_FILE_CLEANUP_FAILED / effect: partial`をservice testで確認した。replay検出とcleanup obligationの加算は同じstorage transaction内で行う。
- `GMCP-TAG-PAGE`: Memory V1 validation、service、storage、MCP `tools/list`で`limit <= 200`、cursor、`nextCursor`、`sampleLimit <= 50`を確認し、5 tagsをlimit 2で重複なく3 pageへ列挙した。
- `GMCP-FORGET-SOURCE`: 同値retry、`sourceMessageId`だけが異なる同一key conflict、`memory_mutation_events_v6.source_message_id`のread-back、既存schemaへのadditive column追加を確認した。
- `GMCP-CHAR-ID`: archive済みCharacterの`character.md`を削除してもDB catalog entryを取得でき、runtime snapshotだけがnullになることを確認した。production runtime compositionはこのcatalog APIでID/nameを解決する。
- Targeted/integration/security: 226 tests中225 passed、1 platform skip、0 failed。
- Full regression: 2347 tests中2346 passed、1 platform skip、0 failed。
- Type contract: `npm run typecheck`はGreen。
- Distribution/build: `npm run build:memory-cli`と`npm run build`はGreen。分離temp directoryのdistribution smokeで`tools/list`と代表read/writeを確認した。build warningは既存のCSS `::highlight` とchunk-size warningのみ。
- Diff hygiene: `git diff --check`はerrorなし。改行コード変換warningのみ。

### C8 Invariant Matrix Result

| Invariant ID | Read | Write / destructive | Target kind | Success / structured error | Retry / response loss | Direct evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `GMCP-FILE-RETRY` | replay preflight | file append、prepared-object cleanup | project / user-global / characterのcanonical resolved target | cleanup済みはreplay success、未完了は`MEMORY_FILE_CLEANUP_FAILED / partial` | cleanup-requiredを永続化しretry/restartでpartialを維持 | service/storage/schema tests | covered |
| `GMCP-TAG-PAGE` | bounded list-tags | なし | explicit project / user-global / character | `tags`と任意`nextCursor`、invalid limit/cursorはstructured validation error | 同条件とcursorで継続 | contract/storage/service/MCP/integration tests | covered |
| `GMCP-FORGET-SOURCE` | dry-run preflight | forget | explicit canonical target | 同tupleはreplay、sourceだけ異なるtupleはconflict | response loss後もsourceを含むfingerprintで照合 | service/storage/schema tests | covered |
| `GMCP-CHAR-ID` | search/get/list/file/usage | append/forget/move | active/archive Character ID | DB catalogにあれば解決、unknown IDはtarget error | 補助file欠損をavailability failureへ変換しない | character storage/runtime resolver tests | covered |

### C8 Targeted Review Finding Promotion

- `GMCP-FILE-RETRY / aggregate cleanup obligation`: originalと複数replayが並行し、cleanupの成功と失敗が混在すると、成功側が共有booleanをclearして失敗側の未完了cleanupまで消す経路はproductionで到達可能である。partial response loss後のretryが成功へ化けるため`blocking / current-scope repair`とし、attemptごとのpending countへ変更する。
- `GMCP-TAG-PAGE / aggregate-before-limit`: tag assignment全体を`GROUP BY`した後の`LIMIT`は応答件数だけを制限し、Electron mainの同期処理量を制限しない。accepted resource boundへ違反するため`blocking / current-scope repair`とし、write transactionでtarget別tag aggregateを維持してindexed pageを先に確定する。
- `GMCP-TAG-PAGE / malformed cursor`: 任意text cursorをstorageがoffset 0へ変換するとinvalid inputが先頭pageの成功になる。structured validation error契約へ違反するため`blocking / current-scope repair`とし、canonical cursor decoderを共有validationへ置いてstorage fallbackを削除する。
- `GMCP-TAG-PAGE / deep cursor range`: 複合`OR` predicateではSQLiteがcursor tupleをindex range開始点に使わず、深いpageほど既出tagを走査する。accepted resource boundへ違反するため`blocking / current-scope repair`とし、4つの具体的なindex rangeを各`limit + 1`でcapしてbounded mergeする。
- `GMCP-TAG-PAGE / semantic cursor canonicality`: 形式だけ似た非ISO timestamp、非canonical tag、非canonical percent encodingをdecoderが受理する。canonical structured validation契約へ違反するため`blocking / current-scope repair`とし、timestamp、tag canonicalization、encode/decode round-tripを検証する。
- `GMCP-FORGET-SOURCE`と`GMCP-CHAR-ID`にはblocking findingなし。3件は既存Invariant familyとsemantic owner内の修正であり、新しい探索reviewや二度目のholistic reviewへ広げない。

### C8 Targeted Closure Delta

- cleanup obligationは`cleanup_pending_count`としてreplay検出transaction内で加算し、各cleanup成功だけが1件を減算する。3並行で成功・失敗が混在する回帰testと別storage instanceのread-backで未完了countを確認する。
- list-tagsはtargetを1件に限定し、`memory_target_tag_stats_v6`をappend/supersede/forget/moveと同じtransactionで維持する。公開readはtarget/order indexから`limit + 1`だけをkeyset pageし、count順・最新更新順・canonical tag順をcursorへ含める。
- malformed cursor、複数target、別形式cursorはcanonical validationでdomain errorにし、MCP adapter独自の意味validationにはしない。HTTP service境界で`MEMORY_INVALID_FIELD / effect: none`を確認する。
- cursor付きtag pageは4つのindex rangeをそれぞれ`limit + 1`に制限してmergeし、深いcursorでも既出prefix全体を走査しない。query planで`usage_count<?`をrange条件として使用することを確認する。
- list-tags cursorはcanonical ISO timestamp、NFC lowercase tag component、canonical percent encodingを要求し、意味的に不正なcursorも`MEMORY_INVALID_FIELD / effect: none`へ閉じる。

## C9 Final Finding Closure Plan

Gate status: `ready`

Unresolved contract decisions: なし。

### Pre-Implementation Closure Plan

- Invariant ID: `GMCP-PROJECT-ADMISSION`
  - Accepted contract / exact anchor: `effect: none`の失敗、read、dry-run、replayはProject inventoryを変更しない。path identityの解決はside-effect freeとし、新規scopeの永続化は成功するMemory mutationと同じstorage transactionで行う。
  - Scope / semantic owner: Memory V6 project resolver、target resolution result、append／forget／move service入口、Memory V6 storage transaction。
  - Failure mode / consumer impact: resolverの別connection upsertがappend／moveのoperation admissionより先にcommitし、後続のnot-foundやconflictが`effect: none`でも空Projectをinventoryへ残す。
  - State transitions / failure timing: validate → side-effect-free identity resolution → idempotency／entry／supersedes／quota admission → scope admission＋Memory mutationの単一transaction → commit／rollback → response projection。
  - Direct verification: fresh DBのunknown pathで、append supersedes failure、move missing source、forget missing entry、idempotency conflictがProject scopeを作らず、成功appendと成功moveだけがscopeとMemory mutationを同時commitすることをservice/storage testで確認する。
  - Independent review trigger: owner/scope永続化とmutation transactionをまたぐため、`targeted_reviewer`でfailure timingと兄弟入口を反証する。
  - Gate: `ready`
- Invariant ID: `GMCP-TAG-DESCRIPTION`
  - Accepted contract / exact anchor: `memory.list_tags`の公開schemaはexplicit targetをちょうど1件要求するため、tool descriptionも同じcardinalityを案内する。
  - Scope / semantic owner: `GENERAL_MEMORY_MCP_TOOL_DEFINITIONS`と`tools/list` executable contract。
  - Failure mode / consumer impact: descriptionに従った複数target requestがadapter schemaで拒否される。
  - State transitions / failure timing: tools/list → model request construction → schema validation。
  - Direct verification: descriptionと`targets.minItems/maxItems = 1`をMCP contract testで固定する。
  - Independent review trigger: none。単一文言とschemaの直接checkで閉じる。
  - Gate: `ready`

### Closure Map

- `GMCP-PROJECT-ADMISSION`: project.pathのproject owner／character+project scope、append、move destination、forget、retry／conflict／not-found、transaction rollback、inventory projectionを含む。ID selectorは既存scopeだけを解決し新規scopeを作れないため、creation channelから除外する。readとdry-runは既存のknown resolverを維持する。
- `GMCP-TAG-DESCRIPTION`: MCP tool definitionとtools/list schemaだけを含む。canonical list-tags validationとruntime routeは既にsingle targetを要求しておりbehavior変更がないため、文言以外は変更しない。

Full-review gateはC3で実施済みのため再実行しない。C9はdirect checkと`GMCP-PROJECT-ADMISSION` finding familyのtargeted closureで閉じる。

### C9 Direct Evidence

- `GMCP-PROJECT-ADMISSION`: fresh DBでsearch、forget dry-run、missing supersedes append、missing source move、missing entry forget後も`project_scopes_v6 = 0`を確認した。成功appendはentryとscopeを同一transactionでcommitし、成功moveはdestination scopeとentry retargetを同一transactionでcommitする。scope admission後のentry insert failureではtransaction rollbackによりscope rowが残らない。
- `GMCP-TAG-DESCRIPTION`: `tools/list`のdescriptionを`one explicit Memory target`へ修正し、schemaの`minItems = maxItems = 1`と同じcontract testで固定した。
- Targeted/integration: 212 tests中211 passed、1 platform skip、0 failed。
- Type contract: `npm run typecheck`はGreen。

### C9 Finding Promotion

- `effect:none`でもProject scopeが保存される経路はaccepted effect certaintyと永続状態の不一致であり、append／move／forget／resolver／storage transactionが同じ`GMCP-PROJECT-ADMISSION` familyとsemantic ownerに属するため`blocking / current-scope repair`とした。
- list-tags descriptionのcardinality不一致は到達可能だがbehavior変更を伴わず、tool definitionと直接contract testだけで閉じる`risk-candidate → current-scope documentation repair`とした。
