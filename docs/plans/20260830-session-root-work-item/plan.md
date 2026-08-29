# Session Root WorkItem 改修計画

## 目的

`standalone` と `overall-coordinator` の各 root Session に、Session 自身が所有する Root WorkItem を一つ持たせる。

Root WorkItem は Session の継続的な作業目標、完了条件、進捗、阻害要因、次の行動、終了結果を保持する。別 Session から作業を再開するときは、WorkItem とその履歴だけで現在地を復元できることを目標とする。

既存の delegated WorkItem は、作成者から対象 Session への不変な委任契約として扱う。Root WorkItem の自己更新を許可するために、delegated WorkItem の所有権や変更権限を緩めない。

## 対象範囲

- root Session 作成時の Root WorkItem 自動作成
- Root WorkItem と delegated WorkItem の種別および不変条件
- Root WorkItem の契約改訂、進捗記録、状態遷移、終了結果
- WorkItem の改訂履歴と進捗履歴の永続化
- 既存データの migration と既存 root Session への backfill
- HTTP、CLI、MCP、runtime catalog の公開契約
- Session 削除、実行関連付け、再起動後の復元との整合

次は対象外とする。

- repository 内に provider Agent が作成する任意ファイルの検出、登録、同期、参照
- provider 固有の作業分解方法や成果物形式の解釈
- delegated WorkItem の委任契約を対象 Session が改訂する機能

## 現行契約

- WorkItem contract revision は `1` である。
- `work_items_v6` は `creator_session_id <> target_session_id` を必須とする。
- `work.create` は `overall-coordinator` と `task-coordinator` に限定され、対象は直接の child Session に限定される。
- goal、scope、completionCriteria、authority、sourceIdentity は作成後に変更できない。
- target Session は状態遷移と結果報告、creator Session は取消のみ実行できる。
- terminal state から active state へ戻せない。
- WorkItem mutation は resource revision と idempotency key で競合と再送を制御する。
- active または未回収の WorkItem が参照する Session の削除は保護される。

## 採用するモデル

### WorkItem の種別

WorkItem に明示的な種別を追加する。

- `root`: root Session 自身が作成者かつ対象であり、parent を持たない。
- `delegated`: 現行と同じく、作成者と対象が異なる委任契約である。

種別を creator と target の一致だけから暗黙推論しない。schema、service、public contract の全境界で組み合わせを検証する。

### Root WorkItem の一意性

次の不変条件を database constraint と service validation の両方で所有する。

- `standalone` と `overall-coordinator` の root Session は Root WorkItem をちょうど一つ持つ。
- `root` は `rootSessionId = creatorSessionId = targetSessionId`、`parentWorkItemId = null` とする。
- child Session と `character-authoring` Session は Root WorkItem を持たない。
- `delegated` は引き続き `creatorSessionId <> targetSessionId` とする。
- 任意の自己対象 delegated WorkItem は作成できない。

Root WorkItem ID は再試行時に同じ値を導出できる形式にするか、root Session ID に対する一意制約と同一 transaction 内の upsert で重複を防ぐ。外部から任意の Root WorkItem ID を指定させない。

### 変更可能な情報

Root WorkItem の owner Session は次を改訂できる。

- goal
- scope
- completionCriteria
- 作業上の制約や権限説明
- state
- progress summary
- blockers
- next action
- terminal result

次は改訂できない。

- WorkItem ID と種別
- root、creator、target、parent の binding
- 作成日時
- 過去の改訂履歴と進捗履歴
- Session role と runtime が決める実行権限の上限
- terminal state から active state への復帰

自由記述の authority は作業上の制約を伝える説明であり、owner は他の契約情報と同様に改訂できる。ただし、実行権限の正本にはしない。Session role、communication policy、runtime capability が canonical authority ceiling を所有し、Root WorkItem の記述はその権限を拡張できない。

初回実装では新しい capability 語彙や構造化 grant を導入しない。すべての認可を既存の Session authority から判定し、自由記述を認可条件として解釈しない。

### 改訂と進捗の履歴

現在値だけを上書きせず、単一の append-only event stream を追加する。

- `created`
- `migration_baseline`
- `contract_revised`
- `progress`
- `handoff`
- `state_transitioned`
- `result_reported`

Root WorkItem の現在値は一覧や再開時の高速な参照に使い、event stream は変更理由と経過の正本にする。契約改訂 event は goal、scope、completionCriteria、権限の変更前後を復元でき、progress と handoff は summary、blockers、next action、actor、記録日時を保持する。

全 mutation は同じ単調増加 resource revision 上で直列化する。current projection、event、idempotency response を同じ transaction で保存し、expected revision と idempotency key を要求する。

履歴取得は cursor と上限件数を持つ。payload size、blocker 件数、文字数を既存の runtime limit と同じ境界で制限する。

## 状態遷移

既存の state machine を共通利用する。

