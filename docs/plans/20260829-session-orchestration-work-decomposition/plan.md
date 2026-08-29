# Session統括 Work Item自律分割 実装計画

## 目的

Agentが依頼を必要な場合だけ子Sessionと子Work Itemへ分割し、各結果を既存の集約契約で回収できる実行policyを、WithMateが配布する`withmate-session` Skillへ追加する。

本sliceでは、作業分割の要否、粒度、Role、依存順をAgentの判断として扱い、WithMateが所有するRole、authority、Work Item、Turn、集約の強制契約と混同しない。新しいdecomposition resource、永続化table、`work.decompose` API、GUIは追加しない。

Base commitは`8183c689ce062de857958334827b4d76dcc03497`とする。task branchへの通常commitまでをauthority内とし、pushとPR作成は行わない。

## 現在地

`feat/v6.4.0`には次の契約が統合済みである。

- Session Roleとimmutableなroot、parent、depth binding
- Agent起点Session間Turnのcommunication authority
- Work Itemのidentity、状態、strict result、execution関連付け
- 親Work Itemのtarget coordinatorによる直属子の集約、採否、再依頼、親result finalization
- CLI、MCP、raw HTTPで共有するstrict operation contractとruntime catalog

これらのoperationを組み合わせれば、coordinatorはchild Sessionを作成し、Work Itemを割り当て、Turnをdispatchし、結果を集約できる。一方、配布Skillには「いつ分割するか」「`task-coordinator`を挟むか」「依存作業をいつdispatchするか」を一貫して判断するpolicyがない。既存の強制契約を重複実装せず、この判断と安全な操作順だけをAgent向けinstructionとして閉じる。

## Accepted contract

### Agentが所有する分割policy

- 単一責務で一つのSessionが直接検証まで閉じられる作業は分割しない。
- 独立して検証できる複数責務、異なるworkspaceまたはsource owner、依存順を持つ実装と検証、独立した反例探索が必要な場合だけ分割する。
- `overall-coordinator`は、独立した一つの委譲には直属`executor`を使う。一つのtask内で複数slice、依存関係、統合、review収束を管理する必要がある場合だけ直属`task-coordinator`を使う。
- `task-coordinator`は直属`executor`へだけ分割する。常に最大depthまで階層を作らず、Role contractが許す深さをpolicy上の目標に読み替えない。
- 一つの子Work Itemは、一つのcoherentな委譲とする。goal、scope、完了条件、authority、source identityを明示し、重複scopeと所有者不明の統合作業を作らない。
- 並列dispatchは相互に独立した子だけへ行う。依存する子は先行resultのdecision後に作成またはdispatchし、依存graphを自由文だけで同時実行しない。
- 分割数は「最小限必要な子」に抑え、runtime catalog、Role、queue、response limitを超える独自上限をSkillで捏造しない。
- 子resultはadoption candidateとして検証し、親Work Itemのtarget coordinatorが既存aggregation decisionとstrict parent resultで統合する。

### WithMateが所有する強制契約

- `session.self`と`runtime.catalog`を正本としてactor、Role、child Role、最大depth、provider capabilityを確定する。
- `session.create`はcanonical parentからroot、parent、depth、Characterを導出し、許可されたchild Roleだけを作成する。
- `work.create`はruntime actor、canonical target、任意のactive parent Work Item、immutable delegation bindingを検証する。
- `turn.run`または`turn.enqueue`は、Role/hierarchy authority、target、active Work Item、queue admissionを検証する。
- Work Itemの状態とresultはexecution stateから推測せず、target Sessionの明示mutationを正本とする。
- `work.aggregation.*`と親result finalizationは、直属子、decision、replacement、aggregate revisionを正本とする。
- WithMateが拒否した構造を、自由文Turn、別root、caller申告Role、Work Itemなしの追跡へfallbackして迂回しない。policyを組み直すか、結果を変える判断が必要ならユーザーへ確認する。

### 安全な操作順と回復

1. `session.self`と`runtime.catalog`でactorとcapabilityを確認する。
2. 現在のWork Itemと責務を確認し、分割しない選択を先に評価する。
3. 子ごとにRole、goal、scope、完了条件、authority、source identity、依存順を決める。
4. caller-owned idempotency keyで`session.create`し、`session.get`でworkspace identityを確認する。
5. 別のidempotency keyで`work.create`し、親Work Itemがある場合は明示する。
6. `turn.options`の現行tupleからTurnを構築し、Work Item ID付きで`turn.run`または`turn.enqueue`する。
7. response lossまたは`effect: indeterminate`では、既知のSession、Work Item、executionをread-backし、変更していないmutationだけを同じkeyで再送する。別operationへ切り替えない。
8. 子Work Itemを明示的にterminalへ確定し、親coordinatorが直属子をdecision後に統合する。

Session作成とWork Item作成を一つのatomic batchとは扱わない。Session作成後に後続操作が失敗した場合は、canonical Sessionをread-backして同じ分割計画を再開する。存在するchild Sessionを成功不明として重複作成しない。

## Invariant closure

### DECOMP-POLICY-01: 必要な場合だけ分割する

- Accepted anchor: 単純作業は`overall-coordinator -> executor`、複数slice、依存、統合、review収束が必要な場合だけ`task-coordinator`を挟む。
- Canonical owner: 配布`withmate-session` Skillのdecomposition section。
- Failure mode: 全作業を最大階層へ展開する、単一責務を細切れにする、独立していない作業を並列dispatchする。
- Observable: Skill本文がno-split基準、direct executor基準、task coordinator基準、dependency sequencingを明示する。
- Direct verification: managed Skill contract test。
- Gate: ready。

