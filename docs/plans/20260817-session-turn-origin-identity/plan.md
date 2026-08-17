# Session Turn Origin Identity Closure Plan

## Scope

WithMate提供のSession向けCLI・MCP application operationをAgent runtime binding必須にし、`turn.run`と`turn.enqueue`がbinding由来のSession initiator snapshotを永続化する。active executionのGUI投影をinitiator非依存のFIFOへ広げ、user、session、legacyを既存message listで区別する。

対象外はprovider実接続、transport badge、caller指定identity、actorからtargetへの暗黙fallback、新規Role／hierarchy、Session由来queued TurnのGUI cancel、Auxiliary固有queueの機能拡張とする。

## Closure Plan

### ID-01: trusted caller identity

- Accepted contract / exact anchor: ORIGIN-IDENTITY-01の「WithMate提供のSession向けCLI・MCP application operationはvalidなbindingを必須とし、actor Session IDをbindingだけから解決する」。ADR 021のtransport credentialとruntime bindingの分離を維持する。
- Scope / semantic owner: `session-runtime-http-server`のexchange後・handler前binding解決と、`session-external-application-service`のtrusted invocation context消費。
- Failure mode / consumer impact: missing、blank、invalid、expired、grant不足またはspoof fieldを含むrequestがhandlerや永続mutationへ到達する。
- State transitions / failure timing: transport認証後、request envelope validation後、application handler開始前。binding failureは`effect: not_applied`でhandler未実行。
- Direct verification: raw HTTPで全application operationへのresolved context伝播、各binding failureでhandler未実行。application serviceでbindingなしを副作用前に拒否。
- Independent review trigger: binding authorityと複数subsystemを横断するためcommit固定reviewを行う。
- Gate: ready

### ID-02: explicit target preservation

- Accepted contract / exact anchor: actor Sessionはbinding、target Sessionはoperation inputの明示値を正本とし、相互に補完しない。
- Scope / semantic owner: application serviceのvalidated operation dispatchとexecution mutation作成。
- Failure mode / consumer impact: actor Bの操作がtarget CではなくBへ誤配送される、またはtarget欠落・不正をactorで補完する。
- State transitions / failure timing: envelope validation、replay判定、新規execution validation、永続commit。
- Direct verification: actor Bからtarget Cへのrun/enqueueでexecutionのsessionId=C、initiator.sessionId=B。target欠落・不正でexecutionなし。
- Independent review trigger: ID-01と同じcommit固定review。
- Gate: ready

### ID-03: stable attribution and GUI projection

- Accepted contract / exact anchor: 新規Turn initiatorはuserまたはsession snapshot。既存external requestだけをlegacyとして読み、active executionを永続FIFO順でmessage listへ投影する。session snapshotはrename、archive、削除後も再解決しない。
- Scope / semantic owner: `session-execution-turn-request`のshared parser、execution `request_json`、main process active projection、preload/renderer public type、既存message row。
- Failure mode / consumer impact: create/load/recovery/admissionでinitiator tupleが欠落・変化する、session Turnが`外部`へ劣化する、FIFO位置と表示順がずれる、GUI以外のqueued Turnをcancelできる。
- State transitions / failure timing: create、serialize/load、restart recovery、queued→running、character rename/archive/delete、icon load failure、renderer refresh/event merge。
- Direct verification: parserのuser/session/legacy、storage round-trip/recovery、queued→running tuple維持、mixed FIFO projection、session name/avatarとgeneric avatar fallback、initiator別cancel可否、transport badge不在。
- Independent review trigger: 永続互換性とGUI投影を横断するためcommit固定reviewを行う。
- Gate: ready

### ID-04: transport-independent idempotency

- Accepted contract / exact anchor: fingerprintはinitiator kindとsession actor IDを含み、adapter、binding、generation、snapshot表示値を含めない。canonical replayをcharacter再解決より先に判定する。
- Scope / semantic owner: application serviceのfingerprint生成、replay preflight、新規snapshot解決順序。
- Failure mode / consumer impact: MCP→CLI retryが二重executionになる、別actorが同一executionへ合流する、rename/archive後のretryが失敗またはsnapshotを変更する。
- State transitions / failure timing: initial request、commit後response loss、同一actor retry、別actor同一key、snapshot state変更後retry。
- Direct verification: adapterを跨ぐ同一actor retryは同一execution、別actor同一keyはconflict、snapshot表示値はfingerprint非依存、replay時はsnapshot resolver未実行。
- Independent review trigger: idempotencyとidentity attributionを横断するためcommit固定reviewを行う。
- Gate: ready

### ID-05: origin-aware message layout and Session details

