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

Slice 1 の開始コミット `890aa0e5b29834c82d73e907b979b83c2323e4dc` では、Agent 向け公開面は `SESSION_RUNTIME_OPERATIONS` の 38 操作である。操作集合は registry を正本とし、この件数を固定の契約にはしない。Root WorkItem の改訂と履歴操作も切り替え対象に含む。

`docs/plans/20260830-session-root-work-item/plan.md` に基づく Root WorkItem 実装は、Slice 1 の開始コミットへ統合済みである。v6.3.26 との統合検証と review closure は `docs/plans/20260905-v6326-v640-integration/plan.md` に記録されている。統合済みの Root WorkItem を基準に後続 contract revision を追加する。

Root WorkItem 計画の次の判断は、本計画の対応 slice が統合された時点で置き換える。

- delegated WorkItem の作業契約は永久不変ではなく、権限を持つ actor が着手前または明示的な再交渉後に改訂できる。
- terminal WorkItem は履歴を維持した successor revision として再開できる。
- Role と communication policy だけを authority ceiling にせず、ユーザー起点の attenuating grant を正本に加える。
- root Session の目的継続は、新規 root Session だけでなく、Root WorkItem の明示的な reopen または successor でも表現できる。

Root WorkItem の一意性、自己所有、Session 作成との原子性、append-only history、既存 delegated row の保存は維持する。

## v6.4.0 リリース前の実装運用

本計画の実装中は、v6.4.0 の Work Item 機能を作業管理に使用しない。実装 Session の起動と引継ぎには、Git Worktree と SessionFolder 配下の自己完結した初回プロンプトを使用する。Work Item の作成、更新、集約を前提にした自動統括は、v6.4.0 のリリースと導入が完了するまで行わない。

Root WorkItem の統合を受け、`Shared authority and history cutover` を `feat/v6.4.0-shared-authority-history` で開始した。開始条件は次のとおりである。

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
| 0 | Root WorkItem baseline | root Session の自己所有 WorkItem と履歴 | 開始コミットへ統合済み |
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

### Slice 1 の Closure Map

開始コミットは `890aa0e5b29834c82d73e907b979b83c2323e4dc`。対象は開始時の 38 操作と、その保存、GUI の判断入力、provider binding である。新しい lifecycle、grant の公開 CRUD、budget ledger は対象外とする。budget の段階導入を承認済み契約として、以下の実装 gate を ready とする。

| Invariant | 契約根拠と canonical owner | 兄弟入口と failure timing | 直接検証 |
| --- | --- | --- | --- |
| AUTONOMY-USER-01 | `designs/00-shared-authority-and-history.md` の User decision。interaction と Coordination の保存済み decision class が回答可否を所有する | Agent HTTP/CLI/MCP と trusted GUI。receipt 偽装、古い revision、provider continuation の commit 後失敗 | service/storage integration で拒否、保存 principal、履歴、effect を確認 |
| AUTONOMY-GRANT-02 | 同設計の grant subset と baseline cutover。authority service と grant storage | 親子 grant、template、失効、期限、兄弟 Session。DB writer lock 取得前後の revoke | evaluator と populated DB integration で権限縮小、revision、rollback を確認 |
| AUTONOMY-IDENTITY-03 | 同設計の principal。runtime binding と canonical resource relation | 全 38 操作、list cursor、provider generation、GUI。caller の actor/root/owner/issuer field | strict adapter validation と service scope/generation integration |
| AUTONOMY-HISTORY-04 | 同設計の event contract。resource ごとの event payload と共通 provenance header | WorkItem、aggregation、Session、execution、interaction、Coordination、file preparation。baseline と更新の境界 | event replay と projection、principal と根拠 grant の一致 |
| AUTONOMY-MUTATION-05 | 同設計の mutation envelope。各 storage transaction | create、existing mutation、既存 file/provider の preparation と recovery。commit 前、commit 後通知、response loss | transaction failure injection、canonical replay、別 payload conflict、部分 effect |
| AUTONOMY-PARITY-08 | `designs/09-public-api-migration-and-review.md` の Public surface parity | TypeScript、application、HTTP、CLI、MCP、catalog、managed Skill | 集合同期、strict input/output、型検査、build |
| AUTONOMY-MIGRATION-09 | `designs/00-shared-authority-and-history.md` の Baseline migration と ADR 028 の既存 row 保持 | fresh/populated schema、再実行、startup verifier。Role fallback は除外 | root 一意性、binding、result、aggregation、execution association、idempotency の移行前後比較 |

