# v6.4 Session統括・Session間通信 実装計画

## 1. 目的

v6.4.0では、ユーザーが通常は一つの全体統括Sessionと会話し、Agentが必要に応じて個別統括Sessionとexecutor Sessionを構成して作業を進められる状態を目指す。

Session階層は作業分担とAgent間authorityを表す。ユーザーの操作範囲を制限するためには使わない。ユーザーはRoleや階層にかかわらず、任意のSessionを開き、直接メッセージを送り、進行へ介入できる。

本計画は、統合済みのSession Role bindingを前提に、次の未実装契約を閉じる。

- AgentによるSession間Turnのtarget authority
- 送信元SessionWindowにおける外向きメッセージの投影
- Coordination Event APIと実行指示の責務分離
- 既存Sessionと異なるrootのSessionに対する初回リリースの境界

## 2. 現在地

`ORCHESTRATION-ROLE-01`で、次のRoleとimmutableな親子bindingは統合済みである。

- `standalone`
- `overall-coordinator`
- `task-coordinator`
- `executor`

`overall-coordinator`は`task-coordinator`と`executor`を作成でき、`task-coordinator`は`executor`を作成できる。最大`delegationDepth`は2であり、rootを含めて最大3階層となる。この作成matrixは意図した契約と一致しているため変更しない。個別統括が不要な小さな作業では、全体統括がexecutorを直接作成してよい。

「Worker」は会話上の呼称であり、正式なRole名は`executor`とする。

現行の外部Session application serviceはactor Sessionのbindingを検証するが、明示されたtarget Sessionに対するRole／hierarchy authorityをまだ適用していない。また、executionはtarget Session側へ投影され、送信元SessionWindowから外向きTurnを確認するprojectionはない。

## 3. Accepted contract

### 3.1 基本構成

- ユーザーが通常会話する入口は`overall-coordinator`とする。ただし、これは推奨される運用でありUIまたはdomainの強制条件ではない。
- `overall-coordinator`は、必要な数の`task-coordinator`または`executor`を作成できる。
- `task-coordinator`は、必要な数の`executor`を作成できる。
- `executor`は作業に詰まった場合、長く自己解決を続けず、直属の親Sessionへ相談する。
- `task-coordinator`は自分で解決できる場合は回答し、解決できない場合はrootの`overall-coordinator`または同じrootに属する別の`task-coordinator`へ相談できる。
- 初回リリースの階層は最大3階層とする。すべてのbranchが3階層を使う必要はなく、rootのみ、rootからexecutor、rootからtask coordinatorを経由したexecutorのいずれも許可する。
- Agentは許可されたauthority内で、Sessionの作成数、分割単位、相談先、実行順を自律的に選択できる。

### 3.2 AgentによるSession間Turn authority

対象は、runtime bindingでactorが確定したCLI、MCP、raw HTTPなどからの`turn.run`と`turn.enqueue`である。GUI上のユーザー操作にはこのmatrixを適用しない。

| actor Role | 許可するtarget | 条件 |
| --- | --- | --- |
| `standalone` | actor自身 | cross-Session Turnは許可しない |
| `overall-coordinator` | actor自身、直属の`task-coordinator`、直属の`executor` | targetの`parentSessionId`がactorであること |
| `task-coordinator` | actor自身、直属の`executor`、rootの`overall-coordinator`、同じrootの兄弟`task-coordinator` | 兄弟間は同じ`rootSessionId`かつ同じ親を持つこと |
| `executor` | actor自身、直属の親 | 親は`overall-coordinator`または`task-coordinator` |

次を許可しない。

- 異なる`rootSessionId`に属するSessionへのAgent起点Turn
- `overall-coordinator`から孫に当たるexecutorへの直接Turn
- `executor`から兄弟Sessionまたは別branchへの直接Turn
- immutableな親子bindingを迂回するtarget指定

authority判定は、request bodyに含まれる自己申告のRole、root、parent、depthを信用せず、runtime bindingのactorとcanonical Session storage上のtarget bindingから行う。CLI、MCP、raw HTTPはshared application serviceの同じ判定へ収束させる。