- Accepted contract / exact anchor: 2026-08-17の利用者要求「別Session由来の入力は右側へ配置し、詳細にはSession IDとタイトルだけを表示する。現存する呼出元SessionのタイトルからそのWindowを開ける。Character ID、見出し、欠落説明は表示しない」。保存済みinitiator snapshotのSession IDを正本とし、現在のタイトルは現存時だけ使う。
- Scope / semantic owner: rendererの`SessionMessageColumn`と、既存Session一覧から作るread-onlyな呼出元Session detail projection。
- Failure mode / consumer impact: 別Session入力と対象Session応答が同じ左側に並んで発話主体を誤認する、詳細へ不要なCharacter／runtime情報や欠落説明を常設する、削除済みactorで保存Session IDまで消える、現存する呼出元Sessionへ辿れない。
- State transitions / failure timing: active executionのqueued／running、detail開閉、actor Sessionのrename／archive／delete、icon欠落、狭幅表示。
- Direct verification: componentで右側origin primitive、detail buttonのaccessible name、保存Session ID、現存時のタイトルリンク、削除時のSession ID維持と不要表示の不在を確認し、VisualCheckで左右配置、リンク操作、密度を確認する。
- Independent review trigger: 既存IPCや永続schemaを変更せずrenderer内のread-only projectionで閉じるためnone。
- Gate: ready

## Closure Map

### ID-01

- Accepted anchor and meaning: transport credentialはCLI/MCP routeを認証し、bindingだけがactor identityとoperation grantを証明する。
- Canonical owner: HTTP runtime exchange境界。
- Siblings in scope: CLI、MCP、raw HTTP、runtime catalog、Session CRUD/files、turn options/run/enqueue/list/get/cancel、interaction、transcript。
- Excluded siblings and reason: `/v1/status`、challenge、exchange前transport処理は接続確立に必要でapplication operationではない。Memory/Character MCPは別application boundary。
- Failure points: blank reference、unknown/revoked/expired reference、grant不足、handlerへのnull context。
- Direct checks: HTTP integrationで各failure codeとhandler未実行、valid bindingで全operationにactor context。
- Independent review lens: transport authenticationとbinding authorityの混同、handler開始前failure timing。

### ID-02

- Accepted anchor and meaning: actorとtargetは別tupleで、targetはrequest schemaのrequired fieldである。
- Canonical owner: runtime request validatorとapplication execution mutation作成。
- Siblings in scope: turn.run、turn.enqueue、turn.get/list/cancelとSession/file/interactionの既存target validation。
- Excluded siblings and reason: GUI enqueueはactor bindingを使わずuser initiatorを固定する。
- Failure points: actorによるtarget上書き、target欠落時fallback、target validation前の永続commit。
- Direct checks: cross-session run/enqueue、missing/invalid target negative check。
- Independent review lens: actor/target混同と既存allowlist逸脱。

### ID-03

- Accepted anchor and meaning: `(kind, sessionId, characterId, name, iconFilePath)`をcreate時に確定し、以後snapshotとして扱う。initiatorなしだけがlegacy。
- Canonical owner: execution request parserとrequest JSON。GUIはそのpublic projectionを消費する。
- Siblings in scope: GUI enqueue、external run/enqueue、storage load、restart reconciliation、queued admission、active list refresh/state event、message identity/order、avatar fallback、cancel projection。
- Excluded siblings and reason: completed executionの監査UI、Auxiliary固有message queue、provider transcriptはactive execution projectionのownerではない。
- Failure points: malformed tupleのpartial accept、legacy誤分類、state transitionでのrequest書換え、current Character再解決、GUI-only命名の残存。
- Direct checks: parser unit、storage/service integration、main projection unit、renderer projection/component、visual smoke。
- Independent review lens: request互換性、tuple preservation、FIFO aggregate scope、表示専用authority。

### ID-04

- Accepted anchor and meaning: stable identityはinitiator kindとactor Session ID。delivery/transport/snapshot値はeffect identityではない。
- Canonical owner: application serviceのmutation fingerprintとreplay preflight。
- Siblings in scope: turn.run、turn.enqueue、CLI、MCP、response-loss retry、restart後replay。
- Excluded siblings and reason: turn.cancelとinteraction.respondはTurn作成identityを所有しない。
- Failure points: snapshot解決がreplayより先、actor欠落fingerprint、adapter/binding/snapshotのfingerprint混入。
- Direct checks: same actor transport retry、different actor conflict、resolver call count、persisted snapshot read-back。
- Independent review lens: replay timingとfingerprint field set。

### ID-05

