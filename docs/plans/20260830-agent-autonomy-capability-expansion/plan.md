# Agent 自律操作拡張計画

## 目的

WithMate の Agent 向け Session Runtime を、固定 Role ごとに操作を禁止するモデルから、ユーザーが委譲した authority の範囲で Agent が作成、修正、移管、訂正、回復、終了まで自律的に扱えるモデルへ移行する。

本計画は、現行の公開操作に存在しない管理 API と、公開操作は存在するが入力 schema または固定 authority matrix によって利用できない能力を対象とする。操作能力は広く提供し、次の境界だけを強制する。

- ユーザーの意思、承認、回答を Agent が捏造しない。
- 子や別 Session へ委譲する authority は、委譲元の実効 authority を超えない。
- actor、owner、root、resource identity は runtime binding と保存済み関係から解決し、request の自己申告を信用しない。
- 過去の結果、判断、binding、履歴を直接上書きせず、訂正、失効、再開を append-only event として記録する。
- mutation は revision、idempotency、transaction、effect certainty によって競合と部分成功を制御する。
- filesystem 操作は明示された許可 root から出ない。
- Session、Turn、retry、storage、費用は root 単位の budget に収める。
- 購入、外部送信、protected branch 更新、履歴改変などの外部副作用は、ユーザーから明示的に委譲された authority を必要とする。

Role は標準の責務、routing、表示、初期 grant template を表す。Role 自体を恒久的な能力封鎖には使わない。

## 現在地と依存関係

現行の Agent 向け公開面は `SESSION_RUNTIME_OPERATIONS` の 35 操作である。Session は作成、取得、一覧、rename、Work Item は作成、状態遷移、結果、取消、直属子集約、SessionFolder は UTF-8 text の list、read、write に限られる。

`docs/plans/20260830-session-root-work-item/plan.md` に基づく Root WorkItem 実装は、本計画と並行して別 Worktree で進行している。本計画はその実装を中止または巻き戻さず、統合済みの Root WorkItem を基準に後続 contract revision を追加する。

Root WorkItem 計画の次の判断は、本計画の対応 slice が統合された時点で置き換える。

- delegated WorkItem の作業契約は永久不変ではなく、権限を持つ actor が着手前または明示的な再交渉後に改訂できる。
- terminal WorkItem は履歴を維持した successor revision として再開できる。
- Role と communication policy だけを authority ceiling にせず、ユーザー起点の attenuating grant を正本に加える。
- root Session の目的継続は、新規 root Session だけでなく、Root WorkItem の明示的な reopen または successor でも表現できる。

Root WorkItem の一意性、自己所有、Session 作成との原子性、append-only history、既存 delegated row の保存は維持する。

## v6.4.0 リリース前の実装運用

本計画の実装中は、v6.4.0 の Work Item 機能を作業管理に使用しない。実装 Session の起動と引継ぎには、Git Worktree と SessionFolder 配下の自己完結した初回プロンプトを使用する。Work Item の作成、更新、集約を前提にした自動統括は、v6.4.0 のリリースと導入が完了するまで行わない。

現在は `feat/v6.4.0-session-root-work-item` が進行中であり、追加の実装 Worktree は作成しない。次の `Shared authority and history cutover` は、次の条件をすべて満たした後に開始する。

- Root WorkItem 実装の直接検証と必要な commit-bound review が完了し、未解決 blocking finding がない。
- 実装 commit が `feat/v6.4.0` へ統合されている。
- 統合後の `feat/v6.4.0` の commit OID を、次の Worktree と初回プロンプトの base として固定できる。

後続 Slice も、依存する Slice が `feat/v6.4.0` へ統合されてから Worktree を作成する。未レビュー commit や進行中 Worktree から依存 Slice を先行分岐しない。

並列実装は、依存 Slice がすべて統合済みで、semantic owner、変更予定ファイル、生成物が重ならない場合だけ行う。実際の先行差分を確認してから最大二つの write Session を起動し、共通の database schema、application dispatch、TypeScript contract、CLI、MCP を変更する段階は直列に統合する。

## 対象能力

### Session lifecycle

- root と child の作成、選択可能な Character、Provider、Workspace、Role template
- metadata と実行設定の revisioned update
- moveによるreparent／adopt、restoreによるreuse、clone
- archive、delegation compensation、物理delete
- 実行中、子孫、Work Item、artifact、grant を含む lifecycle closure