- 作成直後は `pending` とする。
- owner Session が `in_progress`、`waiting`、terminal state へ遷移できる。
- terminal result は terminal transition と同じ transaction で確定する。
- terminal state の Root WorkItem は再開しない。

Root WorkItem の terminal 後に同じ Session で別の目的を続ける仕様は、Root WorkItem の一意性と衝突する。初回実装では「Root WorkItem の terminal は Session の目的終了」を契約とし、継続作業は新しい root Session で開始する案を推奨する。既存 Session 内での継続が必須なら、successor relation を別途設計してから実装する。

## Session 作成との原子性

Root WorkItem は root Session と同じ database transaction で作成する。Session commit 後に別 service から追加する方式は採らない。

canonical owner は `SessionStorageV6` の root Session 永続化境界とし、root Session row、関連 record、Root WorkItem、必要な idempotency record を一括して commit する。次の入口を同じ helper へ収束させる。

- GUI からの root Session 作成
- root Session の import または置換
- schema repair 後の再構成

child Session の `session.create` と `character-authoring` Session は対象外とする。

transaction が失敗した場合は Session と Root WorkItem のどちらも残さない。再試行とアプリ再起動で Root WorkItem を重複生成しない。

## Migration と repair

WorkItem contract revision を `2` へ上げ、既存 row はすべて `delegated` として保持する。domain type は `kind` で判別可能な union とし、既存 delegated shape と authority を一括で緩和しない。

`creator_session_id <> target_session_id` の table constraint を種別別の constraint へ置き換えるため、SQLite table rebuild を行う。次を同じ migration で保存する。

- WorkItem row と resource revision
- terminal result
- execution association
- aggregation decision と aggregation idempotency
- WorkItem mutation idempotency
- Session delete protection

既存の `standalone` と `overall-coordinator` root Session には Root WorkItem を一つ backfill する。backfill は idempotent とし、既に正しい Root WorkItem がある場合は追加しない。不正な重複または binding 不整合を検出した場合は、任意の一件へ自動統合せず migration error とする。

既存 WorkItem に存在しない過去の event は生成しない。移行時点の現在値を `migration_baseline` event として一件記録し、履歴が移行後から完全であることを machine-readable に示す。

既存の parent-null delegated WorkItem は structural identity を変更せず、Root WorkItem と同じ rootSessionId 配下の legacy branch として保持する。自動 reparent は行わない。

既存 Session には十分な完了条件がないため、backfill 時に事実でない内容を生成しない。初期 goal は Session の task title を使い、scope、completionCriteria、権限説明は空を許容する root 専用の validation とする。owner が最初の改訂で具体化できるようにする。delegated WorkItem の必須条件は緩めない。

## Session 削除

Root WorkItem の自動作成後は、現行の Session delete protection をそのまま適用すると全 root Session が削除不能になる。

契約は次とする。

- active な Root WorkItem を持つ root Session の削除は拒否する。
- terminal な Root WorkItem を持つ root Session の明示削除は、Session と自己所有 Root WorkItem の履歴を同じ transaction で削除する。
- delegated WorkItem、未回収結果、child Session、execution association が残る場合は従来どおり拒否する。
- UI 上の非表示や archive と物理削除を混同しない。

Root WorkItem の履歴は Session の所有データであり、Session の明示的な物理削除後まで独立保存しない。

## 公開操作

既存操作を維持したうえで、少なくとも次を追加する。

- `work.revise`: Root WorkItem の変更可能な契約情報を改訂する。
- `work.history.append`: strict な `progress | handoff` union を append-only で記録する。
- `work.history.list`: 全 event を revision 順で取得する。

`work.transition` と `work.result` は Root WorkItem でも使えるよう、種別と actor authority を検証する。`work.create` で root 種別を作成することは許可せず、Root WorkItem の生成は Session 永続化境界だけに限定する。

次の公開面を同じ contract revision で更新する。

- TypeScript contract と runtime catalog
- application service と HTTP dispatch
- raw runtime client
- CLI
- MCP strict schema と tool definition
- managed Session skill の操作説明

未知 field、種別に不正な field、過大 payload、stale revision、idempotency key の別 payload 再利用は全入口で拒否する。

## 実行関連付けと再開

Root WorkItem を root Session の turn execution に関連付けられるようにする。既存の child communication 前提を Root WorkItem へ流用せず、自己所有 Root WorkItem に限る明示的な association rule を追加する。

別 Session で再開する consumer は、次の順に情報を取得できることを契約とする。

1. Root WorkItem の現在の契約と state
2. 最新の progress、blockers、next action
3. 必要な範囲の contract revision と progress history
4. child WorkItem、結果、execution association

provider 固有の repository artifact が存在しなくても、上記だけで次の行動を判断できることを受入条件にする。

## 実装順序

### 1. Domain contract

- WorkItem kind と contract revision 2 を追加する。
- root と delegated の validation、不変 field、actor authority を定義する。
- Root WorkItem の初期値と revision input、progress event、history output を定義する。
- 現行 delegated contract の互換性を型と validation で固定する。

