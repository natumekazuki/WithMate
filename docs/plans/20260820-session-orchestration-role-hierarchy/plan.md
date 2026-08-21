# Session Role bindingと作成authorityの実装計画

## 目的と範囲

通常SessionへimmutableなRole bindingを導入し、GUIのroot作成とAgent向け`session.create`のchild作成を、通常Sessionの永続bindingを正本とする一つのauthority境界へ収束させる。

対象はRole binding、migration、作成authority、idempotency、public projection、runtime binding、Turn prompt、更新時の不変性、親Sessionの削除保護、GUIのroot用途選択、関連文書と検証である。work item、Coordination Event、Session tree、Role badge、GUI child作成、`turnPurpose`、Agent向けdeleteは対象外とする。

Base commitは`fe82c69b0db40a5c6300902a77946baaa1e11b4a`とする。task branchへの通常commitまでをauthority内とし、pushとPR作成は行わない。

## Closure Plan

### OR-ROLE-01: immutable Role tuple

- Accepted contract / exact anchor: ユーザー指定のaccepted contractと添付提案のv6.4.0 first slice。Roleは閉じた4値、revisionは1、最大depthは2であり、rootとchildのtuple導出規則を持つ。
- Scope / semantic owner: 通常Session専用のRole binding domainとqueryableな永続storage。`character-authoring`、Auxiliary、Companionは除外する。
- Failure mode / consumer impact: create、load、update、migration、restartでtupleが分離し、誤ったauthority、孤立child、または未対応状態の黙示fallbackが発生する。
- State transitions / failure timing: fresh create、旧DB backfill、migration再実行、migration失敗rollback、load、update、restart。
- Direct verification: tuple builderとstrict validatorのunit test、Session rowとbindingのtransaction test、empty/populated migration、再実行、failure rollback、unknown Role/revision/壊れたtupleのload拒否。
- Independent review trigger: 永続化migrationとpublic authorityへ同時に波及するため、commit済みsourceへのholistic reviewを行う。
- Gate: ready。

### OR-AUTH-01: actor-bound child creation

- Accepted contract / exact anchor: actorはruntime bindingから解決し、childのparent、root、depth、Characterはcanonical parentから導出する。Role matrix、最大depth、effect-none failure timing、actor-scoped idempotencyを守る。
- Scope / semantic owner: external Session application boundaryからSession CRUDのtransaction ownerまで。GUI root createは同じRole binding builderのroot入口を使う。
- Failure mode / consumer impact: callerによるhierarchy偽装、禁止Roleのchild作成、depth超過、別actor retry衝突、validation前のSession IDまたはSessionFolder生成、commit失敗後の孤立directory成功扱い。
- State transitions / failure timing: canonical replay、actorとparent解決、Role検証、ID発行、SessionFolder作成、DB transaction、publication、response loss、retry。
- Direct verification: strict public input、Role matrix、depth 2と超過、validation前の副作用absence、同一actor replay、Role差conflict、別actor同一key、catalog/parent変更前replay、atomic commit、publication failure後read-back、pre-commit folder cleanup。
- Independent review trigger: authorityと外部副作用の順序をtargeted checkだけでは横断的に反証しきれないため、commit済みsourceへのholistic reviewを行う。
- Gate: ready。

### OR-PROJ-01: shared public projectionとcapability

- Accepted contract / exact anchor: `session.self`、create、list、getは同じ5-field projectionを返し、`runtime.catalog`はrevision、Role、child規則、最大depthを返す。CLI、MCP、HTTPはshared contract、strict validator、error envelopeを共有する。
- Scope / semantic owner: `src/session-external-runtime-contract.ts`のshared public contractと一つのprojector。listはsummary queryを維持する。
- Failure mode / consumer impact: adapterごとの値ずれ、unknown-field迂回、private binding情報の漏えい、listのfull hydrationやresponse limit退行。
- State transitions / failure timing: request parse、application projection、adapter serialization、raw HTTP、pagination、response size判定。
- Direct verification: shared contract test、application test、CLI/MCP/HTTP schema test、list query/projection test、private field absence。
- Independent review trigger: public API全入口への波及をholistic reviewのpublic boundary lensへ含める。
- Gate: ready。

### OR-LIFE-01: runtime snapshot、prompt、更新、削除

- Accepted contract / exact anchor: provider generation issue時にcanonical tupleをsnapshotし、same-generation retryは同じprojectionを維持する。全通常Turnへ専用System Prompt sectionを注入する。更新はtupleを保持し、未削除childを持つparentは単体削除前に拒否し、一括削除では固定候補集合から除外する。
- Scope / semantic owner: Role binding projector、provider binding issue、provider prompt composition、Session persistence update/delete admission。
- Failure mode / consumer impact: staleまたはcaller由来Roleでprovider executionが始まる、private binding情報がpromptへ漏れる、updateでtupleが変わる、parent削除でchildが孤立する、leaf削除後に同一batchでparentまで連鎖削除される。
- State transitions / failure timing: binding generation create/retry/recreate、Turn prompt構築、GUI/external update、単体delete、一括delete、storage mutation、既存cleanup。
- Direct verification: binding generation test、prompt exact section test、update/rename/provider option/restart preservation、単体deleteの副作用absence、一括delete固定候補、leaf cleanup順序。
- Independent review trigger: runtime authority、prompt、削除安全性をholistic reviewのlifecycle lensへ含める。
- Gate: ready。

