# ADR 025: Session Turn scheduleは永続fireから既存queueへ委譲する

## Status

Accepted

## Context

通常SessionのTurnを、指定日時または定期条件に従って自動登録する必要がある。既存のSession execution ownerは、`turn.enqueue`、Session単位FIFO、queue上限、admission、cancel、再起動復旧、idempotencyを所有している。scheduleがこれらを複製すると、GUI送信と自動実行で実行順、上限、復旧結果が分岐する。

schedule発火では、DBへのclaimと`turn.enqueue`という外部副作用の間にprocess crashまたはresponse lossが起こり得る。時刻条件、schedule更新、再起動復旧、enqueue idempotencyを一つの責務境界で収束させる必要がある。

## Decision

### scheduleとfireを専用の永続ownerで管理する

- Schedule serviceはschedule設定、次回論理発火、fire claim、enqueue結果、起動時recovery、process timerだけを所有する。
- scheduleとfireをSQLite v6の専用tableへ保存する。
- schedule更新とdue fire作成はtransactionでrevisionへ収束させる。
- `turn.enqueue`はDB transaction外で呼び出す。
- fireはimmutableなSession ID、Turn request snapshot、schedule revision、論理発火instant、idempotency keyを保持する。
- claim後のcrashまたはenqueue response lossでは、保存済みfireの同じTurn requestとidempotency keyを再送する。
- update、pause、deleteは未claimの将来発火だけへ作用し、claimed fireまたは受理済みexecutionをcancelしない。
- delete後もrecoveryに必要なclaimed fireとschedule tombstoneは、fireがsettleするまで保持する。

### 既存のSession enqueue境界へ委譲する

- 発火とrun nowは、GUI Turnと同じMain Process application boundaryから既存`turn.enqueue`へ委譲する。
- initiatorは既存の`{ kind: "user" }`を使う。
- Schedule serviceはprovider、Session busy判定、FIFO、queue capacity、queued admission、cancel、execution recoveryを実装しない。
- queue fullはそのfireの失敗として保存する。Cron scheduleの将来発火は維持する。
- 保存済みTurn tupleとattachmentは、発火時にcurrent catalogと現在のSession permissionで再検証する。無効な場合はenqueueせず、fireを失敗にしてscheduleを停止する。
- Add DirectoryはSessionの`allowedAdditionalDirectories`を変更する既存操作とし、scheduleへ許可snapshotを複製しない。

### onceとCronを区別する

- `once`はローカル日時とIANA time zoneを保存時に一つのUTC instantへ正規化する。過去、存在しない時刻、曖昧な時刻、未知のzoneは保存前に拒否する。
- `cron`はminute、hour、day-of-month、month、day-of-weekの5 fieldとし、秒fieldと拡張構文を受け付けない。
- CronはIANA time zone上のcalendar recurrenceとして扱う。DST gapの存在しないoccurrenceはskipし、foldの重複occurrenceは早いUTC instantだけを採用する。
- day-of-monthとday-of-weekを双方限定した場合はORとする。
- アプリ停止またはPC休止中の複数occurrenceは最新の一件へ畳み、再開後一回だけenqueueする。
- 稼働中は前回executionの完了を待たず、各論理発火を通常のSession FIFOへenqueueする。

### GUI authorityをWindow単位で分ける

- Homeは全Sessionのschedule一覧をread-onlyで表示する。
- create、update、pause、resume、delete、run nowは対象SessionWindowからだけ受け付ける。
- CLI、MCP、Session external runtimeのpublic schemaへschedule操作を追加しない。
- SessionWindowのschedule一覧はchatのmain contentを置き換え、ActionDockを隠す。
- create/editだけ既存ActionDockをschedule draft ownerへ切り替え、prompt、attachment、Model、Reasoning、Approval、Sandbox、Custom Agent、Add Directoryを既存操作と共有する。
- schedule draftとchat draftは独立させる。

### resource上限を固定する

- 一Sessionあたり最大20 scheduleとする。
- 各scheduleは直近50件のterminal fire履歴を保持する。pendingまたはclaimed fireはretention対象から除外する。
- timer ownerはMain Processに一つだけ置き、起動、schedule変更、shutdownに合わせて再armまたは破棄する。

## Consequences

### Positive

- GUI送信とschedule発火が同じqueue、execution ID、message list、cancel、recovery契約へ収束する。
- schedule編集または削除と、すでにclaimしたfireのreplayを分離できる。
- response loss後も同じexecution IDへ収束し、provider effectを二重化しない。
- Homeから状態を横断確認できる一方、変更authorityは対象SessionWindowへ限定される。

### Negative

- Cronのtime zoneとDST規則をexecutable contractで維持する必要がある。
- schedule tombstoneとimmutable fire snapshotにより、単純なschedule tableだけより永続modelが増える。
- Main Processの起動・停止にSchedule serviceのreconcileとtimer cleanupを追加する必要がある。

## References

- `docs/adr/021-session-cli-mcp-application-boundary.md`
- `docs/design/session-external-runtime.md`
- `docs/design/session-turn-storage-v6.md`
- `docs/plans/20260818-session-turn-scheduling/plan.md`
