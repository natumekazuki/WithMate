# Session統括 Work Item 実装計画

## 目的

Session間の委譲を自由文のTurnだけで追跡せず、依頼、実行、結果を対応付けるWork ItemをWithMateの正規化された契約として追加する。

本計画の対象は、Work Itemのidentity、immutableな委譲binding、状態遷移、最小のresult envelope、Turn executionとの関連付けである。複数Work Itemの結果集約と、Agentによる自律的な作業分割の判断は後続の独立した論理変更とする。

## 現在地

`feat/v6.4.0`には次の契約が統合済みである。

- Session Roleとimmutableなroot、parent、depth binding
- runtime bindingによるactor Session identity
- Agent起点Session間Turnのcommunication authority
- target executionを正本とする送信元SessionWindow projection
- Coordination Event APIの監査、判断、進捗表示境界

現行のexecutionは一回の`turn.run`または`turn.enqueue`を識別し、状態とterminal resultを保持する。一方、一つの委譲を複数Turnや再依頼にまたがって識別するdomain objectはない。Work Itemをexecutionの別名にせず、委譲の正本として追加する。

## Accepted contract

### Work Itemとexecutionの責務

- Work Itemは一つの委譲を識別し、goal、scope、完了条件、authority、対象source、結果を所有する。
- executionは一回のTurn実行を識別し、queue、実行、interaction、取消し、terminal resultを所有する。
- 一つのWork Itemへ複数executionを関連付けられる。executionの失敗または完了だけでWork Itemを暗黙にterminalへ遷移させない。
- Work Itemの完了、部分完了、失敗は、対象Sessionによる明示的なresult報告で確定する。
- Coordination EventはWork Itemの状態やresultの正本にしない。必要な進捗や判断を表示する任意の監査eventとして維持する。

### Identityとimmutable binding

Work Itemはserver生成のstable IDとcontract revisionを持つ。作成後、次のbindingは変更しない。

- `rootSessionId`
- 作成したactor Session
- 作業を担当するtarget Session
- 任意のparent Work Item
- goal、scope、完了条件、authority
- workspace、repository、branch、baseまたはheadなど、作成時に明示されたsource identity

Session Role bindingへWork Item IDを追加せず、Role contract revision 1を維持する。Sessionは複数Work Itemを順次扱えるため、Work ItemからSessionを参照する。

parent Work Itemを指定する場合は、同じrootに属し、作成actorが担当するactiveなWork Itemでなければならない。これにより、後続の自律分割でWork Item treeを追加しても、Session treeと異なるrootへ委譲が漏れないようにする。

### Authority

- Work Itemを作成できるのはruntime bindingで確定した`overall-coordinator`または`task-coordinator`である。
- target Sessionは、既存のSession間Turn communication authorityでactorから送信可能な直属の委譲先でなければならない。self targetはWork Item作成の対象外とする。
- `standalone`と`executor`はWork Itemを作成できない。
- target Sessionは自分が担当するWork Itemの開始、待機、再開、result報告を行える。
- 作成actorは自分が作成した非terminal Work Itemを取消せる。
- root、actor、target、parent Work Item、Roleをrequest bodyの自己申告だけから導出しない。canonical Session storageとruntime bindingで検証する。
- GUI上のユーザー操作へAgent authorityを流用しない。本sliceではWork ItemのGUI mutationを追加しない。

### 状態遷移

状態は少なくとも次を区別する。

- `pending`: 作成済みで、対象Sessionがまだ開始していない
- `in_progress`: 対象Sessionが作業中
- `waiting`: 外部判断、依存、追加情報などを待っている
- `completed`: 完了条件を満たしたresultを報告済み
- `partially_completed`: 一部を完了し、残作業または未確認事項を伴うresultを報告済み
- `failed`: 完了できなかったresultを報告済み
- `canceled`: 作成actorが取消しを確定した

許可する遷移を閉じたtableとして実装し、terminal状態から別状態へ戻さない。状態mutationはexpected revisionまたは同等の競合検出とidempotency keyを要求する。validation、authority、revision conflictはstorage mutationより前に確定させる。

### Result envelope

terminal resultは自由文一個ではなく、少なくとも次を区別できるstrictな構造とする。

- outcome
- summary
- changes
- verification results
- findings
- unverified items
- remaining work
- terminal timestampとreporting Session

`completed`、`partially_completed`、`failed`とresult outcomeを不整合な組み合わせで保存しない。secret、token、巨大なraw log、無制限のpayloadを保存しない。個別executionのassistant textをWork Item resultへ暗黙コピーしない。

### Public APIとprojection

