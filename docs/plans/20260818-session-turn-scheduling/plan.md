# Session Turn Scheduling 実装計画

## Scope

- 通常 Session の Turn を、一回限りまたは 5 field Cron で自動的に既存 `turn.enqueue` へ登録する。
- schedule、fire、claim、結果、再起動復旧を SQLite v6 へ永続化する。
- schedule 操作は GUI IPC のみに公開する。Home は全 Session の read-only 一覧、変更操作は対象 SessionWindow に限定する。
- SessionWindow の schedule 作成・編集時だけ既存 ActionDock を schedule draft の編集へ切り替える。
- CLI、MCP、Auxiliary、Companion、Character Authoring、独自 provider 経路、独自 Session queue は対象外とする。

## Accepted contract delta

添付 Issue の `interval` 契約は、2026-08-18 のユーザー合意により `cron` へ置き換える。現行 source、test、ADR は schedule 未実装であり、既存 consumer との互換対象はない。

- trigger は `once | cron` とする。
- Cron は `minute hour day-of-month month day-of-week` の 5 field とし、秒、名前、`L`、`W`、`#`、`?`、macro は受け付けない。
- `*`、数値、list、range、step を扱う。day-of-month と day-of-week が双方限定される場合は traditional OR とする。
- Cron は IANA time zone 上の calendar recurrence とする。DST gap の存在しない occurrence は skip し、fold の重複 occurrence は早い UTC instant の一回だけ発火する。
- missed occurrence は各 schedule で最新の一件へ畳み、再開後一回だけ enqueue する。
- once の存在しない／曖昧なローカル日時、過去日時、未知の time zone は永続 mutation 前に拒否する。

## Closure Map

### SCH-TIME-01 trigger と時刻正規化

- Accepted anchor and meaning: ユーザー合意済み `once | cron` 契約。fallback せず、同じ入力と clock から同じ論理 fire instant を得る。
- Canonical owner: schedule trigger domain。
- Siblings in scope: create、update、resume、startup reconcile、timer re-arm、public projection。
- Excluded siblings and reason: OS background execution は対象外。provider と queue は時刻を所有しない。
- Failure points: invalid zone／Cron／once を保存する、DST で二重発火する、missed を全件 catch up する、wall-clock delay で周期が drift する。
- Direct checks: deterministic clock を使う unit test で future/past once、invalid zone、Cron field、DOM/DOW OR、DST gap/fold、複数 missed の collapse、次回算出を観測する。
- Independent review lens: Cron/DST と timer/reconcile の組合せ。
- Gate: ready。

### SCH-CLAIM-02 fire claim と外部副作用

- Accepted anchor and meaning: stable fire ID と enqueue idempotency key、DB transaction 外の `turn.enqueue`、response loss/restart retry の収束。
- Canonical owner: schedule storage の claim/settle transaction と schedule service の replay loop。
- Siblings in scope: due fire、run now、claim 後 crash、enqueue response loss、startup pending recovery、update/pause/delete 競合。
- Excluded siblings and reason: queued admission、provider dispatch、execution recovery は既存 `SessionExecutionService` owner。
- Failure points: 同じ論理 fire が二 execution を作る、transaction 中に enqueue する、stale revision を claim する、accepted execution を pause/delete が cancel する。
- Direct checks: storage integration test で競合 state transition、service integration test で同一 key retry と同一 execution ID、side effect 前後の failure injection を観測する。
- Independent review lens: transaction/external side effect/recovery。
- Gate: ready。

### SCH-DATA-03 schema、migration、retention、owner

- Accepted anchor and meaning: supported v6 DB から安全に追加し、一 Session 20 schedule、各 schedule 50 terminal fire を保持する。
- Canonical owner: v6 schema migration と schedule storage。
- Siblings in scope: empty/populated DB、再適用、途中失敗 rollback、Session delete cascade、pending claim を除外する cleanup。
- Excluded siblings and reason: v2/v3 data model自体の変更はせず、v6 bootstrap の既存 migration 経路だけを拡張する。
- Failure points: partial schema、orphan fire、上限 race、pending fire 削除、full payload を Home list が hydrate する。
- Direct checks: migration integration、transactional exact-limit test、retention/recovery row test、foreign-key cascade test。
- Independent review lens: migration order と cleanup invariants。
- Gate: ready。

### SCH-TURN-04 Turn tuple と Session-owned permission

