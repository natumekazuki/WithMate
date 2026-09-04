# ADR 018: Character affectはappend-only eventから投影する

## Status

Accepted

## Context

Character自身の現在感情をsession間で扱うには、Character Definition由来の基調、継続的なrelationship affect、session固有の一時状態、Character Memory episodeを分離する必要がある。状態全体を保存すると、同時sessionの後勝ち上書き、対象の異なる感情の混合、訂正根拠の消失が起きる。

V6 DBは起動時のidempotentなschema ensureとSQLite WALを既存境界とし、Memory V6はrequest fingerprint付きidempotencyとappend/supersede/forget監査を採用している。

## Decision

- baselineはCharacter Definitionから導く入力とし、通常の感情イベントでは更新しない。
- relationship affectとsession affectは`character_affect_events_v6`へappendする。現在状態はactive eventとreset markerからapplication serviceが投影し、状態スナップショットを正本にしない。
- session layerの`session_id`はscope ownerとしてsession削除時にeventを削除する。relationship layerは`session_id`を持たず、発生元を`source_session_id`のprovenanceとして`ON DELETE SET NULL`で保持するため、source session削除でrelationship状態を失わない。
- public projectionでも`sessionId`はscopeだけを表し、relationship eventとそのmutationではnullとする。発生元Sessionは`sourceSessionId`だけで表す。
- 自由記述のlabelに、`[-1, 1]`のvalence、optional arousal/dimensions、`[0, 1]`のintensityを組み合わせる。新規eventは集約用の固定familyも必須とし、labelを分類identityとして使わない。
- family eventは少なくとも`targetType + targetId + family`で集約する。代表labelは減衰後の`intensity`寄与が最大のeventを使い、同値は新しい`occurredAt`、さらに同値はevent IDの昇順で決める。family追加前のlegacy eventはlabelから再分類せず、`targetType + targetId + legacy label`ごとに分離して、新規`other` familyへ混ぜない。
- session eventのeffective projectionはread時刻を基準に、6時間half-lifeの`0.5 ^ (ageMs / halfLifeMs)`をvalence、arousal、intensity、custom dimensionsへ同じ比率で適用する。weightが0.05未満のeventはprojectionから除外する。relationship eventとbaselineは減衰させず、既存clampを維持する。
- decayはprojectionだけに作用し、保存event、訂正、reset、idempotency ledger、state versionを書き換えない。projectionは評価基準時刻を`evaluatedAt`として返し、Conversation Timingをdecay clockに使わない。
- optional fieldの省略と明示的なundefinedは永続化とrequest fingerprintの前に同じcanonical JSON表現へ正規化する。
- relationship eventはtargetが`user`または`relationship`の場合だけ許可する。task、bug、artifact、selfへの感情はsession layerに留める。
- 同じCharacter/user内のidempotency keyはrecord、correct、reset共通のledgerで所有する。operation、訂正対象、監査理由を含むrequest fingerprintが同じ場合だけ再生し、異なる要求での再利用は拒否する。
- event/reset時刻は辞書順と実時間順が一致するcanonical UTC形式で受理する。
- 訂正はreplacement eventをappendし、元eventを`corrected`へ遷移させる。resetはscope別markerをappendする。どちらもmutation auditを残す。
- session eventをrelationshipへ訂正した後にsource sessionが削除された場合、session eventは削除し、relationship replacementと訂正mutationを保持する。参照先削除時は`correction_of_event_id`をnullへ戻し、監査理由はmutationに残す。
- session指定のinspectionは、そのsession固有のeventに加えて現在状態へ寄与するrelationship eventと監査を返す。
- Character Memory episodeはMemory V6の正規storage境界へ接続し、`local-user`のbindingとCharacter scopeを`(user, character)`のownerとして扱う。発生元SessionはMemory source provenanceへ保存し、owner scopeには使わない。
- Affect storage/application境界もsingle-user productの`local-user`だけを受理し、Memory候補の有無でowner制約を変えない。
- episode writerはapplication構成で必須とし、Memory候補を永続化前にMemory V6 contractで検証する。同じmotifの別eventは別episode、同一event retryは同じderived keyとして扱う。Affect訂正ではreplacement episodeをappendし、元episodeをMemory V6のsupersede境界へ渡す。元episodeがforgottenまたは別scopeの場合は、忘却内容を再生成せずAffect mutation前に訂正を拒否する。
- Memory appendとAffect linkは別storage transactionである。両方を独自transactionへ統合せず、Memory commit後・link前の失敗を呼び出し側へ返し、event由来の同一idempotency keyによるretryで同じMemory entryへ収束してlinkを完了する。
- Affect訂正eventは元Memory entry IDも保持する。Affect commit後・replacement Memory commit前に失敗しても、retryは同じpredecessorをMemory V6のsupersede境界へ再送する。初回はactive predecessorを事前検証し、Memory commit後・Affect link前のretryではMemory V6のidempotency replayをpredecessorの状態検証より先に解決する。
- idempotency replayとconflict rejectionは状態監査と分けたobservationへ記録し、運用metricsで集計する。通常の並行更新はappend-only transactionで直列化し、状態merge conflictを作らない。
- session終了時にsession affectをrelationshipへコピーせず、relationship更新は明示eventだけにする。別Sessionのsession-layer eventによるafterglowは、同一local-user・同一Characterの直近source Sessionからread-time projectionとしてだけ合成し、新規event、Character Memory episode、relationship stateとして保存しない。
- afterglowのhard TTLは既存`sessionHalfLifeMs`から導出し、`ageMs >= sessionHalfLifeMs`を除外する。cross-session weightは`0.5 * 0.5 ^ (ageMs / sessionHalfLifeMs)`とし、既存session decayと同じAffect dimensionsへ適用する。age 0でも最大0.5に留め、0.5は永続設定にしない。
- current Sessionを除くTTL内のactive session-layer eventから、`occurredAt DESC`、event ID昇順のcanonical順で最新のeligible eventを持つ1 Sessionだけをsourceにする。source選択後にcontinuity、same-target、component capを適用し、filter後の古いSession fallbackは行わない。source Session queryは64 event rows、afterglow componentは3件を上限とする。
- current Sessionに同じcomponent identityがあるafterglowは除外する。identityは`targetType + targetId + family`とし、family nullのlegacy eventは`targetType + targetId + legacy label`とする。task、bug、artifact、selfはcurrent Sessionのreset後active eventに同じ`targetType + targetId`がある場合だけ候補にする。baseline、relationship event、query、transcript、reason、evidenceはcontinuity判定に使わない。
- afterglowとbaselineまたはrelationshipが同じeffective identityへ合成される場合、afterglowは非afterglowの代表labelを上書きしない。current Sessionの同一identityはcandidate段階で除外するため、current eventのlabel、intensity、eventIds、versionもafterglowから変更しない。
- afterglowは既存session layerとしてpublic projectionへ現れ、public schema、既存の`targetId` / `label` field、`contributingLayers`、current Sessionのversionを変更しない。afterglowのsource Session identity、reason、evidenceはpublic response、MCP、CLI、promptへ出さず、metricsにもsource Session identity、target ID、自由label、reason、evidenceを保存しない。metricsは固定分類のaggregate counterだけを持つ。bounded query indexはV6のadditive `CREATE INDEX IF NOT EXISTS`でensureし、table、column、data backfill、`user_version`変更は行わない。
- rollout既定はshadow modeとし、application serviceがmodeをcontextへ明示する。応答への反映強度はcallerが段階的に選ぶ。