### Work Item lifecycle

- contract revise と着手admission時のactual source identity確定
- target reassign、parent move、batch delegationによるsplit、aggregationによるmerge、clone
- terminal result correction、reopen、successor
- archive と物理 delete
- current projection と append-only event history

### Aggregation と result correction

- decisionのcorrect、withdraw、replace
- nested aggregation の bounded flatten projection
- aggregate snapshot と親 result の明示 finalize
- 訂正後の stale aggregate、replacement、再 finalization

### Delegation transaction

- child Session、Work Item、初回 Turn の一括作成
- retry、compensate、cancel
- response loss と process crash 後の operation read-back
- 部分成功時の reuse、resume、rollback の選択

### Authority grant と routing

- grantのcreate、list、get、revokeと、parent grant付きcreateによる再委譲
- same-root の自由な直接通信
- cross-root consultation と一時委譲
- Session／Work Item moveによるownership transfer
- Role matrix から grant evaluation への移行

### SessionFolder と artifact

- file stat、list、mkdir、delete、move、copy
- bounded binary read、write
- artifact create、list、get、read、attach、detach、transfer、delete
- Workspace、SessionFolder、additional directory 間の明示 transfer

### Root management

- root detail、list、statusと各resource queryへのcursor
- root stop、archiveとRoot WorkItem resultの集約表示
- root全体のcancel／drain、cleanup、handoff

### Resource budget

- root 単位の同時実行、Turn、token、費用、retry、Session 数、保存容量、deadline
- budget get、list、configureと内部reserve／settlement
- root から子への attenuating allocation
- provider 実績との reconciliation

## 採用する公開操作の単位

対象能力ごとに別名のAPIを機械的に増やさず、canonical ownerとfailure timingが同じ操作はstrict unionへ統合する。初期実装で採用する操作単位は次とする。

| 領域 | 追加または拡張する操作 |
| --- | --- |
| Session | `session.create`拡張、`session.configure`、`session.move`、`session.archive`、`session.restore`、`session.delete`、`session.clone` |
| Work Item | `work.revise`、`work.reassign`、`work.move`、`work.reopen`、`work.result.correct`、`work.archive`、`work.restore`、`work.delete`、`work.clone`、`work.history.list` |
| Aggregation | `work.aggregation.correct`、`work.aggregation.list`のdepth拡張。finalizationは`work.result`へ収束する |
| Delegation | `delegation.create`、`delegation.get`、`delegation.list`、`delegation.retry`、`delegation.cancel`、`delegation.compensate` |
| Grant | `grant.create`、`grant.get`、`grant.list`、`grant.revoke` |
| Files | `session.files.roots.list`、`stat`、`list`、`read_text`、`write_text`、`read_binary`、`write_binary`、`mkdir`、`delete`、`move`、`copy` |
| Artifact | `artifact.create`、`get`、`list`、`read`、`attach`、`detach`、`transfer`、`delete` |
| Root | `root.get`、`root.list`、`root.status`、`root.stop`、`root.archive` |
| Budget | `budget.get`、`budget.list`、`budget.configure` |

次の能力は独立APIではなく、上記操作のcompositionとして提供する。

- Role、Character、Provider、Workspace変更は`session.configure`のstrict unionで扱う。
- reparent、adopt、cross-root transferは`session.move`または`work.move`で扱う。
- Session reuseは`session.restore`または既存Sessionをdelegation targetへ指定して扱う。
- Work Item splitは`delegation.create`のbatch input、mergeはaggregation decisionと親`work.result`で扱う。
- aggregation revoke／replaceは`work.aggregation.correct`の`withdraw | replace | revise` unionで扱う。
- cross-root consultationはtemporary grantとTurnまたはdelegationのcompositionで扱う。
- root create、transfer、resultはそれぞれ`session.create`、`session.move`、Root WorkItemの`work.result`へ収束する。
- file renameは`session.files.move`で扱う。
- budget reserve、consume、release、reconcileはapplication内部操作とし、Agentは残量とpolicyを取得、権限内でconfigureする。

source identityは手入力の`work.source.refresh`を正本にしない。Work Itemはplanned sourceを保持し、queuedからrunningへadmitする時点でWithMateがWorkspaceからactual start sourceを解決し、execution associationへWork Item revisionと同じtransactionで保存する。事前確認が必要ならread-onlyな`work.source.resolve`を追加できる。

