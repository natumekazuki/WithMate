# Memory / Character Affect MCP Plan

- Status: in progress
- Accepted contract: Issue本文、ADR 018
- Logical change ID: `memory-affect-mcp-v1`

## Scope

- MemoryとCharacter Affectを同じtransport非依存application serviceから利用する。
- CLIとstdio MCP serverは、WithMate runtimeの同じlocal application endpointへ接続する兄弟adapterとする。
- 通常Sessionは各turnでapplication serviceを直接呼び、最新の最小Affect snapshotをCharacter Definitionとは別のcontext envelopeとして注入する。
- MCPはcontext取得、affect appraise、Character Memory検索、episode追加、訂正、forgetを公開する。
- authority、scope、idempotency、version、read-back、構造化error、transport別metricsをapplication boundaryで揃える。

対象外はafterglow、感情語彙の再設計、renderer UI、CLI subprocess wrapper、MCP tool callによる毎turn必須処理の代用である。

## Pre-Implementation Closure Plan

Gate status: `ready`

Accepted contract / exact anchors:

- Issue本文のGoal、対象範囲、完了条件、検証ケース
- `docs/adr/018-character-affect-event-persistence.md`
- `src-electron/memory-v6-service.ts`
- `src-electron/character-affect-service.ts`
- `src-electron/character-affect-storage.ts`
- `src-electron/memory-v6-http-server.ts`
- `src-electron/session-runtime-service.ts`
- MCP TypeScript SDK 1.30.0のserver/tool contract

Canonical ownerは、Memoryのvalidation、authority、persistenceが`MemoryV6Service`、Affect eventとepisode収束が`CharacterAffectService`、両者のcontext projectionと外部operation authorityが新しいCharacter Context application serviceである。HTTP、CLI、MCP、turn lifecycleは永続化規則を所有しない。

### Invariant Matrix

| Invariant ID | Sibling channel | Coupled values / order | Failure mode / consumer impact | Direct verification | Status |
| --- | --- | --- | --- | --- | --- |
| CM-1 | lifecycle / CLI / MCP | application service, storage, runtime endpoint | adapterごとにvalidationまたは状態が分岐する | CLI/MCP cross-readback integration | verified |
| CM-2 | get / search / appraise / correct / forget | user, character, session/project, authority | 別owner更新、bounded writeからdestructive operationへ昇格 | credential-bound authority、unknown owner、scope拒否test | verified |
| CM-3 | appraise / append / correct / retry | durable turn correlation、version、idempotency key、request fingerprint、effect certainty | lost update、duplicate、partial writeの成功誤認 | same-minute turns、replay、concurrent update、response-loss test | verified |
| CM-4 | turn injection / context.get / settlement recovery | Character baseline ref、affect scope/version、Memory projection、pending/settled turn | stale state、Definition上書き、raw history漏出、completed turnのappraisal欠落 | next-turn refresh、projection、crash recovery contract test | verified |
| CM-5 | MCP schema / runtime error / CLI exit | required union、input/output schema、annotations、error code、retryability | clientが推測で補完、read/write性質の誤認 | listToolsとsuccess/error projection contract test | verified |
| CM-6 | MCP / CLI fallback / metrics | same discovery endpoint、credential-bound transport label、outcome | local state分岐、fallback成功の誤報、観測不能 | unavailable、HTTP non-2xx、authenticated fallback、metrics integration test | verified |

Memory commitとAffect linkはADR 018どおり別transactionとし、同じderived idempotency keyで収束する。途中失敗は`partial_failure`として保存済みeffectを明示し、成功へ変換しない。

### Candidate c2 Finding Promotion

Candidate `memory-affect-mcp-v1-c2`の3 specialist reviewをaccepted contractと到達条件へ照合した。

- `current-scope repair`: caller-controlled `x-withmate-client`によるoperator昇格とfallback metrics偽装。Character adapterのHTTP認証境界がownerであり、CLI専用credentialへ固定する。
- `current-scope repair`: MCPがHTTP non-2xxを成功投影する経路。MCP transport mappingがownerであり、共通Character errorへ正規化する。
- `current-scope repair`: episodeの複合必須条件、6 toolのoutput schema、CLI/MCP unavailable / response-loss semantics。public contractと兄弟adapterの現行scopeで閉じる。
- `current-scope repair`: 表示用の分精度`updatedAt`をturn idempotencyへ流用する経路。durable audit IDをturn correlationのownerにする。
- `current-scope repair`: pre-turn versionをpost-turnへ再利用する経路。post-turn直前の再取得とbounded re-evaluationで閉じる。
- `boundary prerequisite`: completed Session保存後のprocess crashでappraisalが未settledのまま検知不能になる経路。新しいdurable settlement ownerが必要なため、現Candidateへ局所修正として混ぜず、先行論理変更`character-affect-turn-settlement-v1`として実装・検証してから本体Candidateを再構成する。

