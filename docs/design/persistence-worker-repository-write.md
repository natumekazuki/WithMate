# Persistence Worker Repository Write Model

## Scope

この文書はPersistence Workerが提供するtyped write command、transaction、domain error、idempotency契約を定める。tableとdomain transactionの正本は`docs/design/multi-agent-persistence.md`、WorkerのFIFOとfailure effectは`docs/design/persistence-worker-lifecycle.md`とする。

CP2は`RepositoryWriteClient`を使用し、raw operation名や汎用SQL updateを組み立てない。commandは許可されたdomain transitionごとに分け、任意column patchを公開しない。

## Command pipeline

各commandは次の順で処理する。

1. operation別decoderでexact keys、enum、文字列長、canonical UUID、整数、JSON、payloadを検証する。
2. JSON encode、sanitize、hash、request fingerprintなど、SQLite rowを参照しない準備をtransaction開始前に完了する。
3. single FIFO上で`BEGIN IMMEDIATE`を開始し、scope、ownership、state、version、capacity、quotaを再検証する。
4. domain mutationとcompleted IdempotencyRecordを同じtransactionでcommitする。
5. commit後にだけProvider I/Oや成功response送信へ進む。

transaction callbackは同期処理に限定する。Provider I/O、非同期処理、重いencode / hashをtransaction内へ持ち込まない。

## Result and failure

domain拒否はWorker transport failureへ変換せず、次のtyped resultで返す。

- success: `{ ok: true, value, replayed }`
- rejection: `{ ok: false, error: { code, message, retryable }, replayed: false }`

malformed command、scope不一致、state conflict、busy、capacity、idempotency conflictなど、commit有無が確定している拒否はdomain resultとする。SQLite障害、Worker crash、timeoutなどcommit有無が確定できない失敗だけPersistenceErrorの`effect='unknown'`を使用する。Provider outcomeとpersistence failureを同じoutcomeへ潰さない。

## Idempotency

idempotency keyはcallerが生成するcanonical lowercase UUIDとする。Workerはkeyを除き、field順を固定したsemantic command projectionからSHA-256 fingerprintを生成する。受信JSONのproperty順やcaller提供fingerprintを信用しない。

同じkey / scope / operation / fingerprintのcompleted recordはresponse referenceの存在と所属を再検証して同じ意味のresponseを返す。異なる使用は`idempotency_conflict`、`in_progress`は`idempotency_in_progress`、期限切れtombstoneは`idempotency_expired`とする。reference欠落時は成功を捏造せず`reference_invalid`を返す。

completed recordの保持期間はWorker所有の30日とする。期限はcaller入力にせずcommit時刻から計算する。期限到達済みrecordを観測したwrite transactionはfingerprint照合結果にかかわらずresponse referenceとenvelopeを先に消去して`expired`へ進め、Session明示削除までkey tombstoneを保持する。異なるfingerprintへの応答はscrub後も`idempotency_conflict`とする。response envelopeは16 KiB以下とし、Message本文、child結果、payload、raw Provider responseを保存しない。

## Implementation slices

| Slice | Commands | Gate |
| --- | --- | --- |
| A | Session create / transition、typed result、decoder、idempotency core | exact replay、conflict、expiry、reference検証、active Run中archive / close拒否 |
| B | Run admission、Attempt / Binding / Dispatch、supplemental input | admission関連row一括、dispatch 4条件Gate、input Message / Delivery一括 |
| C | RunOutput、terminal、child collect | stored item / payload一括、terminal関連row一括、collection初回記録保持 |
| D | subtree delete、startup repair | busy全rollback、bottom-up delete、repair単調収束、外部状態を推測しない |

## Session commands

`repository.session.create`はactive Sessionとself-scopeのcompleted IdempotencyRecordを同じtransactionで作成する。ProviderBindingは作成しない。追加許可directoryはdenseな文字列配列かつabsolute pathだけを受理し、Worker境界で字句正規化して重複・包含される子pathを除外した値をfingerprintと保存に使用する。symlink / junctionを含む実在path検証はRun admission前のMain processが担う。

`repository.session.transition`はexpected lifecycleを必須とし、次だけを許可する。

- `active -> archived`
- `archived -> active`
- `active -> closed`
- `archived -> closed`

archive / closeはnon-terminal Runがない場合だけ許可する。unarchiveはworkspaceとSession Providerを再検証し、存在するopen ProviderBindingが同じProviderの`active && persistent` Bindingである場合、またはBinding未作成で次Run時に作成可能な場合だけ許可する。未収束の`creating` Bindingと再起動後にresumeできない`ephemeral` Bindingは再開根拠として使わない。`closed`からの再開、same-state update、expected state不一致を拒否する。`updated_at`は更新するが、metadata transitionだけで`last_activity_at`を進めない。