grant の確認だけを service の事前チェックに置かず、各 resource の transaction 内で同じ DB 接続から根拠 revision を確認する。既存の filesystem/provider 操作は、永続化した preparation/execution admission を失効との順序確定点とし、以後は同じ operation の回復として結果を保存する。file の競合は既存 identity-bound proof で検証し、未実装の file revision を作らない。

認可、永続化、公開境界を横断するため complete-diff review を一度実施する。固定 commit での grant escalation、receipt 偽装、revoke/replay、private projection を review lens とする。実装と直接検証の結果、commit-bound evidence は完了時に追記する。

各実装 slice は test 編集前に `design-tests` を使い、failure mode、consumer、accepted contract、stable owner に最も近い check を選ぶ。TypeScript test を追加または意味変更する場合は、base commit から対象 snapshot までの Git 差分を `review-test-value` の Git mode へ渡し、選択された test へ `@test-value` を置く。

### Slice 1 の進捗

2026-09-06 時点で、開始コミットからの principal、grant evaluator、user decision policy、共通 mutation envelope、resource history、baseline migration、38 操作の authority mapping、application／HTTP／CLI／MCP／runtime catalog／managed Skill の切り替えを実装した。Root budget の ledger と admission は承認済みの段階導入に従い Slice 2 に残し、runtime catalog では未実装として公開する。

実装コミット `e88abf85cd111c3360e2bc78d35cc68cb940da41` を固定した complete-diff review では、非 root Session が自身の作成した Work Item を参照できない可視性欠落と、Session／execution event payload から current projection を再構成できない履歴欠落の二件を blocking と分類した。修正では Work Item の creator-or-target list と created get を mapping revision 2 のgrantへ追加し、Session／execution の各eventへ schema revision 2 の完全な projection snapshot を保存してstartup replay verifierでcurrent rowと照合する。baseline verifierもRole templateの必須permission全体を検証する。

修正コミット `35b91295fa78bbc5c4c084360c7010b3f96237be` のtargeted reviewではWork Item可視性をclosedと判定した。履歴については、source Session削除時にsource-owned origin rowがcascadeし、target-owned execution projectionとevent snapshotが不一致になる兄弟lifecycleを追加のblockingと分類した。originはexecutionのcanonical replay対象から外し、target executionを保持したsource Session削除後のreplayを直接検証した。追加修正コミット `5671a9cf999d87d6ff58674484bcc7c6219e5d17` のresulting delta reviewはapproveで、対象finding familyに未解決blocking、validation gap、残リスクはない。

続くreviewでは、通知先grantの失効競合、Session通常削除によるretention履歴とidempotencyの消失、baseline grantの過剰許可とrevoke後の起動失敗、全resourceのstartup replay検証不足、raw client／CLIの公開応答未検証、MCPだけ異なるunknown field errorをblockingと分類した。修正コミット `04a5f6c1` は通知先proofをexecution admission transactionへ渡し、baseline grantをRole templateの完全一致として検証してmigration完了とactive authorityを分離した。`ce4c4ede` はapplication dispatch前とraw client受信後にcanonical response validatorを適用し、CLIとMCPのversioned error semanticsを統一した。`45ad0622` はSession通常削除をtombstone化し、retention対象の履歴とretry identityを保持した。`0af8fdcf` は全typed eventと共通headerを照合し、Work Item、aggregation、Session、execution、interaction、Coordination、file write、transcript exportのprojectionまたはledgerをstartupで再生検証する。

固定コミット `b5759d47aaab7eeb78326685d691f6c6fdeae504` のtargeted closureでは、H-01、H-02、M-01、M-02、M-04、M-05とmain IPC test-valueをclosedと判定した。M-03は、startup前のbackfillが欠落履歴を再生成すること、Work ItemとCoordination createdのprincipal誤帰属および存在しないgrant revisionを受理すること、interactionの途中revisionとsupersedes参照先を検証しないこと、file write／transcript export ledgerのterminal resultをeventから照合しないことを未解決blockingと判定した。追加修正ではresource history migration markerでbackfillを初回migrationに限定し、Work Item typed eventへprincipal kindを保存する。さらにgrant eventの同一revision、interaction履歴の連続性とsupersedes参照先、sagaのoperation identity・principal・path・terminal resultをstartup verifierで照合する。

