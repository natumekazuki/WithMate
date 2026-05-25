# Chat Mode Convergence

- 作成日: 2026-05-25
- 対象: Agent Session、Companion、MateTalk、Auxiliary Session の chat UI / action 境界

## Goal

Agent / Companion / MateTalk / Auxiliary の差分を、固有機能だけに絞る。
message list、composer、ActionDock、pending / streaming 表示、response action などの基本体験は共通の chat component と projection contract に寄せる。
mode ごとの違いは個別 component の分岐ではなく、capability、action slot、service adapter で表現する。

## Background

`docs/design/desktop-ui.md` は、chat layout を 1 系統だけにし、Agent / Companion / メイトークを同じ chat layout に乗せる方針を正本にしている。
`docs/design/auxiliary-session.md` も、Auxiliary を Agent 専用ではなく既存 Session Window / chat layout 上の汎用補助会話として扱う。

今回の整理では、この方針を実装単位へ落とす。
新しい差分を追加するときは、まず共通 component に capability を渡して表現できるかを確認する。
共通 component へ入れると責務が曖昧になる場合だけ、mode-specific adapter へ逃がす。

## Principle

- chat layout、message column、composer、ActionDock は 1 系統を正本にする。
- Agent / Companion は同じ live coding session UI として扱い、基本機能の差異を持たせない。
- MateTalk は軽量 mode だが、独自 chat 実装にはしない。不要機能は capability off で隠し、right pane shell 自体は共通 layout に残す。
- Auxiliary は Agent 限定の feature ではなく、shared chat host 上の disposable / child conversation として扱う。
- response action は assistant response 共通機能として扱い、表示面ごとの composer adapter だけ差し替える。
- retry / edit last message は Agent 固有にしない。UI は共通化し、再送 API と source transcript だけ adapter で差し替える。
- provider や mode の制約で使えない操作は、個別 UI を作らず capability で非表示または disabled にする。

## Difference Matrix

| Surface | 共通にする | capability / adapter にする | mode 固有に残す |
| --- | --- | --- | --- |
| Agent Session | chat shell、message column、composer、ActionDock、pending / streaming、Copy / Quote、attachments、session files、AddDirectory、model / reasoning、approval / sandbox、retry / edit last message | header actions、workspace actions、session files actions、audit source、delete / rename API、Auxiliary entry | 通常 session lifecycle、history resume、session delete |
| Companion | Agent と同じ chat shell、message column、composer、ActionDock、pending / streaming、Copy / Quote、attachments、session files、AddDirectory、model / reasoning、approval / sandbox、retry / edit last message | Companion transcript adapter、merge / ready state actions、target branch / stash information、audit source | review / merge workflow、target branch validation、changed files summary |
| MateTalk | shared chat shell、message column、composer、basic pending / streaming、Copy / Quote、model selection の共通部、empty right pane shell | send adapter、right pane content capability、cancel capability、audit capability、retry capability、attachments capability | SingleMate talk semantics、軽量 right pane content、初期 slice で不要な audit / merge / retry の無効化 |
| Auxiliary | shared chat shell、message column、composer、ActionDock、pending / streaming、Copy / Quote、attachments、session files、AddDirectory、model / reasoning、approval / sandbox | parent session adapter、Return to main action、quote target composer、source label | parent / child transcript 分離、closed auxiliary rendering、parent delete cascade |

## Shared Contracts

### Chat Projection

Agent / Companion / MateTalk / Auxiliary は、最終的に共通の chat window props へ投影する。
mode 側は raw state を直接 component tree へ渡さず、projection helper で次の情報へ正規化する。

- `messages`
- `liveRunState`
- `pendingMessageText`
- `composer`
- `actionDock`
- `headerActions`
- `rightPane`
- `capabilities`
- `responseActions`

projection は、表示 state がどの conversation に属するかを明示する。
共有 component 化のために parent / child / review state が混ざると、Auxiliary や Companion で再発しやすい。
そのため projection contract は少なくとも次の source identity を持つ。

- `conversationKey`: UI 上の現在 conversation を識別する key。
- `transcriptSource`: `messages` と retry 対象を読む source。
- `runSource`: `liveRunState`、pending approval、elicitation、progress を読む source。
- `composerTarget`: draft、送信、Quote 挿入の target。
- `auditSource`: Audit Log / progress history を開く source。

通常 Agent ではこれらが同じ session を指す。
Companion では review / merge workflow の source を指す。
Auxiliary では parent Session と active Auxiliary を混ぜず、active Auxiliary 表示中は child conversation を指す。
closed Auxiliary は read-only transcript として描画し、composer / run / audit target にはしない。

`pendingMessageText` と optimistic user message は、mode ごとに別実装しない。
stream 開始直後に「プロンプト」と「レスポンス待機」が見えることは、shared live run contract の責務にする。

### Capability

component 内の `mode === "agent"` / `mode === "companion"` 分岐は増やさない。
表示可否は capability で受ける。

- `canCancelRun`
- `canRetryLastMessage`
- `canEditLastMessage`
- `canUseAuxiliary`
- `canQuoteResponse`
- `canAttachFiles`
- `canUseSessionFiles`
- `canAddDirectory`
- `canViewAuditLog`
- `canShowRightPaneContent`
- `canCollapseRightPane`
- `canUseApproval`
- `canUseSandbox`