## Closure Map

### Coupled invariantとmigration

- Canonical owner: 通常Session Role binding moduleとSessionStorageV6 transaction。
- Siblings in scope: root/child create、load、summary/detail、update、migration、restart、idempotent replay、public projection、runtime snapshot、prompt、delete child lookup。
- Excluded siblings and reason: Auxiliary、`character-authoring`、Companionは通常Session Role contractのsupported domainではない。clone/importは通常Sessionに対応入口がない。
- Failure points: migration前、backfill中、transaction commit前、commit後publication、malformed row load。
- Direct checks: tuple validation、migration rollback/re-entry、atomic insert/read-back、unknown data rejection。

### Authority、public API、side effect

- Canonical owner: bound applicationがactorを渡し、Session CRUDがcanonical parentとRole規則を解決してtransactionを所有する。
- Siblings in scope: CLI、MCP、raw HTTP、shared parser、runtime catalog、create projection/error mapping。
- Excluded siblings and reason: GUIはroot createだけ、Agent向けdeleteは対象外。
- Failure points: replay判定前後、parent validation、ID発行、SessionFolder作成、DB commit、publication、response loss。
- Direct checks: unknown-field rejection、actor-scoped replay、validation前side-effect absence、folder cleanup、publication後read-back。

### Owner、projection、aggregate delete

- Canonical owner: SessionStorageV6のbinding queryとSessionPersistenceServiceのdelete admission。
- Siblings in scope: single delete、date batch delete、summary/detail/self/create projection、provider binding、Turn prompt。
- Excluded siblings and reason: Session tree UIとdelete previewは後続slice。
- Failure points: child存在確認前のmutation、batch中のcandidate再評価、cleanup順序、summaryからのfull hydrate。
- Direct checks: parent拒否、batch固定除外、leaf削除、projection equality、pagination/response size維持。

## Test Design Gate

| Failure mode | Consumer impact | Canonical owner / observable | Check layer | Distinctness |
| --- | --- | --- | --- | --- |
| invalid tupleをfallbackする | Agentが誤authorityで動作する | Role validatorのaccept/reject | unit | 現行Role契約がなく既存checkでは検出不能 |
| rowだけまたはbindingだけcommitする | restart後にSessionが読めない | SessionStorageV6 transactionとread-back | integration | 単体builderではatomicityを観測できない |
| migrationがpartialまたは再実行不能 | 旧Sessionの消失、起動不能 | DB savepoint後のschemaとdata | integration | fresh schema testではmigration failureを観測できない |
| forbidden child createが副作用を残す | 孤立folder、未許可Session | CRUD boundaryのerrorとID/folder/row/publication absence | integration | validator unitだけではfailure timingを観測できない |
| actor/key scopeまたはfingerprintが欠ける | 別actor衝突、異なるRoleへの誤replay | idempotency storage result | integration | parser testでは永続scopeを観測できない |
| adapter間でprojection/schemaがずれる | clientが誤ったcapabilityを選ぶ | shared parser/result envelope | contract + adapter integration | application testだけではCLI/MCP/HTTP迂回を検出できない |
| prompt/snapshotがcanonical tupleと違う | Agentが誤Roleを認識する | issued authority snapshotとlogical prompt | unit/component integration | storage projection testではprovider境界を観測できない |
| parentをcascadeまたはbatch連鎖削除する | childが孤立または消失する | delete resultとcleanup call sequence | service integration | storage FKだけではbatch semanticsを保証できない |
| GUI既定/選択mappingが違う | rootが意図しないRoleになる | launch draft、request、作成Session | state/component + visual | main create testだけでは表示と既定選択を観測できない |

## UI判断

主要タスクはroot Sessionの用途選択である。既存launch dialogのWorkspace直下へ用途専用cardを置き、左から`standalone`、`overall-coordinator`の順でnative controlを表示する。既定は`standalone`とし、常設badge、新規surface、独自tokenを追加しない。既存のspacing、typography、focus、contrastを維持し、用途選択、workspace、provider、Characterを同じsubmit経路へ渡す。

## 実装順と検証

1. shared Role binding domain、storage table、migration、transactionを実装し、domain/storage testを通す。
2. GUI root createとbound external child createをcanonical ownerへ接続し、idempotencyとfolder failure timingを閉じる。
3. public projection、catalog、CLI/MCP/HTTPを揃える。
4. provider binding、Turn prompt、update/delete safetyを接続する。
5. ADR、external runtime設計、CLI runbookを更新する。
6. targeted test、`npm run typecheck`、`npm test`、`npm run build`、分離起動によるvisual checkを実行する。
7. 一つの論理commitを作成し、immutableなreview worktreeで独立holistic reviewを行う。findingは同じInvariant familyへ限定して分類、修正、直接再検証する。

## Open questionとvalidation gap

現時点で実装を止める契約競合はない。ADR 021のgeneric registry ownershipは維持し、Roleの意味と規則は通常Session domainが所有する。実provider accountへのCodex/Copilot接続は対象外であり、binding generationとprompt compositionの直接testで代替する。
