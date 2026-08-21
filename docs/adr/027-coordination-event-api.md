# ADR 027: Coordination Eventを通常responseから分離した履歴として所有する

## Status

Accepted

## Context

Agentの判断、進行、利用者判断待ちを通常responseだけで伝えると、provider delivery失敗、再試行、複数Sessionの協調で状態が失われる。反対に、Coordination domainがRole階層、Turn command、work itemを独自に持つと、ADR 021とADR 026のauthority ownerが分裂する。

## Decision

- event本文とstate action履歴は`coordination_events_v6`、`coordination_event_actions_v6`を正本とする。本文は作成後に更新せず、public stateはkindの初期stateと最新actionから投影する。
- kindは`progress`、`decision`、`escalation`、`user_decision_required`、`blocker`、`result`、`correction`、stateは`recorded`、`open`、`resolved`、`superseded`、`cancelled`の閉じた列挙とする。correction作成と対象のsuperseded actionは同一transactionへ置く。
- actorはruntime bindingから解決する。作成時の`sessionRole`、revision、root、parent、depthはhistory snapshotとして保存するが、authority判定には`session_role_bindings_v6`のcurrent canonical bindingを使う。Coordination domainはRoleやSession treeを定義しない。
- self readは全Role、subtree readはoverall coordinatorとtask coordinatorだけを許可する。task coordinatorのsubtreeは自分と直接のexecutor、overall coordinatorは同じrootに限定する。権限外とcross-rootは存在を区別せず`COORDINATION_EVENT_NOT_FOUND`へ収束させる。
- escalationは同じrootのancestorを作成時に指定し、そのancestorだけがresolveする。blockerは作成Session、user decisionは対象Session Windowからのtrusted GUI option選択だけがresolveする。cancelは作成Sessionまたはtrusted GUI、correctionは作成Session自身のeventだけを対象にする。
- payloadはsummaryと限定されたdetail fieldだけを受け付け、UTF-8 JSON 16 KiB、field件数・文字数を共有validatorで検証する。secret、credential assignment、raw log、stack trace、大きなdiff、provider response、chain-of-thought、Windows drive・UNCを含む個人環境path、opaque bindingを拒否する。execution関連付けはactor Session所有のexecutionだけを許可する。
- mutationはprincipal Session単位のidempotency keyを必須とする。fingerprintはoperation、principal種別、principal Session、Role snapshot、target、payload、execution、target Sessionを含む。canonical replayはcurrent authorityとtarget state検証より先に返す。
- storage commitをGUI publicationとresponseより先に置く。publication failureは`effect: applied`とevent IDを返し、同じkeyのcanonical replayでもinvalidationを再送してevent ID/keyのgetと併せて再照合できるようにする。Windowへのinvalidationは一つのpublisherが失敗した宛先の有無にかかわらず他の宛先へ配信を続け、process内で再試行する。Session削除後のCoordination invalidationも同じpublisherへ載せ、process再起動時はinitial loadでcanonical stateへ収束する。external streaming endpointは追加しない。
- CLI、MCP、raw HTTPはshared runtime contractの六操作、strict validator、result/error envelopeを共有する。listはdefault 50、maximum 100とし、cursorをprincipal、scope、filterへ結び付け、summary columnだけを読む。
- Session右ペインはeventが一件以上ある時だけ`Coordination` tabを出す。ただし取得失敗中は0件を確定結果と扱わず、tab内に再試行を示す。coordinatorはsubtree、それ以外はselfを取得し、openのuser decision、blocker、escalationは公開listの100件上限とは別に全pageを取得して優先する。detailは要求時に取得し、commit後signalで再読込する。request revisionと選択Sessionを照合して古いresponseを捨て、一時的な取得失敗では最後に成功した一覧をstale表示として保持する。
- System Promptは登録対象、保存禁止情報、登録失敗時の扱いを説明するが、通常responseの文体や形式を強制しない。prompt complianceはauthority、validation、idempotencyの代替にしない。

## Consequences

- provider response loss後もcoordination historyとstateを再取得できる。
- Coordination三表は必要列と外部キーだけでなくkind、Role snapshot、action、idempotency operation、target・correction・option・action tupleのCHECKをschema validityとして検証し、一つだけ欠けたnear-missも起動時に拒否する。
- Sessionを削除すると、そのSessionが参照するCoordination historyもforeign key cascadeで同じ削除へ含め、削除済み情報をfeedへ残さない。期間ベースの自動retentionは、監査要件を決める後続変更で扱う。
- 実provider accountとの接続確認は不要だが、shared contract、raw HTTP、CLI、MCP、trusted GUI IPC、projectionはaccount不要のcontract testで検証できる。

## Alternatives

### 通常responseへ特殊tagを埋め込む

deliveryと表示形式へ永続状態を依存させ、再試行とauthorityを閉じられないため採用しない。

### Coordination domainで独自Session treeを持つ

ADR 026のcanonical hierarchyと競合するため採用しない。

### event rowへcurrent stateを更新する

本文と履歴の区別を失い、correctionの監査可能性を下げるため採用しない。

## References

- ADR 021: Session CLI/MCP application boundary
- ADR 026: Session Role binding authority
- `docs/design/session-external-runtime.md`
- `docs/runbooks/session-cli.md`
