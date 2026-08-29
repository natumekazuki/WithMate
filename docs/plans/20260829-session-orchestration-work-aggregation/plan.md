# Session統括 Work Item結果集約 実装計画

## 目的

複数のWork Item結果をcoordinatorが明示的に評価し、採用、除外、再依頼、最終統合へ進めるための契約を追加する。子Work Itemのterminal resultを自由文から推測せず、どの結果を親Work Itemの成果へ採用したかを追跡可能にする。

本計画の対象は、親Work Item単位の集約projection、直属の子Work Itemに対するdecision、再依頼時のreplacement Work Item作成、親Work Itemのresult報告時における集約preconditionである。Agentが作業を分割するpolicyと、Work Item treeまたはresult dashboardのGUIは後続の独立した論理変更とする。

## 現在地

`feat/v6.4.0`には次の契約が統合済みである。

- Session Roleとimmutableなroot、parent、depth binding
- runtime bindingによるactor Session identity
- Agent起点Session間Turnのcommunication authority
- Coordination Event APIの監査、判断、進捗表示境界
- Work Itemのidentity、immutable binding、状態遷移、strict result、execution関連付け

Work Itemは一つの委譲を識別し、target Sessionがterminal resultを報告する。一方、親Work Itemを担当するcoordinatorが複数の直属子Work Itemの結果をどう扱ったか、再依頼をどの元結果から作ったか、親result報告時に未処理結果が残っていないかを表す正規化された契約はない。

## Accepted contract

### 集約scopeと責務

- 集約scopeは一つのactiveな親Work Itemと、その直属の子Work Itemに限定する。
- 孫Work Itemを親集約へ直接flattenしない。task coordinatorは自分が担当する親Work Itemへ直属子の結果を統合し、その親resultを上位coordinatorへ返す。
- Work Item resultは子Sessionが報告した成果の正本であり、集約decisionはcoordinatorがその成果をどう扱ったかの正本である。一方を他方へ複製しない。
- 集約projectionはcanonical Work Itemとdecisionから組み立てる。子result本文のduplicate snapshotを集約recordへ保存しない。
- Coordination Eventは判断や進捗をユーザーへ表示する任意の監査eventであり、集約decisionまたは統合完了の正本にしない。

### Authorityとvisibility

- 親Work Itemのtarget Sessionだけが、その直属子Work Itemに対する採用、除外、再依頼を決定できる。
- decision actorはruntime bindingから確定し、request bodyのSession IDを信頼しない。
- 親Work Itemのtargetは`overall-coordinator`または`task-coordinator`でなければならない。`standalone`と`executor`は集約mutationを行えない。
- root overall coordinatorは同じrootの集約をreadできるが、別Sessionが担当する集約をmutationできない。
- 対象childは`parentWorkItemId`が親Work Item IDと一致する直属子に限定する。兄弟、孫、別root、無関係なWork Itemをdecisionへ関連付けない。
- CLI、MCP、raw HTTPを同じapplication serviceへ収束させ、authority、validation、revision conflictをdecisionまたはreplacement作成より前に確定する。

### Decision

terminalな直属子Work Itemごとに、coordinatorは次のいずれかを明示する。

- `accepted`: 子resultを親の最終成果へ採用する。
- `excluded`: 子resultを親の最終成果へ採用しない。理由を必須とする。
- `retry_requested`: 元Work Itemを変更せず、同じ親配下へreplacement Work Itemを新規作成して再依頼する。

decisionは親Work Item ID、child Work Item ID、decision revision、actor Session、種別、理由、決定時刻を持つ。`retry_requested`はreplacement Work Item IDも持つ。

- `accepted`と`excluded`はresultを持つ`completed`、`partially_completed`、`failed`へ適用できる。coordinatorは親resultのoutcomeとremaining workへ判断を反映する。
- `canceled`はresultを持たないため`accepted`にできず、`excluded`または`retry_requested`だけを許可する。
- activeな子Work Itemにはdecisionを作成しない。
- decisionの上書きやgeneric patchは提供しない。誤ったdecisionは新revisionへ置換する専用操作を持たず、本sliceでは一度確定したdecisionをimmutableとする。
- decision mutationはexpected aggregate revisionとidempotency keyを要求する。同じkeyとfingerprintはcanonical resultへreplayし、異なる入力はconflictとする。

### 再依頼

- 再依頼はdecision保存とreplacement Work Item作成を一つのtransactionでcommitする。
- replacementは元Work Itemと同じ親Work Item ID、root、creatorを持つ。target、goal、scope、completion criteria、authority、source identityは明示inputから新しいimmutable bindingとして保存する。
- replacementのtargetは既存communication authorityでactorから委譲可能な直属Sessionに限定する。元Work Itemと同じtargetを既定値として暗黙採用しない。
- 元Work Itemはterminal状態とresultを保持し、再openまたは内容変更しない。
- response loss、process crash、retryでdecisionだけ、またはreplacementだけを残さない。同じidempotency keyのretryは同じreplacementへ収束する。
- replacement自体がterminalになった後、coordinatorはその結果へ別のdecisionを行う。retry chainを再帰的に自動追跡して採用済みとみなさない。

