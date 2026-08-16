# GUI Session Turn Queue

## Goal

通常SessionのGUI送信をMain Processの永続`turn.enqueue` ownerへ統一し、実行中も既存composerから次のTurnを登録できるようにする。queued executionは既存message listへFIFO順で投影し、active Turnのcancelと新規送信を別操作として維持する。

## Scope

- 通常SessionのGUI enqueue、queued list、queued cancel
- GUI向けIPC / preload / shared projection type
- execution変更通知とSession切替・再接続時のread-back
- 既存message list内の待機状態、順序、cancel操作
- running中のcomposer入力、button / keyboard送信、active cancelの分離
- `QUEUE_FULL`を含むadmission error時のdraft保持

対象外はAuxiliary Session、Companionの新規実行経路、scheduler、終端失敗通知、Session Role / hierarchy、Coordination Event、外部CLI / MCP schema、`session.self`とする。

## Pre-Implementation Closure Plan

### GUI-Q-01

- Accepted contract / exact anchor: 添付要求の「idle/runningを問わずGUI通常送信は同じ`turn.enqueue`へ入る」と`docs/design/session-external-runtime.md`の永続FIFO、待機10件、active非算入、11件目`QUEUE_FULL`副作用なしの契約
- Scope / semantic owner: execution identity、FIFO、admission、cancel、restart復旧は`SessionExecutionService` / storage。GUIはMainのread-backを表示するadapter
- Failure mode / consumer impact: renderer独自queue、idle/running事前分岐、busy fallbackによりTurnが重複・消失・追越しする
- State transitions / failure timing: enqueue validation前、queue commit後response loss、queued→running、queued cancelとadmissionの競合、restart後read-back
- Direct verification: GUI adapterのidle/running共通enqueue、idempotent replay、queue full effect none、owner付きcancel、FIFO projectionのintegration test
- Independent review trigger: queue ownerとGUI IPCを横断し、response lossとcancel/admission競合はtargeted checkだけで全interactionを直接検証しきれないためtargeted reviewを行う
- Gate: ready

### GUI-Q-02

- Accepted contract / exact anchor: 添付要求の「queued user inputは既存message listへ短い待機表示とcancel操作を持つ」「running中もcomposer入力と送信を可能にし、active cancelを別操作にする」
- Scope / semantic owner: 既存Session chat projection、message column、composer capability。queueの順序・実行開始判定は所有しない
- Failure mode / consumer impact: queued Turnが見えない、順序が誤る、running中に送信がcancelへ化ける、queued cancel成功をrendererが先に確定する
- State transitions / failure timing: Session選択、execution eventとrefreshの前後、送信pending、queue full、queued cancel→running競合
- Direct verification: projection unit test、composer interaction/component test、keyboard submit test、cancel state test、分離起動によるvisual smoke
- Independent review trigger: GUIとMain projectionのevent/read-back競合をGUI-Q-01のreview lensへ含める
- Gate: ready

## Closure Map

- Canonical owner: `SessionExecutionService` / `SessionExecutionStorageV6`
- Siblings in scope: GUI enqueue、GUI queued list、GUI queued cancel、execution change event、Session切替read-back、composer button / keyboard、message list projection
- Excluded siblings and reason: 外部CLI / MCPは既存の同一execution ownerをすでに利用し、公開schema変更を必要としない。Auxiliary / Companionは別run ownerとlifecycleを持ち、通常Session GUI queue invariantのsupported scope外
- Failure points: admission前validation、commit後response loss、event先行 / refresh遅延、cancel中admission、queue full、restart後初回read
- Direct checks: adapter integration、projection / interaction unit、typecheck、build、visual smoke
- Independent review lens: idempotency / owner / failure timingと、event / refresh収束時の二重表示・draft消失

## Test Design Gate

| Failure mode | Consumer impact | Canonical owner / observable | Check layer | Distinctness |
| --- | --- | --- | --- | --- |
| GUIがlegacy `runSessionTurn`またはrunning分岐を使う | busy拒否、暗黙fallback、Turn消失 | GUI adapterが作る永続executionと共通enqueue call | Main adapter integration / static composition | 既存execution testはGUI入口を通らない |
| response loss後の再送で別executionを作る | Turn重複 | client request IDとread-back execution identity | adapter integration + renderer reconciliation unit | 外部adapterのidempotency testはGUI draft recoveryを観測しない |
| queued順序またはcancel可否をrendererが推測する | 表示順誤り、競合時の誤削除 | Main projectionのqueue position / canCancel | projection unit / IPC integration | storage testはGUI projection shapeを観測しない |
| running中のbutton / keyboardがcancelへ分岐する | 新規Turnを登録できない | composer callbackとsendability | component / handler unit | 現行testはrunningを送信不能として固定している |
| `QUEUE_FULL`でdraftが消える | 入力喪失 | enqueue resultとrenderer draft transition | renderer state helper unit | storage queue limit testはdraftを観測しない |

## UI Decision

- queue専用panelやcardは追加せず、queued user messageの既存bubble内に短い「待機中 N」statusとvisibleな「キャンセル」buttonを置く
- active cancelは既存の実行status付近に残し、Send buttonはrunning中もcomposer末尾へ表示する
- 色だけに依存せずstatus text、button label、`role=status` / accessible nameを使う
- queuedからrunningへ移ったexecutionはqueue projectionから外し、既存Session message / live run projectionへ引き渡して二重表示を避ける