Candidate c3のtargeted closureで確認した追加findingは、いずれも既存semantic owner内の`current-scope repair`とした。MCP discovery後のstructured errorをsuccess-only output schemaが拒否する経路はMCP adapterのsuccess/error公開schemaを一つのobject contractへ統合した。cancelとprovider成功の競合、およびenqueue後にSession保存が完了しない経路は、assistant message indexをSession側commit markerとして検証し、未commit pendingをappraiseせず破棄する。startup drainの100件starvationはcursor走査で閉じた。新しいowner、subsystem、public authority軸は生じておらず、追加の構造収束gate evidenceはない。

Findingはaccepted riskにできない。いずれも通常到達可能で、authority bypass、別turnの欠落、write成功誤認、または必須lifecycle処理の不可観測な欠落につながるためである。

### Pre-Implementation Closure Plan: `character-affect-turn-settlement-v1`

Gate status: `ready`

- Canonical owner: Character Affect persistence内のturn settlement storageと、WithMate main processのturn lifecycle orchestration。
- Stable correlation: turnごとに永続化されるaudit ID。`turn:<sessionId>:audit:<auditId>`をpending recordとAffect event idempotencyの共通prefixにする。
- Ordering: provider response確定後、completed Session保存前にpending recordとassistant message indexを永続化する。cancel競合でもcompleted responseを保存するならenqueueする。completed Session保存後に最新contextで評価・appraiseし、成功またはidempotent replayのread-back後だけsettledへ遷移する。
- Recovery: startup時にpendingをcursor列挙し、Sessionの同じmessage indexと本文が一致するcommit済みturnだけをbounded re-evaluationする。未commit recordはappraiseせず破棄し、失敗したcommit済みrecordはpendingを保持する。内容をlog / metricsへ出さず、settled時は会話本文をrecordから除去する。
- Concurrency: evaluation直前に最新contextを取得し、version conflict時は一度だけ再取得・再評価する。blind candidate retryはしない。
- Failure: pending保存失敗はturn completionを成功扱いしない。appraise失敗はpendingを保持し、次回recovery可能にする。
- Direct verification: enqueue-before-completion ordering、crash相当の再生成後drain、same-minute別turn、同一turn replay、並行version更新後の再評価、settled後payload除去。

この先行変更はSessionのpublic schemaを変えず、既存のAffect/Memory application serviceへだけ収束する。migrationは同じV6 databaseのadditive tableとして行い、ADR 020へ永続化理由を置く。

### Pre-Implementation Closure Plan: `memory-mutation-reason-v1`

Gate status: `ready`

- Invariant ID: `CM-7`。Character Memory correct/forgetで必須の変更理由は、authorityとは別のmutation inputとしてcanonical Memory boundaryへ到達し、監査reasonとidempotency fingerprintへ同じ値で継承される。
- Accepted contract: user issueのcorrect/forget要件、ADR 020のapplication-owned validation/idempotency/audit、既存Memory V6 mutation eventとforget reason contract。
- Canonical owner: Memory V6 append/forget request validation、service fingerprint、storage mutation event。Character Context application serviceはtransport入力をこのboundaryへ変換する。
- Scope: correctはappendのoptional mutation reasonをMemory V6 contractへ追加する。forgetは既存`MemoryForgetReason` enumをCharacter public contractでも使用し、自由文字列を黙って`user_request`へ置換しない。
- Failure mode / consumer impact: reasonだけ異なる同一idempotency keyがreplay扱いになる、監査に理由が残らない、privacy等のforget semanticsが失われる。
- Direct verification: correct reasonのmutation event保存、reason違いのidempotency conflict、forget enumの伝播とprivacy semantics、Character Context integration read-back。

この先行変更は既存Memory mutation ownerへのadditive contractとして閉じ、Character Context側に独立した監査やidempotency正本を作らない。

### Candidate c4 Holistic Finding Promotion