- Accepted anchor and meaning: target Characterの応答は左、別Session／legacy external入力は右へ置く。Session initiatorの保存snapshotをname、avatar、Session IDの正本とし、現在のSession titleは存在する場合だけWindowを開く操作として補足する。
- Canonical owner: `SessionMessageColumn`のmessage role projectionとorigin detail disclosure。
- Siblings in scope: running／queued Session initiator、legacy external、user initiator、target assistant response、actor Session存在／削除、狭幅layout。
- Excluded siblings and reason: completed execution履歴との対応付けはactive execution projectionのownerではない。Session detail用の新規IPCや永続snapshot追加は、既存Session一覧で要求を満たせるため行わない。
- Failure points: assistant classへの誤投影、detail button欠落、現在のCharacter名でsnapshotを上書き、missing actorで保存Session IDが消える、不要なCharacter ID／欠落説明が残る、タイトル操作が別Sessionを開く、Session由来queuedへcancelが生える。
- Direct checks: renderer component interaction、typecheck、VisualCheck。
- Independent review lens: none。

## Test Design Gate

| Failure mode | Consumer / observable | Canonical owner | Check layer | Distinctness |
| --- | --- | --- | --- | --- |
| unbound application operationがhandlerへ到達する | CLI/MCP callerへ構造化binding error、handler call 0 | HTTP exchange境界 | HTTP integration | 現行testは`session.self`だけを検証する |
| actor/targetが混同される | execution target Cとinitiator Bのtuple | application service | service integration | 現行fingerprint/requestにactorがない |
| malformed/legacy requestを誤分類する | parse resultとstorage round-trip | request parser | unit + storage integration | 現行parserはsourceだけを扱う |
| retryがsnapshot再解決または二重createする | execution ID、resolver call count、保存snapshot | application service + storage idempotency | service integration | 現行fingerprintにactorがない |
| mixed queueの順序・cancel authorityが崩れる | projected sequence、queuePosition、canCancel | main active projection | projection unit | 現行projectionはGUIだけを除外後に表示する |
| session senderを既存message rowで識別できない | snapshot名、avatar asset、generic fallback、badge不在 | renderer message row | component + visual smoke | 現行user rowはsender identityを描画しない |
| Session入力とtarget応答の左右が同じ、または詳細から正しい呼出元へ辿れない | origin rowの右側primitive、保存Session ID、現存時のタイトルリンク、不要表示の不在 | renderer message row + 既存Session Window IPC | component + typecheck + visual smoke | ID-03はsender表示だけで左右の意味対応と詳細操作を検証しない |
| public type/IPC命名がGUI限定のまま残る | typecheck、IPC/preload contract | shared public boundary | typecheck + contract test | 全initiator ownerへの拡張で既存名が不正確になる |

Candidate testはobservableなrequest/result/state/markupだけをassertし、private call順序、class名、snapshot全体には依存しない。正しいhelper抽出やmarkup再編で失敗せず、binding check除去、actor ID除去、initiator tuple欠落、cancel権限拡大、sender表示欠落の各最小欠陥で失敗するものだけを追加する。

## Validation and Review

1. 関連targeted test
2. `npm run typecheck`
3. `npm test`
4. `npm run build`
5. `scripts/start-withmate-visual-check.ps1`でmixed queue、queued→running、avatar/name、cancel可否を確認
6. 現行sourceをcommitし、base/review commitを固定したclean detached worktreeで独立review
7. findingはID-01〜04のInvariant familyへFinding Promotionし、必要ならcurrent-scope repairとdirect checkで閉じる

## Implementation Closure Evidence

- ID-01: raw HTTP境界で18 application operationすべてにbindingを必須化し、valid bindingのtrusted context伝播とmissing／blank／invalid／expired／grant不足時のhandler未実行をintegration testで確認した。
- ID-02: application serviceでactor Bのbindingとtarget Cの入力を分離し、run／enqueue双方の保存request、target欠落・spoof field拒否、mutation未実行を確認した。
- ID-03: request JSONのuser／session／legacy parse、storage再起動round-trip、queued→running tuple維持、mixed FIFO、initiator別cancel可否、name／avatar／fallback／badge不在をunit・component・分離起動で確認した。
- ID-04: fingerprintをinitiator kindとactor Session IDへ固定し、同一actorのtransport非依存retry、別actor conflict、replay先行によるsnapshot resolver未実行を確認した。
- ID-05: Session由来入力を右、target Characterの応答を左へ配置し、詳細表示を保存Session IDと現行Session titleのWindowリンクに限定した。actor Session削除後は保存Session IDだけが残り、Character ID、見出し、欠落説明、Session由来cancelが表示されないことをcomponent testと分離起動で確認した。
- Worktree checks: `npm run typecheck`、`npm test`（2878 pass、0 fail、1 skip）、`npm run build`が成功した。
- Visual check: `%APPDATA%\WithMate-visual-check`の分離プロファイルにFIFO準拠fixtureを作成し、session／user／legacyの順序、sessionのsnapshot名とicon、入力と応答の左右配置、呼出元Session titleのWindowリンク、userだけのcancel、transport badge不在、先頭session executionのqueued→running後もidentityと表示位置が維持されることを確認した。実provider接続は行っていない。