## MCP と CLI の公開方針

Agent が直接使用する application operation は、TypeScript contract、application service、raw HTTP client、CLI、MCP、runtime catalog、managed Skill で同じ操作、strict schema、error、effect certainty を公開する。GUI に入口があることや application service に実装があることだけでは、その能力の実装完了とみなさない。

transport ごとに入出力形式を変える必要がある場合も、resource identity、authority、revision、idempotency、failure timing の意味は変えない。たとえば binary content は CLI と MCP で搬送方法が異なっても、同じ file または artifact operation として扱う。特定の transport で安全に表現できない場合は、操作を実装済みとして隠さず validation gap として残す。

次の処理は公開 operation の composition を支える内部操作であり、Agent 向け MCP または CLI operation として公開しない。

- budget の reserve、consume、release、settlement、provider usage reconciliation
- storage transaction、event projection、idempotency record の内部 helper
- migration、repair、retention に限定した system principal 操作
- grant evaluator と mutation admission の内部判定

## 対象外

- ユーザーの未委譲 authority を推測して自動付与する機能
- OS、provider、Git hosting、決済 service など外部 system の認可を迂回する機能
- secret、raw provider payload、内部 prompt を public projection へ含める変更
- repository 外の任意 path を暗黙に許可 directory へ加える fallback
- append-only audit history の物理改変

## Invariant closure

### AUTONOMY-USER-01: ユーザー意思を Agent authority と分離する

- Accepted contract: Agent はユーザーから委譲された範囲で自律判断できるが、ユーザー本人の回答、同意、承認を生成しない。
- Canonical owner: authority grant service と Coordination user decision service。
- Failure mode: Agent が `user_decision_required` をユーザーとして解決し、未委譲の外部副作用を実行する。
- Direct verification: principal kind と authority source を変えた service integration test。
- Review trigger: authority と Coordination Event を横断するため targeted review を行う。
- Gate: ready。

### AUTONOMY-GRANT-02: 再委譲は実効 authority を拡張しない

- Accepted contract: child grant、cross-root grant、budget allocationはissuerのactive grantとresource scopeの部分集合である。新規resource作成はplacement namespaceへのconstruction capabilityから導出し、生成resource IDをwildcardへ暗黙追加しない。
- Canonical owner: grant evaluator と immutable grant event storage。
- Failure mode: wildcard、stale grant、Role template、reparent、root作成special caseを経由して権限が拡張される。
- Direct verification: grant latticeとconstruction capabilityのproperty test、create、delegate、revoke、reparent integration test。
- Review trigger: authorization boundary のため complete-diff review を行う。
- Gate: ready。

### AUTONOMY-IDENTITY-03: resource identity を caller に決めさせない

- Accepted contract: actor は runtime binding、owner、root、parent、creator は canonical relation から解決する。request は対象 ID と意図だけを指定する。
- Canonical owner: Session application service の principal resolution。
- Failure mode:別 root や別 actor を request field で自己申告し、read、mutation、cleanup を実行する。
- Direct verification: raw HTTP、CLI、MCP の spoof input rejection と service principal test。
- Review trigger: public API と owner scope を横断するため targeted review を行う。
- Gate: ready。

### AUTONOMY-HISTORY-04: 訂正と再開で過去を失わない

- Accepted contract: update、move、reassign、correct、revoke、reopen、archive は event を append し、current projection を同じ transaction で更新する。
- Canonical owner: resource ごとの event store と projection writer。
- Failure mode: current row の上書きだけが成功し、以前の契約、結果、判断、owner を復元できない。
- Direct verification: event replay と current projection の一致、response loss retry、migration baseline test。
- Review trigger: persistence と correction semantics を横断するため complete-diff review を行う。
- Gate: ready。

### AUTONOMY-MUTATION-05: 複合 mutation を部分成功させない

- Accepted contract: createはcanonical container revisionとserver-reserved ID、既存resource mutationはtarget revision、sagaはoperation revisionとcommitted manifestを使い、idempotency、effect certainty、read-backを共有する。
- Canonical owner: shared mutation admission と各 storage transaction。
- Failure mode: createがcaller-supplied identityを信用する、またはdelegation、split、merge、move、transferの途中だけがcommitされ、retryが重複resourceを作る。
- Direct verification: create transactionとsaga stepの各failure point、commit後response loss、同一key replay、別payload conflict test。
- Review trigger: failure timing を横断するため complete-diff review を行う。
- Gate: ready。