### DECOMP-BOUNDARY-02: policyと強制契約を混同しない

- Accepted anchor: WithMateは状態、Role binding、hierarchy、authority、搬送、Work Item、aggregationを所有し、Agentは作業判断と実行方法を所有する。
- Canonical owner: Skillとoperation reference。sourceのRole、Work Item、aggregation contractは変更しない。
- Failure mode: Agent policyを新しい永続APIへ固定する、Roleやdepthをcallerが自己申告する、拒否を自由文で迂回する。
- Observable: SkillがAgent-owned policyとWithMate-owned enforcementを分離し、既存operationだけを操作順に使う。公開operation集合は変わらない。
- Direct verification: Skill contract testと既存runtime operation集合の同期test。
- Gate: ready。

### DECOMP-RECOVERY-03: 部分成功とresponse lossから重複せず回復する

- Accepted anchor: effect-bearing operationごとに別idempotency keyを持ち、response lossはcanonical resourceのread-backとunchanged replayで収束させる。
- Canonical owner: 既存Session application contractとSkillのdecomposition workflow。
- Failure mode: Session create成功後のWork Item失敗でchildを重複作成する、run失敗をenqueueへ切り替える、同じkeyを別effectへ再利用する。
- Observable: 操作順、key分離、read-back、unchanged replay、partial success再開をSkill/referenceが明示する。
- Direct verification: Skill contract test。runtime mutation semantics自体は既存Session、Work Item、CLI、MCP testを回帰checkとして実行する。
- Gate: ready。

### DECOMP-INTEGRATE-04: 分割した結果を既存集約へ閉じる

- Accepted anchor: 一つのWork Itemが一つの委譲を識別し、parent target coordinatorが直属子だけをdecisionしてstrict parent resultへ統合する。
- Canonical owner: Work Itemとaggregation contract。Skillは操作順と採用責任だけを案内する。
- Failure mode: execution完了をWork Item完了とみなす、孫resultをrootが直接flattenする、未決定子を残して親を完了する。
- Observable: Skillがexplicit terminal result、direct-child aggregation、adoption validation、parent finalizationを要求する。
- Direct verification: Skill contract testと既存Work Item aggregation contract test。
- Gate: ready。

## Test design

| Failure mode | Consumer impact | Canonical owner / observable | Check layer |
| --- | --- | --- | --- |
| 単一責務でも階層を最大化する | SessionとWork Itemが増え、統合負荷が上がる | Skillのno-split、direct executor、task coordinator選択基準 | static contract test |
| policyを新operationとして説明する | runtimeに存在しないAPIをAgentが呼ぶ | operation referenceの公開集合とSkillの既存operation workflow | static contract test |
| partial success後にchildを重複作成する | 同じ作業が複数Sessionへ委譲される | operation別key、read-back、unchanged replay | static contract test + 既存idempotency test |
| 依存する子を同時dispatchする | stale input、競合、統合失敗 | Skillのdependency sequencing | static contract test |
| execution terminalをWork Item terminalとみなす | aggregationにresultがない | explicit `work.result`とaggregation workflow | static contract test + 既存Work Item test |
| WithMate拒否を自由文で迂回する | authorityと追跡が失われる | fail-closed instruction | static contract test |

新しいruntime behavior、storage、public schemaを追加しないため、migration、concurrency、adapter parityの新規testは作らない。既存testを変更して現在のsourceへ合わせることもしない。

## 実装順

1. `resources/skills/withmate-session/SKILL.md`へ分割判断、Role選択、dependency sequencing、fail-closed、結果統合を追加する。
2. `resources/skills/withmate-session/references/operations.md`へ既存operationを使うdecomposition workflowとpartial success recoveryを追加する。
3. `scripts/tests/withmate-session-skill-contract.test.ts`へDECOMP-POLICY-01からDECOMP-INTEGRATE-04を直接検出するcontract testを追加する。
4. 必要な利用者文書だけを同期し、公開operation数、schema、storage、GUIは変更しない。
5. targeted Skill contract test、Work Item/aggregation回帰test、`npm run typecheck`、`npm test`、`npm run build`を実行する。

## 対象外

- 新しいdecomposition resource、state、revision、storage table、migration
- `work.decompose`、batch Session create、batch Work Item createなどの新規operation
- 分割数、並列数、RoleをWithMate内部ロジックが自動決定する機能
- Work Item tree、Session tree、result dashboardのGUI
- `turnPurpose`の追加
- Role tuple、child作成matrix、communication authority、Work Item、aggregation schemaの変更
- child Sessionの自動削除、Agent向けSession delete
- CodexまたはCopilot実accountへの接続

## Review gateと完了条件

本sliceは配布Skillとその直接contract testに限定され、public API、永続化、authority実装を変更しない。targeted checkがaccepted contractを直接検証できるため、独立reviewは起動しない。実装中にruntime contractまたは強制境界の変更が必要になった場合はscopeを再評価し、`contract-closure`へ戻る。

- Agent-owned policyとWithMate-owned contractが文書上もtest上も分離されている。
- no-split、direct executor、task coordinator、dependency sequencing、partial success、fail-closed、aggregation closureを直接testできる。
- 公開operation集合と既存runtime contractを変更していない。
- targeted test、`npm run typecheck`、`npm test`、`npm run build`が現行commitで成功する。
- 未実行check、validation gap、残リスクを区別して報告する。
- 一つの論理変更として通常commitを作成する。
