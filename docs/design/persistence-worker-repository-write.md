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

## Normal Run admission

`repository.run.admit`はS6-Bの最初の縦切りとして、通常Runの新規user Message、`queued` Run、最初の`preparing` Attempt、`pending` Dispatch、必要な`creating` Binding intent、Run参照のcompleted IdempotencyRecordを1 transactionで作成する。Sessionはworkspaceが一致する`active`状態で、non-terminal Runを持たないことを同じtransaction内で再検証する。

Binding intentは次のどちらかをcallerが明示し、WorkerがDB状態と照合する。

- `reuse`: 指定Bindingが同じSession / Providerの`active && persistent` Bindingであることを要求し、Attemptへ設定する。ephemeral Bindingの同一process内再利用は、Workerがlive ownershipを証明できるcommandを導入するまで許可しない。
- `create`: Sessionにopen Bindingがないことを要求し、Attemptは`provider_binding_id=null`、Bindingは同Attemptを作成元とする`creating`で追加する。

Message本文、execution snapshot、Provider requestはdenseなJSON値として検証し、object key順を正規化してからencodeする。execution snapshotは`providerId`、`model`、`reasoning`、`approval`、`sandbox`、`workspace`、`character`を必須とし、ProviderはSession設定と一致させる。Provider request本文は保存せず、Workerが生成したSHA-256だけをDispatchへ保存する。commandのsemantic fingerprintもcaller提供hashを信用せず、正規化済みMessage / snapshot、Worker生成Dispatch fingerprint、ID、Binding intentから生成する。

Worker repositoryは通常Run、Auxiliary、child Runで共有するapp全体とProvider別のnon-terminal Run上限を構築時optionとして所有する。defaultはそれぞれ4で、low-resource profileは2を渡す。admission transaction内で現在数を集計し、上限到達時はretryableな`capacity_exceeded`としてRun追加前に拒否する。root child上限はchild admission commandで追加する。

この縦切りは新規通常Runだけを扱う。既存Messageを参照するretry、Provider Binding確定、Dispatchの`dispatching` / resolution、supplemental inputは後続のS6-B commandとして追加する。

## Provider Binding resolution

`repository.binding.resolve`は、Run admissionでdurable commit済みの`creating` Bindingに対する外部会話作成結果を確定する。commandはSession / workspace / Run / Attempt / Bindingを明示し、Workerは作成元Attempt、同一Session、Session Provider、`preparing` Attempt、non-terminal Run、`pending` Dispatchを同じtransaction内で照合する。

- `active`: Bindingへ一意な外部会話IDを設定して`active`へ進め、作成元Attemptの`provider_binding_id`を同じtransactionで設定する。このcommit成功後だけDispatch開始へ進める。
- `ambiguous`: Bindingを`conversation_start_ambiguous`で`invalidated`、AttemptとRunを`interrupted`、未送信Dispatchを`aborted`へ同じtransactionで収束させる。同じ会話作成requestを自動再送せず、Provider側orphanを推測相関・自動削除しない。

この内部CAS transitionにはIdempotencyRecordを追加せず、自然キーと確定状態でexact replayを判定する。同じ外部IDまたは同じambiguous outcomeの再通知は`replayed=true`、異なる確定値や状態後退は`lifecycle_conflict`とする。

ephemeral Bindingのactive化ではcanonical UUIDのlive ownership tokenを要求し、DB commit後にだけWorker memoryへ登録する。tokenはDBやresponse envelopeへ保存せず、Worker再起動で失われる。active化responseを再送しただけではtokenを再登録せず、所有情報が失われたephemeral Bindingをresume可能へ戻さない。
