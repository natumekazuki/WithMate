# ADR 011: Provider非依存のRun observation control plane

- Status: Accepted
- Date: 2026-07-19
- Amends: ADR 006のCLI lifecycle interruption分類
- Amended by: ADR 013のruntime host ownership

## Context

CP2では、永続化済みRunの状態とeventをprocess境界から観測するcontrol planeが必要である。一方、Provider requestとexecution snapshotの構築、durable admission後のdispatch継続、active cancel時のProvider interruptとterminal outcomeの相関を所有するproduction runtimeは、CP3より前の現在時点では存在しない。RepositoryにRun admissionやterminal transitionのcommandがあることだけでは、publicなstart、retry、cancelの実行意味を閉じられない。

RunEventはbounded pageとして永続化され、terminal transitionとterminal eventは同じtransactionでcommitされる。CLI callerには、event cursorから新しいeventを待つ用途もある。無期限streamや常駐daemonを導入すると、新しいprocess ownership、接続lifecycle、認証、upgrade、crash recoveryの決定が必要になる。

Session CLIのschema、output、exit code、Application Service境界はADR 006で決定済みである。Run観測も同じautomation contractを維持し、field一覧、validation上限、polling state machineはtype、parser、projection、testを正本とする。

## Decision

Run control planeは、Provider非依存で成立するstatus、events、followの観測操作に限定する。public ownerはSession操作と分離した`ApplicationRunOperations`とし、callerはSession IDとRun IDを指定する。Application boundaryがRun targetを認可してSessionのWorkspace scopeを解決し、Repository boundaryがWorkspace、Session、Runの組を再検証する。CLIはApplication operationだけを受け取り、Repository clientやraw Worker requestへ到達しない。

`withmate run status`は永続化済みphaseと、利用者向けに制限したfailure、cancellation、timestampを返す。live activityは永続状態と分けたnullable値とし、active Runで同じpersisted versionに相関できる場合だけ返す。execution snapshot、Provider error code、内部ID、version、external side effect metadataは公開しない。

`withmate run events`はopaque continuation cursorを持つbounded pageを返す。既知eventはpublic kindへ射影し、未知kindは内部payloadを公開せず`unknown`として保持する。response byte budgetによるomissionはsilent dropせずApplication issueへ変換し、空pageとtailでも次回読取に利用できるcursorを返す。

`withmate run follow`は無期限streamではなく、1 invocationにつき1つのJSON responseを返すbounded long-pollとする。application-level wait deadline、poll interval、CLI lifecycleのhard timeoutを別の値として扱う。hard timeoutはparse後にabsolute deadlineへ変換し、bootstrap、operation、shutdownで同じdeadlineを共有する。terminal statusを観測した後にevent pageを読み、terminal eventが先に可視化された場合はstatusを再照合する。terminalまでにpage上限を超えるeventがある場合はcursor付きの`events`結果として継続し、terminal eventまたはtailまで到達した結果だけをterminal closureとする。poll中はDB transactionを保持せず、event pageを複数回分蓄積しない。SIGINTは現在のCLI lifecycleをabortするだけで、Run cancelへ変換しない。

Run namespaceはADR 006の`withmate-cli-v1`へ追加する。helpとparse failureはWorkerを起動しない。operation resultとfailureはnewline終端のJSON object 1件をstdoutへ出し、exactly-once shutdownを維持する。

CLI hard timeoutとSIGINTはbootstrap、operation、shutdownを含むlifecycle全体を中断する。operation確定後のgraceful shutdown rejectionまたはcheckpoint failureは、ADR 006どおりruntime failureのexit code 50とする。hard deadlineによるlifecycle timeoutはexit code 40、SIGINTによるlifecycle cancelはexit code 41とし、shutdown中でも原因をgeneric shutdown failureへ畳まない。Application responseが確定済みの場合は`lifecycle_failure`として保持する。このtimeout / cancelの細分化は、ADR 006のshutdown failure分類をamendする。

## Alternatives

- status、eventsだけを公開しfollowを後続へ送る: bounded pollingは既存Repository readと短命CLI lifecycleだけで成立し、consumerごとの不整合なpoll実装を避けられるため採用しない。
- Provider-neutral planner/runtime portだけを追加し、mutation commandは公開しない: production ownerもconsumerも存在しないportはfailure timingを確定せず、現在必要な観測境界を複雑にするため採用しない。
- Provider runtimeとprocess ownershipを同じ変更へ取り込み、start、retry、cancelまで公開する: CP3との境界を変更し、external side effect、dispatch recovery、active interrupt、idempotencyを同時に閉じる必要があるため採用しない。
- followを無期限streamまたは常駐daemonにする: process ownershipと接続protocolの追加決定が必要で、1回のbounded observationには不要なため採用しない。
- CLIがWorkspace keyまたはraw execution snapshotを受け取る: ownershipとpublic projectionをApplication boundaryからcallerへ漏らすため採用しない。

## Consequences

- Provider processがなくても、CLIと将来のGUIは同じApplication boundaryから永続化済みRunを観測できる。
- callerはreason、opaque cursor、exit codeを用いてboundedに追跡を継続でき、terminal eventをphaseだけで推測する必要がない。
- Runのinternal persistence modelや将来のProvider field追加はpublic outputへ自動流出しない。
- followはinvocationごとにWorkerを起動するため常駐接続よりpoll overheadがあるが、process ownershipを追加せずshutdownを確定できる。
- start、retry、active cancelは未公開のままであり、Provider runtime ownershipとexternal side effectのclosureを持つ後続sliceが必要である。
- CP2全体は、この観測sliceだけでは完了しない。

## Related decisions

- `docs/adr/003-application-service-operation-envelope.md`
- `docs/adr/005-pre-dispatch-run-terminal-resolution.md`
- `docs/adr/006-cli-session-control-plane.md`