## Alternatives

### 現在状態を行単位で更新する

楽観versionを付けても、別targetや別sessionの部分更新を一つのsnapshotへ集約する責務が残り、訂正前の根拠も別途必要になるため採用しない。

### Session終了時にrelationshipへコピーする

bugやtaskへの一時感情までrelationshipへ転写し得るため採用しない。

### afterglowを永続化する

session終了時にafterglowを新規eventやrelationshipへコピーすると、短いread-timeの余韻が永続stateへ昇格し、task系targetの漏れ、retry/restart時の重複、owner境界の複雑化を招くため採用しない。afterglowは既存eventをread-timeにbounded projectionする。

## Migration and rollback

schema変更はV6 DBへのadditive table/index/column追加とし、`ensureV6Schema`のsavepoint内で適用する。失敗時はschema追加をまとめてrollbackする。V6の`user_version`は変更しない。

family列はnullableかつ固定enumのCHECK付きでadditive追加する。既存rowはNULLのまま保持し、labelからのbackfillや`other`への一括分類を行わない。新規eventはapplication validationでfamilyを必須にしてから保存する。

アプリ版をrollbackした場合、旧版は追加tableを参照せず既存V6 dataを読み続けられる。感情tableを自動dropしないため、再upgrade時にevent履歴を再利用できる。物理削除が必要な場合は、別の明示的なdestructive migrationとして扱う。

## Consequences

- 同時sessionは別session eventをappendするため、現在気分を相互上書きしない。
- effective state取得時の集約costはevent数に比例する。保持期間やsnapshot最適化は観測結果に基づく後続課題とする。
- provider/MCP/UIの接続は別Issueでapplication serviceを利用し、独自永続化や独自合成を作らない。