最初のreview修正後の直接検証は `npm run typecheck`、`npm test`（3452 tests、3451 pass、1 skip、0 fail）、`npm run build`、`git diff --check` を通過した。今回のblocking修正後は`npm run typecheck`、`npm run build`、`npm test`（3458 tests、3457 pass、1 skip、0 fail）、`git diff --check`を通過した。全testの初回実行ではWork Itemの履歴backfillとprojection repairを同じmarkerで抑止していたため、partial schema repair testが失敗した。typed eventとheaderの生成だけを初回migrationへ限定し、既存履歴からのaggregation projection再構築は再実行可能に戻した後、対象testと全testの再実行が成功した。`review-test-value`のGit modeは開始コミットからのTypeScript test 141件を診断0で抽出し、今回追加または意味変更したrecordはclaim、failure mode、observableの対応を確認して全件`ACCEPT`とした。

修正コミット `a7c459b6964610c0b72f367ea50079358f25917c` のexact-source reviewでは、interaction、Coordination、file write、transcript exportを含む再生照合をclosedと判定した。一方、Settings resetがmigration markerを消してlegacy backfillを再有効化する経路と、system principalによるRoot Work Item created eventのtyped actor誤帰属を受理する経路をM-03の残存blockingと判定した。追加修正コミット `f45339b0d105c06b788e2eef3c0fdc72a71800cb` はreset対象を利用者設定keyへ限定して内部markerを保持し、Root Work Itemのtyped actorをcanonical target Sessionと照合する。

`f45339b0d105c06b788e2eef3c0fdc72a71800cb` のtargeted closure reviewはapproveで、M-03の残存2件をclosedと判定した。対象test 58件、`npm run typecheck`、`npm run build`、`git diff --check`は成功した。全testは3459件中3457件成功、1件skip、画像preview lifecycleの1件が30秒でtimeoutしたが、同一testの即時単独再実行は93 msで成功したため、このfailureは対象変更外のflaky validation gapとして扱う。追加または意味変更したtest 2件は現行`review-test-value`のGit modeで診断0となり、両方を`ACCEPT`とした。対象finding familyに未解決blocking、accepted risk、残リスクはない。

2026-09-07 の追加指摘3件は `38fa9821` で修正した。起動時のbaseline補完は委譲由来を含む既存grantを認識し、子Sessionのrevoke後も独立system grantを追加しない。GUI・scheduler・通知の内部enqueueは非同期検証とSession lock待機後にrevisionを取得し、外部要求の明示revisionはそのまま保存境界で照合する。ファイル書き込みとtranscript exportは、新規受付時のoperation IDへUUIDを追加し、期限後の同一キー再利用を保持済み履歴から区別する。期限内の再送と既存履歴の照合は維持する。

追加の回帰4ケースと関連既存test 174件、`npm run typecheck`、`npm run build`、`git diff --check` が成功した。全suiteとGUI目視は今回再実行していない。`review-test-value`は今回のbase `271e0b06` から3宣言を抽出し、専用審査の最終generationで全件`ACCEPT`、全体`PASS`、未解決項目なしとなった。審査途中のツール契約変更による停止と、内部原因を直接観測するように読めるmetadataへの指摘を解消し、test本文を変えずにfault記述を実際の観測結果へ合わせた。

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

### Slice 2 の実装・検証対象

Root ledger、原子的な予約と精算、Session／Work Item作成数、実行queue、Provider retry／使用量、SessionFolderの仲介書き込み、Settingsからの上限・期限延長を接続した。初期policyは2026-09-07のユーザー指定を採用し、token・費用は計測のみとする。設計の採用方針とADR 030を正本とする。

| Direct validation | 実在する検証入口 |
| --- | --- |
| 同時予約・exact limit・子配分 | `scripts/tests/resource-budget.test.ts` の独立process競合と配分／親予約 |
| replay・crash・late usage・deadline延長 | budget storageと`session-execution-service.test.ts`、`session-runtime-service.test.ts` |
| grant revoke・migration保持 | `session-authority.test.ts`、budget ledger verifier |
| Session／Work Item累積数 | `session-crud-service.test.ts`、`work-item-contract.test.ts` |
| 仲介書き込み・実容量・不明時停止 | `resource-budget-files.test.ts`、既存file／transcript tests |
| public parity・trusted Settings | runtime contract/application/HTTP/CLI/MCP tests、IPC sender test |
| soft alert通知 | `provider-prompt.test.ts` の次Turn system context |

容量はRoot共有枠とし、子別容量配分は提供しない。Providerや利用者によるSessionFolderの直接編集は事前予約外で、観測時に不明・超過なら新規dispatchを止める。canonical execution IDを経由しないauxiliary／companionの直接Provider実行は、Turn・retry・generation使用量ledgerの保証外とする。delegation resource、move、transfer、artifactの接続は後続Sliceで扱う。

ledgerとtombstoneはreplay・遅延精算のため保持し、通常削除や設定延長で消去しない。公開使用量明細は最大100件と集約値を返す。長期Rootの自動交代・履歴圧縮はこのSliceで追加しない。

