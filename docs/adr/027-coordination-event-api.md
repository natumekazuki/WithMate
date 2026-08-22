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
- escalationは同じrootのancestorを作成時に指定し、そのancestorだけがresolveする。blockerは作成Session、user decisionはtrusted GUIだけがresolveする。user decisionでは提示optionのstable ID、またはユーザーが入力した自由回答のどちらか一方をactionへ保存する。cancelは作成Sessionまたはtrusted GUI、correctionは作成Session自身のeventだけを対象にする。
- resolvedになったuser decisionは、Eventを作成したSessionが回答を実作業へ反映するまで、通常Turnのinput contextへ最新の未使用回答を一件だけ投影する。未使用の間はtrusted GUIが新しい`resolved` actionを追記して回答を変更できる。反映後はowner Sessionが、投影された`resolutionSequence`を`expectedResolutionSequence`として`coordination.event.consume`へ渡し、同じrevisionである場合だけ`consumed` actionを追記する。Eventのpublic stateは`resolved`のまま保持し、ユーザー回答の履歴とAgentによる消費を同じ状態遷移へ畳み込まない。
- payloadはsummaryと限定されたdetail fieldだけを受け付け、UTF-8 JSON 16 KiB、field件数・文字数を共有validatorで検証する。secret、credential assignment、raw log、stack trace、大きなdiff、provider response、chain-of-thought、Windows drive・UNCを含む個人環境path、opaque bindingを拒否する。execution関連付けはactor Session所有のexecutionだけを許可する。
- mutationはprincipal Session単位のidempotency keyを必須とする。fingerprintはoperation、principal種別、principal Session、Role snapshot、target、payload、execution、target Sessionを含む。canonical replayはcurrent authorityとtarget state検証より先に返す。
- storage commitをGUI publicationとresponseより先に置く。publication failureは`effect: applied`とevent IDを返し、同じkeyのcanonical replayでもinvalidationを再送してevent ID/keyのgetと併せて再照合できるようにする。WindowへのinvalidationはEvent IDとaction revisionを持ち、一つのpublisherが失敗した宛先の有無にかかわらず他の宛先へ配信を続け、process内で同じinvalidationを再試行する。同じEventのinvalidationがretry中に重なった場合は新しいrevision、異なるEventなら全体invalidationへ畳み込む。Session削除後のCoordination invalidationも同じpublisherへ全体invalidationとして載せ、process再起動時はinitial loadでcanonical stateへ収束する。external streaming endpointは追加しない。
- CLI、MCP、raw HTTPはshared runtime contractの七操作、strict validator、result/error envelopeを共有する。listはdefault 50、maximum 100とし、cursorをprincipal、scope、filterへ結び付け、summary columnだけを読む。`consume`はowner Sessionだけに許可し、principal単位のidempotency keyと投影時の`expectedResolutionSequence`を必須とする。
- Coordination UIはSession右ペインではなく、全Sessionのeventを扱う単一の`Coordination Window`へ集約する。初期表示はSessionとstateを絞らない「すべて」とし、新しいeventから取得する。`open`を先に並べ替えず、要対応、回答済み、履歴はユーザーが選ぶfilter projectionとして提供する。
- Eventのcanonical originはactor Sessionとする。WindowはSession titleを主表示し、Character nameは表示上の主情報にしない。Character iconはユーザーがSessionを識別する補助情報として、current Session projectionから解決する。EventへCharacter nameやiconを複製保存しない。
- Session filterはHomeと同じSession探索の操作感を使い、Session title検索と逐次読み込みで選択する。選択後のevent取得はtrusted GUI queryへ`sessionId`を渡し、eventの読込済みpageだけをrendererで絞らない。Session groupingとCoordination eventがあるSessionだけを返すaggregateはfirst sliceへ含めない。
- detailは要求時に取得し、storage commit後signalのEvent IDとaction revisionに基づいて必要なprojectionだけを更新する。request revision、event filter、選択Sessionを照合して古いresponseを捨て、一時的な取得失敗では最後に成功した一覧をstale表示として保持する。Agent向けの`self | subtree` authorityと、全Sessionを表示するtrusted GUI queryを混同しない。
- Windowの常設操作はSession選択とstate filterに限定し、画面内title、説明文、Home遷移、取得済み件数、空状態メッセージを置かない。Session pickerとevent一覧は末尾接近で自動的に次pageを読み込み、一覧とdetailを独立してscrollできるようにする。Event originから所有Sessionを開けるようにし、同じ遷移先の専用buttonを重ねない。blockerは作成Sessionだけがresolveし、Coordination WindowはEvent取消だけを提供する。回答mutation中は二重操作を防ぎ、同じEventのinvalidation revisionが返却Event以下なら再取得せず局所反映する。より新しいrevisionは対象Eventだけを再取得し、未知Eventまたは全体invalidationで一覧を再取得する。
- System Promptは登録対象、保存禁止情報、登録失敗時の扱い、未使用回答を反映した後の`consume`を固定指示として説明する。回答本文はSystem Promptへ含めず、Conversation Timingの後かつUser Inputの前にinput contextとして投影する。未使用回答がないTurnでも固定System Promptを変えず、prompt complianceはauthority、validation、idempotencyの代替にしない。

## Consequences

- provider response loss後もcoordination historyとstateを再取得できる。
- 回答を反映する前にTurnが失敗または中断した場合、回答は次のTurnにも再投影される。Agentが明示的にconsumeした後は再投影されない。
- ユーザーはCoordination Windowを開いた時点で、判断待ちに限らない全eventを時系列で確認できる。Session単位の確認が必要な場合だけfilterを適用する。
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
- `docs/design/window-architecture.md`
- `docs/design/desktop-ui.md`
- `docs/design/session-external-runtime.md`
- `docs/runbooks/session-cli.md`