Candidate `memory-affect-mcp-v1-c4`の一度だけのcomplete-diff holistic reviewで得た3 findingをaccepted contractへ照合した。

- `current-scope repair`: 配布CLIがMCP SDKとZodをbare importし、`extraResources`の分離配置で起動できない。生成artifactをself-containedにし、CLI/MCP間の循環を共有runtime clientの抽出で閉じる。
- `current-scope repair`: `affect.effective`がlayer別rowを返し、同一componentの有効値を複数返す。Affect serviceのcanonical component projectionを使い、寄与layerを別fieldで公開する。
- `boundary prerequisite`: Character Memory correct/forgetのreasonがcanonical Memory mutation ownerへ到達しない。先行論理変更`memory-mutation-reason-v1`のCM-7として、監査reason、idempotency fingerprint、forget enumを同じboundaryで閉じる。

いずれも通常の配布、複数layer、明示的な訂正・forgetから到達でき、accepted riskにはしない。source修正後は新Candidateでdirect checkと各finding familyのtargeted closureを行い、complete-diff holistic reviewは再実行しない。

## Implementation slices

1. Character Context contract、validation、application service、versioned projectionを実装し、service contract testでCM-2からCM-4を閉じる。
2. runtime endpointとCLI commandを接続し、CLIからのread/write/read-backを確認する。
3. 6 MCP toolsとserver instructions / annotationsを接続し、schema contractとCLI/MCP cross-readbackを確認する。
4. 通常Sessionのpre-turn context注入とpost-turn評価をapplication serviceへ接続し、stale更新とfailure分離を確認する。
5. runbook、ADR pointer、metricsを整え、型検査、build、対象test、Independent Closure Reviewを実施する。
6. Candidate c2 findingsをFinding Promotionし、`character-affect-turn-settlement-v1`を先行実装する。その後、credential-bound authority、schema/error parity、turn correlation、bounded concurrent re-evaluationを本体scopeで修正する。

## Structure consolidation gate

- Result: `ready-after-consolidation`
- Trigger evidence: CLI / MCP / lifecycleの3入口と、application service / HTTP authority mapping / transport schemaの責務配置をinventoryした。
- Preserved contracts: CM-1からCM-6、ADR 018、ADR 020、MCP 6 tool schema、CLI/MCP cross-read-back。
- Responsibility delta: なし。application serviceがvalidationとstate contract、HTTPが認証済みtransportからのauthority導出、CLI/MCPが入出力変換、turn evaluatorがprovider structured output変換を所有しており、semantic ownerの分散は確認されなかった。
- Applied edit batch: なし。schemaの二重表現はMCP transport schemaとcanonical runtime validationという異なる境界のため`leave-as-is`とした。
- Post-edit checks: 該当なし。gate前にtypecheck、build、全testがGreen。
- Replan evidence: specialist reviewで、HTTP transport identityの自己申告、lifecycle settlement ownerの欠落、public schemaとruntime validationの不一致が確認された。上記closure planを正本として先行変更とcurrent-scope repairへ分離した。
- Applied consolidation: pending/settled永続化を`character-affect-turn-settlement-storage`、bounded re-evaluationを`character-affect-turn-settler`へ分け、`main`はprovider評価と起動時drainのorchestrationだけを所有する。CLI/MCP credentialはdiscovery/runtime HTTP boundary、public schemaはMCP adapter、domain validationはCharacter Context application serviceへ固定した。
- Post-edit checks: settlement storage/retry、MCP schema/non-2xx、CLI error parity、runtime credential spoof、Session orderingのtargeted contract、typecheck、全test、production buildがGreen。
- Sibling Sweep: CLI/MCP/lifecycleの3入口、correct/forget/reset、read/write transport failure、pre/post-turn context、same-turn replayを確認し、別ownerへの迂回は残っていない。
- Residual topology risk: generated CLI bundleはsource adapterの配布投影でありsemantic ownerではない。MCP SDK用schemaとapplication validationはtransport公開とcanonical validationという別責務のため維持する。

## Knowledge placement

- current implementation: source
- executable expectation: contract type、runtime validation、test
- local rationale: codeから復元できない箇所だけcomment
- decision rationale: `docs/adr/020-memory-affect-mcp-application-boundary.md`
- cross-cutting usage / recovery: `docs/runbooks/memory-affect-mcp.md`
- task-local Candidate / Evidence Ledger: このplanに保持し、現行設計へ複製しない