### Slice 2 の完了記録

2026-09-07、開始コミット`d5917a9cc455be879afa9e7f78bec3d8cc4a41ec`からの実装を`1025e2980bd01800dd592796e79a6871dc4be68c`へ固定した。Settingsで上限または期限を延長すると、同じRootの消費済み使用量・履歴・terminal結果を保持して保留queueを再開する。token・費用は上限管理に含めず、観測できない値をunknownとして扱う。

clean detached worktreeでの独立complete-diff reviewは、cancel grace後の途中usageが遅延した最終usageと競合する問題と、`budget.configure`のruntime入力制約と公開JSON Schemaの不一致をblockingとして採用した。修正コミット`c10e3468163aaa1eb4449a538ac69ff892317302`では、Provider実終了待ちの間はgenerationをunknownのまま保持し、late observerだけが最終usageを確定する。設定入力の空map・変更なし・子配分とpolicy変更の併用・子storageの数値指定は、runtimeと公開schemaの両方で拒否する。同じ2件のfinding familyに限定したtargeted closureは両件closed、新たな回帰なしとなった。review worktreeは終了時のHEAD・cleanlinessを確認して削除した。

`c10e3468163aaa1eb4449a538ac69ff892317302`上で`npm test`（3490件、3489 pass、1 skip、0 fail）、`npm run typecheck`、`npm run build`、`git diff --check`が成功した。skipはWindowsで対象外のPOSIX symlink testである。全体testの今回の成功は確認したが、Slice 1で記録したflakyの恒久解消を示すものではない。Settingsの実component入力・応答消失後の再保存・成功後のrevision更新は自動testで確認し、Electron分離起動によるGUI目視は未実行である。

同じコミットのclean snapshotを、開始コミットから現行`review-test-value`のGit modeへ渡した。独立native CLIによるLuna metadata／alignmentとrequired Sol、保持根拠、過去の削除・置換義務を含む最終generation `g000005`は45件すべてPASS、全体PASS、未解決0となった。途中のmetadataと観測範囲の不一致は修正し、不正なworker出力・実行失敗は非成功として残した。審査対象snapshotは`sha256:38740bbab453de6745eb1254fe8ca41cb3190efc1bfdbdc9593dd37ed37a9ba6`であり、この完了記録だけを追記する後続commitではsource・test・契約を変更しない。

2026-09-08の追加指摘2件を`eab243f6ab64bd000b4829c4f261a1bc7fc0b370`で修正した。file writeとtranscript exportの保存容量予約には、保存処理が既に永続化しているSaga operation IDを使用する。別principalの同じidempotency keyと、terminal期限後の新規受付を別予約にし、同一操作の再送は同じIDを維持する。共通copy／pasteはCompanionStorageに実在するSessionだけ予算対象外として保存し、通常Sessionと未知のIDには従来の予算チェックを適用する。

関連49 test、型検査、build、`git diff --check`が成功した。実SQLite・実ファイルで、5 bytes上限へ別principalが3 bytesずつ書く場合に2件目がファイル作成前に拒否されることと、transcript exportの同じ境界を確認した。固定commitのtargeted closureは両指摘closed、同familyの追加不具合なしとなった。今回の開始commit `d7b35d0887ba39e4a9ec09f040933e0c1817fe0e`から現行`review-test-value`で抽出した4 recordは通常のread-only `general_luna`で審査し、operation IDの存在・rejected replay時の保持に関するassertion不足と、null予算testのmetadataを補正した。変更したstorage test 3件の再実行と指摘解消の確認が完了し、未解決項目はない。全suiteとGUI目視は今回再実行していない。

同日のqueue再開に関する追加指摘2件を`985d6e1a482cfd5137fe3ad1033dfb3adb5c8f70`で修正した。公開`budget.configure`は保存結果のRootに対して`resumeRootQueues`を待機し、設定変更後に保留queueを再評価する。子allocationの期限切れはaccount・grant chain全体を確認して専用reasonを返し、そのreasonだけをdispatch保留にする。revoke、無効grant、親account欠落を期限切れと誤分類しない。

同commitのproduction sourceで全体testは3495件中3494 pass、1 skip、0 fail、型検査・build・`git diff --check`も成功した。全体testで発見した前回のtranscript storage返却値へのoperation ID追加に対する期待値追随漏れも補正した。固定commitの独立targeted closureは両指摘closed、同familyの追加不具合なし。開始commit `ca4eab8682051ed0184d7c74b38c99387c4ed28f`から抽出したtestは通常のread-only `general_luna`で審査し、型外入力を除去、非expiry authority errorの失敗確定、configure結果のRootと呼出順を補強した。補強後の関連92 testと型検査は成功し、production sourceは変更していない。最終抽出は5 record、diagnostic 0で、指摘とmetadataの観測範囲を修正して未解決項目を解消した。GUI目視は未実行である。