Session metadataのread／discovery範囲は本sliceで変更しない。初回実装ではcross-Session Turn mutationのauthorityを閉じ、read scopeを同時に暗黙変更しない。

### 3.3 ユーザー介入の境界

- ユーザーは任意のSessionWindowを開ける。
- ユーザーは任意のSessionへ直接メッセージを送れる。
- ユーザーの直接操作は、Agent間通信のroot／親子authorityで拒否しない。
- ユーザーが個別Sessionへ介入しても、SessionのRole、root、parent、depthは変更しない。

### 3.4 既存Sessionと異なるrootの扱い

v6.4.0初回リリースでは、Agentが既存の別root Sessionを自分の階層へ採用、付け替え、または直接呼び出す機能を提供しない。

既存Sessionのreparentは、過去のauthorityと監査上の意味を変えるため禁止する。別rootへのAgent起点Turnも禁止し、root単位の隔離を明確な安全境界として扱う。ユーザーは別root Sessionへ直接介入できるため、必要な情報の手動仲介は可能である。

将来、別root Sessionの知識をAgentへ一時的に参照させる必要が明確になった場合は、ユーザーが対象、操作、期限を明示して発行する一時的なexternal Session consultation grantを別契約として検討する。これはv6.4.0初回リリースのscopeに含めない。

### 3.5 送信元SessionWindowの外向きメッセージ投影

Session AがSession BへTurnを受理させた場合、Session AのSessionWindowにも外向きメッセージを表示する。これはAgentがCoordination Eventを追加したかどうかに依存せず、runtimeが受理したexecutionから投影する。

表示契約は次のとおりとする。

- 通常のchat messageを複製せず、既存のSession-origin受信メッセージのprimitiveを一般化した関連Sessionメッセージとして表示する。
- 外向きであることは、既存token、icon、shape、alignment、state affordanceなどのデザイン差で表す。「送信しました」「委譲を開始しました」のような常設説明文は追加しない。
- 先頭にtarget Session名とRoleを表示する。
- その下には送信メッセージの先頭previewだけを表示する。
- メッセージ本体をクリックすると全文を展開する。
- 詳細を展開するとtarget Sessionの情報と、target SessionWindowを開く操作を表示する。操作感は既存の受信メッセージ詳細と揃える。
- screen reader向けaccessible nameでは、target Sessionと操作内容を判別できるようにする。視覚上の説明文を省くことと、アクセシブルな識別情報を省くことを混同しない。

外向き表示の正本はtarget側で受理されたexecutionとする。source側へ別のmessage recordを二重保存しない。execution acceptance時に、履歴表示に必要なtarget Session名とRoleのsnapshotを保持し、詳細画面の遷移先はcanonicalなtarget Session IDで解決する。target Sessionが現存する場合は現在のSessionWindowを開き、削除済みなどで解決できない場合は履歴表示を残したままopen操作を無効化する。

source Sessionからのlistは、executionのorigin-target関係を正規化された列またはindexで取得できるようにする。request JSONの全件scanをcanonical queryにしない。

### 3.6 Coordination Event APIとの責務分離

- Sessionへの実行指示と相談メッセージは`turn.run`／`turn.enqueue`を使う。
- Coordination Event APIをcommand transportまたはSession間message busとして使わない。
- Coordination Eventは、Agentの判断、進捗、escalation、blocker、結果などをユーザーが後から確認するための監査・可視化境界とする。
- Coordination Eventはexecutionを参照できるが、eventがないことをexecutionの不在として扱わない。
- 外向きメッセージのSessionWindow投影はexecution acceptanceから生成し、Agentがeventを記録し忘れても欠落させない。

### 3.7 契約versionの所有

Session Role tupleとchild作成matrixは変更しないため、`roleContractRevision = 1`を維持する。Session間Turn authorityはRole bindingの永続化versionへ混ぜず、shared application serviceが所有するversioned communication authorityとして実装する。public clientがrevision選択を必要とする場合は、Role bindingとは別のcommunication contract revisionを公開する。

## 4. Invariant closure

### ORCH-AUTH-02: Agent間通信authority

