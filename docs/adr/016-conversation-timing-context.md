# 016 Conversation Timing Context

- 状態: Accepted
- 日付: 2026-08-09

## Context

Character はprovider実行時の現在日時や、正常に完了した前回turnからの経過を正確には取得できない。Sessionの`updated_at`は実行開始、失敗、設定変更でも更新され、messageの`created_at`は保存処理で再作成されるため、会話完了時刻の正本にはできない。

時間情報は会話の入り方と親しさを調整する弱いシグナルであり、別Sessionの会話内容を知る経路や、生活状況を推測する根拠にはしない。また、Copilotのsession system messageをturnごとに変えると固定指示のcache境界を崩す。

## Decision

- 会話完了時刻は`session_turns_v6.completed_at`、turn実行開始時刻は`session_turns_v6.started_at`を正本とする。
- terminal Sessionと、phase、assistant message index、thread、error、完了時刻からなる最小terminal markerを同じSQLite transactionで保存する。markerは`running`からterminal phaseへ一度だけ遷移し、commit後のprojection失敗やstale writeで再分類しない。Conversation Timingはこのmarkerだけで次turnと再起動後のreadへ反映でき、provider payloadやoperationを含む詳細auditのbackground保存を待たない。terminal marker確定後のstaleなrunning audit更新はphaseを巻き戻さない。
- 対象は`session_kind = 'default'`の通常Sessionに属する、`phase = 'completed'`かつ`assistant_message_seq IS NOT NULL`のturnだけとする。Auxiliary、Companion、Character Authoringは集計および注入から除外する。
- user turn開始時にローカル日時を一度だけ取得し、storage snapshotから経過時間、同じCharacterの別Sessionにおける最新完了時刻、今日と累積のturn壁時計時間を純粋resolverで算出する。同一turnの監査、provider実行、internal retryでは同じ結果を再利用する。
- parse不能な時刻、基準時刻より未来の完了時刻、`completed_at < started_at`の実行時間は推測や0への丸めを行わず除外する。
- Character ownerを確定できない場合、Character単位の値は未取得とする。ownerを確定できるが対象turnがない場合、共同作業時間は0とする。
- 可変な時間情報は`# Conversation Timing`としてinput側の`# User Input`直前へ置き、system側へ入れない。Codexのlogical promptとCopilotの`session.send.prompt`は同じsectionを使う。
- sectionには、時間情報を会話のペースと親しさの弱いシグナルとして扱い、別Session内容、空白期間の出来事、所在地、睡眠、勤務、休日、予定を推測しない固定規則を含める。
- 既存indexでread queryを実装し、migrationや新規indexは追加しない。性能上の根拠が得られた場合は別の論理変更で再検討する。

実装の正本は`src-electron/audit-log-storage-v6.ts`、`src-electron/conversation-timing.ts`、`src-electron/session-runtime-service.ts`、`src-electron/provider-prompt.ts`とする。観測可能な契約は対応する`scripts/tests/`のtestに置く。

## Alternatives

### `Session.updatedAt`を使う

Session一覧から取得しやすいが、正常完了以外の更新を会話時刻として誤認する。

### messageの`created_at`を使う

発言に近い名前だが、現在の保存処理ではmessage行の再作成時刻であり、個々の発言時刻を表さない。

### providerまたはprompt composerが現在時刻とDBを直接取得する

配線は短くなるが、監査とtransport、internal retryで値がずれ、prompt composerの純粋境界も失われる。

### system promptへ時間情報を入れる

固定指示とまとめられるが、turnごとの可変値がCopilotのsystem message設定へ入り、provider間の監査境界とcache安定性を損なう。

### 経過時間を固定区分や挨拶へ変換する

Character間の表現を揃えやすいが、会話の入り方が機械的になり、Character固有の温度調整を妨げる。

## Consequences

### Positive

- 正常完了した会話だけを根拠に、短い中断と長い中断をCharacterが区別できる。
- 監査promptと実transport、stale retryが同じ基準時刻と集計結果を共有する。
- 別Sessionの存在による親しさと、そのSession内容の非共有を明確に分離できる。
- schema変更なしで、現在日時とCharacter単位の共同作業量を提供できる。

### Negative

- 通常turn開始ごとにSessionとturnを読むqueryが増える。
- turn壁時計時間にはprovider、tool、internal retryが含まれ、連続滞在時間や純粋な会話時間としては利用できない。
- 不正な保存時刻は値全体または該当turnを欠損として扱うため、履歴が存在してもprompt行が省略される場合がある。