- create、get、bounded list、状態遷移、result報告、取消しをCLI、MCP、raw HTTPから同じapplication serviceへ到達させる。
- listはroot、actor、target、stateなど、authority内の明示filterとkeyset cursorを持つbounded queryにする。全件取得後のadapter filterを正本にしない。
- createとmutationはidempotency keyを必須とし、同じkeyと同じfingerprintをcanonical resultへ再生し、異なる入力をconflictとして拒否する。
- Work Itemに関連付ける`turn.run`と`turn.enqueue`はoptionalなWork Item IDを受け取れる。指定時はWork Itemのroot、actor、target、active stateをexecution作成前に検証し、executionへWork Item IDを正規化して保存する。
- `turn.get`、`turn.list`、`turn.run`、`turn.enqueue`のpublic execution projectionは、関連付けられたWork Item IDを同じ形で返す。
- `runtime.catalog`はWork Item contract revision、対応状態、mutation capability、limitを返す。clientが機能の有無をpromptから推測しない。

### 永続化とmigration

- Work Item、state transition、result、idempotency result、execution associationをV6 DBのcanonical storageへ保存する。
- create、transition、result、cancelの各mutationは、対象recordとidempotency resultを同じtransaction境界でcommitする。
- response loss後のretryは同じkeyへ収束し、再起動後も同じprojectionを復元する。
- supported旧schemaからのmigration、空DB bootstrap、partial schema repairを区別し、既存Session、execution、Coordination Eventを失わない。
- Session削除時は、active Work Itemまたは未回収resultを暗黙に削除しない。本sliceではAgent向けSession deleteを追加せず、既存の削除拒否またはpreview境界へ必要な保護を追加する。

## Invariant closure

### WORK-IDENTITY-01: 委譲identity

Work Item IDは委譲を一意に識別し、Session ID、execution ID、message IDを代用しない。immutable bindingの一部だけを更新できる入口を作らない。

直接検証では、create replay、idempotency conflict、restart load、parent Work Item、異root、binding改変を確認する。

### WORK-AUTH-02: mutation authority

全public adapterはruntime binding actorとcanonical Work Item、Session Role bindingを使う同じapplication serviceへ収束する。拒否はWork Item、execution、queue、eventの副作用前に確定する。

直接検証では、Role、root、親子関係、creator、target、self target、cross-root、別actor、trusted GUI境界を確認する。

### WORK-STATE-03: 状態遷移と競合

Work Itemの状態は閉じた遷移table、expected revision、idempotencyによって更新する。terminal状態を再開せず、同時mutationで一方を黙って上書きしない。

直接検証では、全許可遷移、全terminal状態、不正遷移、stale revision、同時更新、response loss replayを確認する。

### WORK-RESULT-04: result整合性

terminal stateとresult outcomeを一つのtransactionで保存し、resultの一部だけ、またはterminal stateだけを残さない。result schemaとsize limitを全adapterで共有する。

直接検証では、completed、partial、failed、oversize、unknown field、commit failure、restart recoveryを確認する。

### WORK-EXEC-05: execution association

Work Itemへ関連付けたexecutionは同じrootとtargetを持ち、Work Itemがactiveな間だけ作成できる。execution terminal stateからWork Itemを暗黙に完了させない。

直接検証では、run、enqueue、replay、queue、target mismatch、terminal Work Item、execution list/get projectionを確認する。

## 実装順

1. Work Item domain type、strict validator、状態遷移table
2. V6 schema、storage、migration、idempotency
3. shared application serviceとauthority
4. execution associationとpublic projection
5. raw HTTP、CLI、MCP、runtime catalog
6. direct contract test、typecheck、全test、build

## 対象外

- 複数Work Itemの結果集約、採用、再依頼、統合判断
- Agentが作業分割の要否や分割数を決めるpolicy
- Work Item treeまたはresult dashboardのGUI
- Session tree navigation
- `turnPurpose`
- Coordination Eventの状態、回答、consume契約の変更
- Session Role tuple、child作成matrix、communication authority matrixの変更
- Agent向けSession delete、delete previewの新規公開
- CodexまたはCopilot実accountへの接続

## 検証と完了条件

- source、type、schema、storage、application service、adapter、executable contractが同じWork Item契約を示す。
- WORK-IDENTITY-01からWORK-EXEC-05までのdirect checkが現行commitで成功する。
- migration、authority、状態遷移、result commit、execution associationの未解決blocking findingがない。
- `npm run typecheck`、`npm test`、`npm run build`が現行commitで成功する。
- validation gap、未実行check、残リスクを区別して報告する。
- 一つの論理変更として通常commitを作成する。