同じtarget Sessionへ到達するすべての外部入口は、runtime binding actorとcanonical target bindingを使った同一のauthority判定を通る。adapterごとの判定、request body由来のauthority、別rootへのfallbackを残さない。拒否はexecution作成、queue追加、provider副作用より前に確定させる。

直接検証では、許可matrixの各辺と、異root、孫、兄弟executor、Role偽装、存在しないtargetを確認する。

### ORCH-OUTBOUND-01: source側projection

target側executionの受理とsource側からの取得可能性を一つのcommit境界で成立させる。source側表示のための重複message recordを作らず、再起動後もorigin-target関係とsnapshotから同じ履歴を復元できるようにする。

直接検証では、即時実行、queue、scheduleなどexecution作成経路のうち同じaccepted contractを共有する兄弟入口、再起動復旧、target rename、target削除、取得順、重複表示を確認する。

### ORCH-USER-01: trusted user介入

Agent間authorityの導入後も、GUI上のユーザーは任意のSessionへ直接Turnを送れる。actor不明をユーザー操作として推測せず、trusted GUI invocation contextで明示的に区別する。

直接検証では、別root、executor、standaloneへのユーザー送信が既存どおり受理されることを確認する。

### ORCH-ROOT-01: root隔離とbinding不変性

Agent起点のcross-root Turnを拒否し、既存Sessionのroot、parent、depthを書き換えない。失敗時に一部binding、execution、eventを残さない。

## 5. 実装単位と依存順

### ORCHESTRATION-COMMS-01

一つのIssue内で、次のcheck可能なsliceへ分ける。

1. shared communication authorityとcross-root／親子matrixの拒否
2. execution storageのorigin-target queryとtarget Session snapshot
3. source SessionWindow向けprojectionとwindow API
4. 受信・送信で共有する関連Session message primitive
5. authority、storage、component、accessibilityのdirect check

public API、authority、owner projectionを同じaccepted contractで変更するため、source編集前にmigration、failure timing、sibling entrypointを再確認する。

### COORDINATION-API-01

`ORCHESTRATION-COMMS-01`統合後、最新の`feat/v6.4.0`から作業を開始する。Coordination Eventをcommand transportとして扱う記述を除外し、execution参照と監査feedにscopeを限定する。既に作成済みの旧Worktreeは古いbaseと契約のまま着手しない。

### ORCHESTRATION-WORK-01

communication authorityとCoordination Event APIの統合後、work item、結果集約、自律的な作業分割に残る契約を独立実装単位へ分解する。

## 6. 検証方針

実装時は`design-tests`でfailure modeと最も直接的なobservableを選ぶ。最低限、次を閉じる。

- shared authority matrixのunit／application service test
- CLI、MCP、raw HTTPが同じ判定へ到達するcontract test
- rejectionがexecution作成やqueue mutationより前であること
- source／target双方のprojectionと再起動後の復元
- related Session message componentのpreview、全文展開、詳細、SessionWindow遷移
- target rename／delete時のsnapshot表示とopen可否
- GUIから任意Sessionへ介入できること
- TypeScript typecheckと関連test
- 分離起動による送信元・送信先SessionWindowの目視確認

## 7. v6.4.0初回リリースで行わないこと

- 4階層以上のSession hierarchy
- 既存Sessionのreparentまたはroot変更
- Agentによる別root Sessionへの直接Turn
- external Session consultation grant
- Coordination Eventを使ったcommand delivery
- ユーザーのSession介入先をRoleで制限すること

## 8. 完了条件

- Agent起点Turnの許可・拒否matrixがすべての外部入口で一致する
- 異rootと非許可関係へのTurnが副作用前に拒否される
- 許可された外向きTurnが送信元と送信先のSessionWindowで一貫して確認できる
- 送信元表示が説明文に依存せず、target Session、Role、preview、全文、詳細、遷移を提供する
- GUI上のユーザーが任意のSessionへ介入できる
- Coordination Eventが監査境界に留まり、実行指示の正本になっていない
- source、executable contract、必要なADRまたは設計文書が同じ最終契約を示す