### 2. Schema、migration、storage

- `work_items_v6` を種別別 constraint へ rebuild する。
- 単一の `work_item_events_v6`、index、payload limit を追加する。
- root Session 単位の Root WorkItem 一意制約を追加する。
- mutation op と idempotency schema を拡張する。
- 既存 WorkItem の移行と既存 root Session の backfill を実装する。
- schema verifier と repair を更新する。

### 3. Session 作成と削除

- root Session と Root WorkItem を同じ transaction で作成する helper を追加する。
- GUI 作成、replace/import、repair を helper へ収束させる。
- child と character-authoring が対象外であることを固定する。
- 確定した Session 削除契約を transaction と trigger へ反映する。

### 4. Service authority と mutation

- self-owned root の取得、改訂、progress append、状態遷移、結果報告を追加する。
- delegated WorkItem の既存 actor authority を維持する。
- arbitrary self-target create を拒否する。
- root execution association の明示ルールを追加する。

### 5. Public adapters

- application service、HTTP、client、CLI、MCP、runtime catalog を更新する。
- strict schema と error mapping を全入口で揃える。
- managed Session skill を更新する。

### 6. UI

- root Session の WorkItem 現在値、progress、blockers、next action を既存 right pane で表示する。
- owner Session から許可された field だけを改訂できるようにする。
- 履歴は progressive disclosure で表示し、常設説明で pane を埋めない。

## 直接検証

### Schema と storage integration

- root Session 作成で Root WorkItem がちょうど一つ同時作成される。
- child と `character-authoring` Session には作成されない。
- transaction failure で Session と Root WorkItem の片方だけが残らない。
- 再送、再起動、repair で重複しない。
- migration 後も既存 delegated WorkItem、結果、association、aggregation、idempotency が保持される。
- backfill は既存 root Session ごとに一件だけ追加し、二回実行しても変化しない。

### Service contract integration

- `standalone` と `overall-coordinator` は自分の Root WorkItem だけを改訂できる。
- child Session、別 root Session、delegated target は Root WorkItem 契約を改訂できない。
- immutable binding と canonical authority ceiling を変更できない。
- arbitrary self-target delegated WorkItem を作成できない。
- stale expected revision と idempotency conflict を区別して拒否する。
- contract revision、progress、handoff が一つの event stream から復元できる。
- terminal state を再開できない。

### Public boundary

- raw HTTP、CLI、MCP で新操作の成功と同じ error semantics を確認する。
- strict validator が unknown field、不正な kind 組み合わせ、過大 payload を拒否する。
- runtime catalog が contract revision と mutation 一覧を正しく公開する。
- history list の cursor、limit、visibility が root を越えて漏れない。

### Lifecycle

- root turn execution を自己所有 Root WorkItem に関連付けられる。
- 再起動後に現在値と履歴から同じ再開情報を取得できる。
- 確定した削除条件で active、terminal、delegated relation の各 case が部分削除を起こさない。

実装時は各 failure mode を最も直接観測する schema、storage、service integration test を優先する。公開 adapter は少なくとも raw HTTP と MCP strict schema を直接検証し、最後に typecheck、全 test、build を実行する。

public API、永続化、owner scope、複合不変条件を横断するため、実装差分は complete-diff の独立 review 対象とする。schema、authority、migration、削除契約の後戻り困難な判断は ADR に残し、通常の field 一覧や現行 class 構成は重複記載しない。

## 確定した判断

1. Root WorkItem の terminal は Session の目的終了を表す。別の目的を続ける場合は新しい root Session を作り、初回実装では successor relation を追加しない。
2. active な Root WorkItem、active descendant、未回収結果がある root Session は削除できない。条件を満たす terminal root Session の明示削除では、自己所有 Root WorkItem と履歴を同じ transaction で物理削除する。
3. authority は改訂可能な説明として保持するが、認可には使わない。実効権限は既存の Session role、communication policy、runtime capability だけから判定し、新しい capability model は導入しない。
4. 新規 Root WorkItem の goal は Session の task title から初期化する。scope、completionCriteria、authority は root 専用で空を許容し、owner が最初の契約改訂で具体化できるようにする。
5. Root WorkItem の terminal result は、全 descendant WorkItem が terminal で、nested aggregation decision が確定している場合だけ許可する。parent-null legacy delegated WorkItem には新しい decision を捏造せず、terminal result の存在を確認する。

## 完了条件

- root Session と Root WorkItem の一対一関係が schema と transaction で保証される。
- owner Session は許可された情報だけを revisioned、idempotent に更新できる。
- delegated WorkItem の不変な委任契約と既存 authority が維持される。
- WorkItem の現在値と append-only history だけで別 Session が作業を再開できる。
- migration、repair、削除、再起動で重複、孤児、部分更新を作らない。
- TypeScript、HTTP、CLI、MCP、runtime catalog の契約が一致する。
- 対象 failure mode の直接検証、typecheck、全 test、build が成功する。