### Slice 1 の budget 段階導入

2026-09-05 のユーザー承認により、Slice 1 は principal、grant、decision、revision、history の切り替えを行い、root budget の ledger、reserve、reconcile、admission は Slice 2 で接続する。Slice 1 では既存の操作別上限を維持し、budget が未実装であることを runtime catalog に明示する。既存上限を root budget の保証と扱わず、無制限の値、評価成功を返す代用品、架空の allocation reference を作らない。

AUTONOMY-BUDGET-07 の reserve と allocation の検証は Slice 2 の完了条件とする。Slice 1 の grant は未実装の budget を根拠に権限を増やさず、既存操作の baseline を超える新規能力を発行しない。この段階導入は Role authority cutover と履歴整合を延期する理由にはしない。

### Provider の直接実行経路

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


### Slice 3 の作業状況（2026-09-12、独立レビュー前）

開始コミットは `7c30c31922dbdd71f77b36da716bd363482c4163`。Session lifecycle に必要な回復記録の拡張と、Root WorkItem successor・cross-root transfer の内部処理の前倒しはユーザー承認済みである。後続 Slice の公開 WorkItem lifecycle、delegation transaction、grant routing 全体は追加していない。

作業中の実装では、root/child construction の明示 tuple・grant ceiling・budget、binding revision を捕捉する execution、configure、clone、root/child restore、archive、idle subtree の cross-root transfer を lifecycle owner に接続した。root restore は terminal predecessor の successor を追加し、既存 root budget と累積消費を保持する。active Root WorkItem を伴う root 移管は開始前に拒否する。

2026-09-09 の作業treeで `npm run typecheck`、`npm test`（3529件、3528 pass、1 skip、0 fail）、`npm run build`、`git diff --check` が成功した。固定commitでの検証記録ではない。binding/terminal変更による既存thread保存とConversation Timingの回帰、空DBへのbinding migration marker追加、失効済みgrantのstartup検証を修正した。回復は101件以上のpendingも処理する。GUI目視は未実行。

物理purgeはユーザー承認により別変更へ分離し、今回の完了条件に含めない。既存の通常削除は履歴・ledger・retry identityを保持するtombstoneであり、SessionFolder workspaceも保持する。directory workspaceに付随するSessionFolderの既存cleanup経路は維持する。tombstone deleteの共通owner接続はSlice 3の範囲とし、保持期間・purge範囲を定義するphysical purgeは別変更へ分けることをユーザー承認済みとした。削除のGUI/API統合は完了した。test-value review、固定commitでのcomplete-diff reviewとtargeted closureが残っている。

レビュー指摘の通常Session削除、移動前execution履歴のroot帰属、GUIのCodex Speed／Reviewer保存、move manifestの移動先入力、Copilot標準agentの空文字tupleを修正した。履歴は書き換えず、executionのbindingまたはlegacy execution作成時点の移動履歴から当時のrootを解決する。

2026-09-12 の最終作業treeで型検査、build、関連公開境界54 testが成功した。全testは3537件中3534 pass、2 fail、1 skip。変更外のGlossary queue解放testは全体実行時に待ち時間超過となり、同ファイルの単独実行24件は成功した。変更外のtranscript予算testは固定期限 `2026-09-12T00:00:00.000Z` を過ぎたことで失敗した。期限判定を弱める変更はしていない。GUI目視は未実行。

test-value初回審査の指摘に基づき、旧facade cleanup 3件と旧CRUD cleanup 2件を共通owner routing・実DB補償testへ整理した。metadata追加と宣言名変更が同じhunkにある場合のextractor境界判定を作業用コピーで修正し、既存87 testとPython／TypeScriptの追加回帰を通した。開始baseや対象recordの手動変更はせず、Git差分から67 tests／67 transitionsをdiagnostic 0で抽出した。通常のread-only general_lunaによる全recordの最終審査を進めている。

追加審査で、一括削除の通常Session／Character作成用Sessionのowner振り分けを修正した。通常Sessionはlifecycle、Character作成用Sessionは既存persistenceへ渡し、最終利用日時によるcanonical候補IDを保持する。facade34件、persistence25件、binding5件、authority15件、move6件、creation5件、clone1件、lifecycle service/storage13件、CRUD5件の関連検証と型検査・buildが成功した。