capability が false の場合は、既存 UI の操作感に合わせて非表示を基本にする。
実行中など一時的に使えないだけの操作は disabled にする。
right pane は layout shell と content capability を分ける。
`canShowRightPaneContent` が false でも、shared chat layout の right pane shell は維持し、説明文で埋めない empty shell として扱う。
mode 固有の理由で pane を畳む場合も、専用 layout ではなく共通 shell の collapse state として表現する。

### Action Slots

mode 固有 action は layout を分岐させず、slot へ注入する。

- header left / right actions
- workspace actions
- session files actions
- ActionDock leading / trailing actions
- assistant response actions
- right pane tabs

`Auxiliary`、`Return to main`、`Merge`、`Audit Log`、`Delete`、`Rename`、MateTalk 固有 action は slot item として扱う。

### Service Adapter

UI component は storage や provider API の違いを知らない。
mode ごとの送信、再送、編集、キャンセル、引用挿入は adapter で受ける。

- `sendMessage(input)`
- `cancelRun()`
- `retryLastMessage()`
- `editLastMessage(messageId, draft)`
- `quoteResponse(text)`
- `openAuditLog()`
- `openAuxiliary()`
- `returnToMainSession()`

Agent と Companion の retry / edit last message は同じ UI を使い、adapter が対象 transcript と API を切り替える。
MateTalk は初期 slice で retry を持たなくてもよいが、UI component 側に MateTalk 専用の別 composer を作らない。

retry / edit の eligibility は shared UI と adapter の両方で守る。
shared UI は次を共通 precondition とする。

- `canRetryLastMessage` または `canEditLastMessage` が true。
- 現在の `transcriptSource` に retry 対象の user message がある。
- 現在の `runSource` が実行中ではない。
- 現在の `composerTarget` が writable。
- closed Auxiliary など read-only transcript ではない。

対象 message の選択は `transcriptSource` の最後の user-authored message を基本にする。
Companion の merge 中、Auxiliary の parent / child 切り替え中、MateTalk の retry 未対応など、mode 固有の禁止条件は adapter が capability false または disabled reason として返す。
既存 draft がある状態で edit last message を開始する場合は、shared UI が draft overwrite を避け、確認または明示的な置き換え操作を要求する。

## Staged Implementation

実装は大きな一括 refactor にしない。
各 step で root session が対象を絞って実装し、subagent review を挟んで次へ進む。

1. 現行差分の固定
   - Agent / Companion の pending / streaming 表示を shared helper と projection contract へ寄せる。
   - Companion で送信直後に prompt と response wait が出ることを regression test で固定する。
2. projection contract の整理
   - Agent / Companion の chat window props 組み立てを shared projection helper へ寄せる。
   - 既存 component の public props を mode-neutral な名前へ寄せる。
3. response action の共通化
   - Copy / Quote を assistant response 共通 action として扱う。
   - Quote の挿入先だけ Agent / Companion / MateTalk / Auxiliary の composer adapter で切り替える。
4. retry / edit last message の共通化
   - Agent 限定の UI 条件を外し、capability と adapter で制御する。
   - Companion では merge workflow と衝突しない条件を test に残す。
5. Auxiliary の mode-neutral 化
   - Auxiliary entry と active auxiliary host を Agent 限定から外す。
   - Companion では writable composer がある場合に有効化する。
   - MateTalk は初期対応しなくてもよいが、shared host の型と capability では除外しない。
6. MateTalk の shared chat 化
   - MateTalk 固有 message / composer 実装を shared chat projection へ寄せる。
   - cancel / audit / retry / merge など不要機能は capability off にする。

## Review Loop

各 step は次の順で進める。

1. root session が小さく実装する。
2. focused test と `npm run typecheck` を実行する。
3. reviewer subagent に差分を読ませる。
4. 指摘があれば同じ step 内で修正する。
5. `git diff --check` を通してから次 step へ進む。

reviewer には、特に次を確認させる。

- mode 固有分岐が component 内へ増えていないか。
- Agent だけ、Companion だけに残った基本機能差がないか。
- MateTalk が不要機能を独自 UI で避けず、capability off で扱えているか。
- MateTalk が content を持たない場合も shared right pane shell を維持しているか。
- projection の `conversationKey`、`transcriptSource`、`runSource`、`composerTarget`、`auditSource` が混在していないか。
- pending / streaming / retry / quote の regression test が対象 surface をまたいでいるか。
- shared helper に mode 固有の storage / provider detail が漏れていないか。

## Non Goals

- 1 回の PR で全 chat mode を全面 refactor しない。
- Companion の merge workflow を Agent と同じ lifecycle に潰さない。
- MateTalk に不要な audit / merge / retry を初期 slice で強制しない。
- Auxiliary transcript を parent transcript へ provider context として混ぜない。
- component 共通化のために service 層の責務境界を曖昧にしない。

## Acceptance Criteria

- Agent / Companion の基本 chat 操作は同じ component contract を通る。
- 新しい基本 chat 機能を追加するとき、Agent / Companion / MateTalk / Auxiliary の個別実装を同時に増やさずに済む。
- mode 固有機能は capability、action slot、service adapter のいずれかで説明できる。
- 仕様上の差異はこの文書の `Difference Matrix` に載っている。
- Auxiliary の parent / child state、Companion の review state、MateTalk の talk state は source identity で分離される。
- MateTalk は content がない場合でも、専用 layout ではなく shared right pane shell の empty state として扱う。
- retry / edit last message は shared precondition と adapter eligibility の両方で制御され、draft overwrite を暗黙に行わない。
- 差異を追加する場合は、shared に寄せられない理由を設計または PR body に残す。