### AUTONOMY-PATH-06: file と artifact は許可 root に閉じる

- Accepted contract: source と destination を identity-bound handle から解決し、absolute path、traversal、symlink、junction escape を拒否する。
- Canonical owner: Session file service と artifact service。
- Failure mode: rename、copy、binary operation が text API の containment を迂回する。
- Direct verification: Windows junction、symlink、TOCTOU、同一 identity 置換、上限境界 test。
- Review trigger: filesystem destructive boundary のため complete-diff review を行う。
- Gate: ready。

### AUTONOMY-BUDGET-07: 自律実行を有限資源へ収める

- Accepted contract: resource admission は root budget の reserve に成功してから行い、子への allocation 合計は親 allocation を超えない。
- Canonical owner: budget ledger と admission service。
- Failure mode:並列 create、retry、crash、遅延 usage event によって hard cap を超える、または reserve が永久に残る。
- Direct verification: concurrent admission、crash recovery、late reconciliation、exact limit test。
- Review trigger: concurrency と cost boundary のため complete-diff review を行う。
- Gate: ready。

### AUTONOMY-PARITY-08: 全公開 adapter が同じ操作契約を持つ

- Accepted contract: TypeScript contract、application service、raw HTTP、client、CLI、MCP、runtime catalog、managed Skill が同じ operation、schema、error、effect semantics を公開する。
- Canonical owner: `src/session-external-runtime-contract.ts` と shared application operation dispatch。
- Failure mode: CLI または MCP だけで validator、authority、unknown field rejection を迂回する。
- Direct verification: operation 集合同期 test、adapter contract test、strict schema test。
- Review trigger: shared public boundary のため各 slice の complete-diff reviewへ含める。
- Gate: ready。

### AUTONOMY-MIGRATION-09: 既存 Session と Work Item を意味変更で失わない

- Accepted contract:既存 binding、result、aggregation、execution association、idempotency、Root WorkItem history を保持し、新しい event stream へ migration baseline を置く。
- Canonical owner: database schema migration と verifier。
- Failure mode: table rebuild、backfill、repair の途中で既存結果を削除する、権限を過大付与する、再実行で重複する。
- Direct verification:全 supported schema の populated migration、failure injection、二回実行 test。
- Review trigger: migration と authorization のため complete-diff review を行う。
- Gate: ready。

## 実装 slice と依存順

各 slice は別の論理変更、task branch、commit、直接検証、独立 review で閉じる。複数 slice を未検証のまま一つの巨大差分へ積まない。

| 順序 | Slice | 主な成果 | 依存 |
| --- | --- | --- | --- |
| 0 | Root WorkItem baseline | root Session の自己所有 WorkItem と履歴 | 進行中実装の統合 |
| 1 | Shared authority and history cutover | principal、grant evaluator、user decision policy、mutation envelope、既存Roleからbaseline active grantへのmigration、既存全operationのgrant mappingと一括cutover | 0 |
| 2 | Resource budget | root ledger、reserve、reconcile、admission | 1 |
| 3 | Session lifecycle | create拡張、configure、move、clone、restore、archive、delete | 1、2 |
| 4 | Work Item lifecycle | revise、admission時source確定、reassign、move、clone、reopen、archive、delete | 1、2、3 |
| 5 | Result and aggregation correction | result correct、decision correct／withdraw／replace、depth付きread、parent result finalization | 4 |
| 6 | Delegation transaction | create、retry、compensate、cancel | 3、4、5 |
| 7 | Grant routing and transfer | same-root routing、temporary grant consultation、moveによるownership transfer | 1、3、4 |
| 8 | Files and artifacts | file lifecycle、binary、artifact registry と transfer | 1、2、3 |
| 9 | Root management | root query、stop、archive、aggregate result projection、cleanup | 2 から 8 |
| 10 | Role policy cleanup | 残存Role判定を削除し、default grant template、表示、managed Skillを更新 | 7、9 |
| 11 | Integrated release closure | migration rehearsal、full test、build、visual／smoke、cross-slice interaction review | 0 から 10 |

## 個別設計