- Accepted anchor and meaning: prompt、provider/model/reasoning/approval/sandbox/custom agent/attachments を schedule snapshot とし、発火時は current catalog と現在の Session permission で再検証する。
- Canonical owner: 既存 Session turn request validator/catalog owner。schedule service は validated request を `turn.enqueue` へ委譲する。
- Siblings in scope: create/update、fire、run now、catalog revision change、attachment identity、Add Directory removal、Session deletion。
- Excluded siblings and reason: Add Directory allowlist は Session が所有し、scheduleへ複製しない。CLI/MCP binding と schedule initiator は別 family。
- Failure points: unsupported tupleへ fallback、削除済み許可で外部 path を読む、fake binding、独自 queue/provider call。
- Direct checks: application observable test で validation error は enqueue なし・fire failed・schedule paused、valid request は user initiator と同じ FIFO projectionへ到達することを観測する。
- Independent review lens: catalog/attachment permission/enqueue boundary。
- Gate: ready。

### SCH-IPC-05 GUI authority と projection

- Accepted anchor and meaning: Home は全 schedule read-only、mutation は owner SessionWindow のみ。CLI/MCP schema は不変。
- Canonical owner: Main IPC registration の sender-window authority と shared runtime validator。
- Siblings in scope: create/list/get/update/pause/resume/delete/run now、preload、window API、Home/Session projection。
- Excluded siblings and reason: Session HTTP/CLI/MCP public contract は対象外。
- Failure points: Home や別 SessionWindow から mutation、unknown input bypass、private request payload leak、stale async response が draft を上書きする。
- Direct checks: IPC contract test で sender scope、validator、error mappingを観測し、typecheckで shared shape を閉じる。
- Independent review lens: sender authority と non-public sibling absence。
- Gate: ready。

### SCH-UI-06 ActionDock と lifecycle

- Accepted anchor and meaning: Session list では ActionDock を隠し、create/edit のみ schedule draft ownerへ切り替える。Home は一覧のみ。icon-only controlにも accessible nameを残す。
- Canonical owner: shared ChatWindow/ActionDock props と schedule workspace state。
- Siblings in scope: loading、empty、paused、validation/enqueue error、dirty draft、back、create/edit、pause/resume/delete/run now。
- Excluded siblings and reason: chat message layout と通常 composer state は変更しない。
- Failure points: schedule編集がchat draft/Session turn defaultsを変更する、戻る表示文字を増やす、timer/listenerがwindow単位で増える、Homeからmutationする。
- Direct checks: component/projection testでmode、callback、表示state、accessible labelを観測し、分離起動で描画と操作を確認する。
- Independent review lens: ActionDock state owner と cleanup。
- Gate: ready。

## Test design

| Failure mode                                          | Consumer impact              | Canonical owner            | Observable                                      | Check layer          |
| ----------------------------------------------------- | ---------------------------- | -------------------------- | ----------------------------------------------- | -------------------- |
| Cron/zone/DST が異なる instant を作る                 | 予定外または二重実行         | trigger domain             | next logical instant / rejection                | unit                 |
| claim/retry が二 execution を作る                     | 重複 Turn                    | storage + schedule service | fire state、key、execution ID、enqueue calls    | integration          |
| migration が partial schema/data loss を残す          | 起動不能または既存 data loss | v6 bootstrap               | tables/indexes/rows after success/failure/retry | integration          |
| queue full/catalog invalidを再queueまたはfallbackする | 隠れた実行・永続失敗         | schedule service           | failed fire、pause、enqueue side effect absence | service integration  |
| limit/retention を race で超える                      | unbounded storage            | schedule storage           | committed row counts / preserved pending rows   | integration          |
| Home/別Sessionからmutationできる                      | authority逸脱                | IPC registration           | structured rejection before mutation            | IPC test             |
| schedule editがchat draftを壊す                       | 入力消失                     | renderer state owner       | independent state transitions                   | component/projection |
| shutdown/update/delete後もtimerが発火する             | ghost enqueue / leak         | process schedule owner     | canceled handles / no later enqueue             | service test         |

## Validation and review

- Targeted: trigger domain、schedule storage、migration、schedule service、IPC/preload、renderer projection/component。
- Holistic: `npm run typecheck`、`npm test`、`npm run build`。
- Visual: `scripts/start-withmate-visual-check.ps1` の分離profileでSession create/edit/pause/resume/run now/予定発火/error/restart表示とHome一覧を確認する。
- Full-review gate: run。永続化、migration、transaction/external side effect、process lifecycle、IPC authority、GUIを横断し、targeted checkだけでは全相互作用を直接観測できないため。
- Review target: 実装・検証後の通常commitをSessionFolder配下のclean detached worktreeで一度だけcomplete-diff reviewする。