### 集約projectionとbounded query

- `work.aggregation.get`は親Work Item、aggregate revision、直属子の件数、active件数、terminal未決定件数、accepted件数、excluded件数、retry件数を返す。
- 子Work Itemとdecisionの一覧はkeyset cursorとlimitを持つbounded pageとして返す。全件取得後のadapter filterを正本にしない。
- list itemは子Work Itemのidentity、state、resultの有無と要約、decisionを返す。巨大なresult配列を一覧の全件へhydrateしない。詳細resultは既存`work.get`で取得する。
- cursorは親Work Item、runtime actor、visibility、明示filterへ束縛し、別scopeでの再利用を拒否する。
- aggregate revisionは直属子の追加とdecision mutationで進む。子Work Itemの状態またはresult revisionもfinalization preconditionで検証し、projection取得後のstale resultを黙って統合しない。
- public response上限へ達する前にpageを打ち切り、`nextCursor`を返す。

### 親resultの最終統合

- 直属子を持たないWork Itemのresult報告は既存契約を維持する。
- 直属子を持つ親Work Itemのresult報告にはexpected aggregate revisionを要求する。
- 親resultをcommitできるのは、直属子がすべてterminalで、各子に`accepted`、`excluded`、`retry_requested`のdecisionがあり、retryで作成されたreplacementもterminalかつdecision済みである場合に限る。
- activeな子、decision未確定のterminal子、stale aggregate revisionがある場合は、親Work Itemとresultを変更する前に拒否する。
- 親resultと集約preconditionの検証を同じtransaction境界で行い、検証後に子追加またはdecision更新が割り込んだ状態で親だけterminalにしない。
- accepted resultの本文を親resultへ自動結合しない。coordinatorがstrictな既存result envelopeへ要約、変更、検証、finding、未確認事項、残作業を明示する。
- 親Work Itemのterminal確定後は、直属子の追加と集約decision mutationを拒否する。

### Public API、storage、capability

- aggregation get、bounded list、decision、retry requestをCLI、MCP、raw HTTPから同じapplication serviceへ到達させる。
- operation名、strict input、stable error、result projection、size limitはshared runtime contractで所有する。
- decision、aggregate revision、retry idempotency result、replacement linkageをV6 DBのcanonical storageへ保存する。
- decisionとretry mutationのdomain recordとidempotency resultを同じtransactionでcommitする。
- supported旧schemaからのmigration、空DB bootstrap、partial schema repairで既存Session、execution、Coordination Event、Work Item、resultを保持する。
- `runtime.catalog`はaggregation contract revision、decision種別、operation capability、limitを返す。

## Invariant closure

### AGG-SCOPE-01: 階層と集約scope

- Accepted anchor: coordinatorは自分が担当する親Work Itemの直属子だけを集約する。
- Canonical owner: aggregation application serviceとstorage query。
- Failure mode: 孫の二重集計、cross-root result露出、別coordinatorによるdecision、無関係なchildの混入。
- Direct verification: direct child、grandchild、sibling、cross-root、別actor、root read visibility。
- Independent review trigger: authorityとprojectionが複数adapterへ波及するため、実装commitをtargeted reviewへ渡す。
- Gate: ready。

### AGG-DECISION-02: resultとdecisionの分離

- Accepted anchor: resultは子Sessionの報告、decisionはcoordinatorの採否判断として別recordに保存する。
- Canonical owner: aggregation domain validatorとdecision storage。
- Failure mode: result改変、active childへのdecision、canceled resultの採用、decisionだけのpartial commit、重複decision。
- Direct verification: 各terminal state、active state、decision種別、immutable decision、idempotency replayとconflict、commit failure。
- Independent review trigger: AGG-SCOPE-01と同じtargeted reviewで確認する。
- Gate: ready。

### AGG-RETRY-03: 再依頼のatomicity

- Accepted anchor: retry decisionとreplacement Work Itemを同じtransactionで作成し、元resultを保持する。
- Canonical owner: aggregation retry application serviceとV6 storage transaction。
- Failure mode: decisionだけまたはreplacementだけが残る、異rootや不正targetへ再依頼する、retryで元Work Itemを再openする、response lossでreplacementが重複する。
- Direct verification: transaction failure injection、authority、immutable original、replay、conflict、restart recovery、retry chain。
- Independent review trigger: public mutationとtransactionを跨ぐためtargeted reviewを行う。
- Gate: ready。