- `designs/00-shared-authority-and-history.md`
- `designs/01-session-lifecycle.md`
- `designs/02-work-item-lifecycle.md`
- `designs/03-result-and-aggregation-correction.md`
- `designs/04-delegation-transaction.md`
- `designs/05-grants-routing-and-transfer.md`
- `designs/06-files-and-artifacts.md`
- `designs/07-root-management.md`
- `designs/08-resource-budget.md`
- `designs/09-public-api-migration-and-review.md`

個別設計は operation 名を最終 schema として固定するものではない。実装 slice 開始時に accepted contract、consumer、canonical owner を再確認し、同じ capability を少ない operation で表現できる場合は統合できる。ただし、本計画の対象能力を削らない。

## Test と validation の進め方

各実装 slice は test 編集前に `design-tests` を使い、failure mode、consumer、accepted contract、stable owner に最も近い check を選ぶ。TypeScript test を追加または意味変更する場合は、base commit から対象 snapshot までの Git 差分を `review-test-value` の Git mode へ渡し、選択された test へ `@test-value` を置く。

基本 check は次の順で実行する。

1. domain validator、schema、storage、service の targeted test
2. raw HTTP、CLI、MCP、runtime catalog の adapter parity test
3. migration、failure injection、response loss、concurrency test
4. `npm run typecheck`
5. `npm test`
6. `npm run build`
7. UI または filesystem interactionを含む slice の分離 smoke／visual check

## Review workflow

全 slice は public API、永続化、authority、外部副作用、resource limit のいずれかを変更するため、`Full-review gate=run` とする。

1. 実装 branch で対象 slice の直接検証を完了する。
2. 一つの論理変更として commit し、`baseCommitOid` と `reviewCommitOid` を固定する。
3. SessionFolder 配下へ `reviewCommitOid` の clean detached worktree を作る。
4. reviewer へ reviewTarget、両 OID、included／excluded scope、Invariant、実行済み check と OID、review lens、deadline を渡す。
5. finding は `blocking`、`risk-candidate`、`non-material`、`invalid` に分類し、同じ Invariant family の `current-scope repair` だけを修正する。
6. 修正 commit では direct check と finding family の targeted closure を行い、complete-diff review を再実行しない。
7. 全 reviewer 終了後、path、HEAD、cleanliness を確認して review worktree を削除する。

最終 slice では各 slice の complete-diff review を繰り返さず、grant revoke 中の delegation compensation、Session move 中の budget ownership、root transfer 中の artifact ownershipなど、targeted check だけでは直接確認できない cross-slice interaction に限定して review する。

## Knowledge placement

- 後戻り困難な authority、history、resource identity、physical delete、budget accounting の判断は ADR に置く。
- operation、request、response、error、limit は TypeScript contract と executable schema を正本にする。
- validation、state transition、idempotency、migration は executable contract を正本にする。
- CLI、MCP、運用方法は runbook と managed Skill を更新する。
- 本 plan と個別設計は実装順、境界、検証、review の追跡に使い、実装後の field 一覧を重複する恒久仕様にはしない。

## Validation gap

Provider自身のshell、Git、外部service toolはSession Runtime APIを経由しない場合がある。Session Runtimeのgrantだけでは、未委譲の外部副作用を完全には強制できない。

各providerへcapability envelopeを渡せるか、tool effectをWithMate側でbrokerできるか、既存approval／sandboxでどこまで強制できるかをshared authority sliceで調査する。保証できないprovider経路は、実装済みとみなさずvalidation gapとしてruntime catalogへ投影する。外部副作用を形式的に許可したことにして隠さない。

## 完了条件

- 対象能力が全て Agent 向け application operation または明示された composition として利用できる。
- Role は capability ceiling ではなく、default grant template と routing hint に縮退している。
- authority escalation、identity spoof、history overwrite、path escape、unbounded resource use、未委譲外部副作用を直接検出する契約がある。
- Session、Work Item、aggregation、delegation、grant、artifact、root、budget の current projectionを event replay から再構成できる。
- 全公開 adapter、runtime catalog、managed Skill、runbook が一致する。
- supported schema migration、repair、response loss、concurrency、cleanup を直接検証している。
- 各 slice の commit-bound review と最終 cross-slice review に未解決 blocking finding がない。
- typecheck、全 test、build、必要な smoke／visual check が最終統合 commit で成功する。