### AGG-FINALIZE-04: 親resultの統合precondition

- Accepted anchor: 直属子がterminalかつdecision済みであるsnapshotと親resultをatomicに確定する。
- Canonical owner: Work Item result storage transactionとaggregation precondition。
- Failure mode: active子または未決定結果を残した完了、stale projectionからの完了、finalizationとの同時child追加、親terminal後のdecision。
- Direct verification: active child、undecided terminal child、resolved children、stale revision、concurrent child create、concurrent decision、terminal parent。
- Independent review trigger: concurrencyと複合不変条件のためtargeted reviewを行う。
- Gate: ready。

### AGG-QUERY-05: bounded projection

- Accepted anchor: 集約一覧はparentとactor scopeへ束縛したbounded keyset queryで返す。
- Canonical owner: aggregation storage queryとshared public projection。
- Failure mode: adapter全件filter、cursor scope混同、巨大resultの全件hydrate、response limit超過、private field露出。
- Direct verification: pagination、filter、cursor mismatch、payload limit、root visibility、summary/detail分離、CLI・MCP・HTTP parity。
- Independent review trigger: AGG-SCOPE-01と同じtargeted reviewで確認する。
- Gate: ready。

## Closure Map

- Siblings in scope: aggregation get/list、decision、retry request、親result finalization、V6 migration、runtime catalog、CLI、MCP、raw HTTP。
- Excluded siblings: 自律分割policy、Work Item tree GUI、Coordination Event mutation、Session Role tuple、communication matrix。いずれも別のsemantic ownerまたは後続sliceである。
- Failure timing: validation前、decision commit前、replacement作成中、commit後response loss、restart recovery、親result finalization直前、concurrent child追加またはdecision。
- Aggregate scope: rootではなく親Work Item単位。overall coordinatorのroot visibilityはreadだけへ適用する。
- Projection: listはsummary、既存`work.get`はfull resultを所有する。

## Test design

| Failure mode | Consumer impact | Canonical owner | Observable | Check layer |
| --- | --- | --- | --- | --- |
| 直属でないWork Itemを集約できる | 別taskの結果混入、root越境 | aggregation service | stable authority errorと副作用なし | application integration test |
| decisionとreplacementが片方だけ残る | 再依頼が追跡不能 | V6 transaction | failure後のdecision、replacement、idempotency record | storage integration test |
| stale aggregateから親を完了できる | 未処理結果の取りこぼし | finalization transaction | revision conflictと親active維持 | storage concurrency test |
| retryでreplacementが重複する | 同じ作業が複数Sessionへ依頼される | idempotency owner | retry後のstable replacement ID | application/storage integration test |
| listがfull resultを全件hydrateする | response上限、memory増加 | storage queryとprojection | page size、cursor、summary field | contract/storage integration test |
| adapterごとにauthorityまたはerrorがずれる | client経路で契約が変わる | shared runtime contract | CLI、MCP、HTTPの同一operation result | adapter contract test |

typecheckはdiscriminated unionとstrict inputの整合を確認し、schema testはmigrationとindexを確認する。transaction、authority、concurrency、paginationはmock callではなくV6 storageまたはapplication serviceのobservableで検証する。GUIを変更しないためcomponent testとvisual checkは本sliceのdirect checkに含めない。

## 実装順

1. aggregation domain type、decision validator、aggregate revision
2. V6 schema、decision storage、migration、bounded query
3. shared application serviceとauthority
4. retry decisionとreplacement Work Itemのatomic create
5. 親Work Item result finalization precondition
6. raw HTTP、CLI、MCP、runtime catalog
7. direct contract test、typecheck、全test、build

## 対象外

- Agentが作業分割の要否、分割数、target、依存順を決めるpolicy
- Work Item tree、result dashboard、Session tree navigationのGUI
- 子result本文の自動mergeまたはLLM要約
- Coordination Eventのschema、state、回答、consume契約の変更
- Session Role tuple、child作成matrix、communication authority matrixの変更
- terminal Work Itemの再open、result修正、decision修正
- Agent向けSession delete、delete previewの新規公開
- CodexまたはCopilot実accountへの接続

## 検証と完了条件

- source、type、schema、storage、application service、adapter、executable contractが同じ集約契約を示す。
- AGG-SCOPE-01からAGG-QUERY-05までのdirect checkが現行commitで成功する。
- retry decisionとreplacement、親resultと集約preconditionが各transactionでatomicに確定する。
- authority、scope、pagination、migration、concurrencyに未解決blocking findingがない。
- `npm run typecheck`、`npm test`、`npm run build`が現行commitで成功する。
- required targeted reviewがcommit済みsourceに対して完了し、findingを同じInvariant familyで閉じる。
- validation gap、未実行check、残リスクを区別して報告する。
- 一つの論理変更として通常commitを作成する。
