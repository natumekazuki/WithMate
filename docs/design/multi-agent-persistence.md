# Multi-Agent Persistence

- 作成日: 2026-07-11
- 対象: WithMate 新実装の Session / Message / Run 永続化基盤
- 状態: 設計の基準（基礎 3 table + Run output 2 table + Multi-Agent 3 table + Provider 相関 3 table + 冪等性 1 table + event 1 table + supplemental input 1 table 確定）
- 関連設計: `docs/design/session-run-message-contract.md`, `docs/design/multi-agent-orchestration.md`, `docs/design/provider-integration.md`

## 目的

Session / Message / Run の責務と不変条件を SQLite の table 契約へ落とし込み、通常 Run と Multi-Agent child Run が同じ永続化基盤を使えるようにする。

本書の現在の範囲は `sessions`、`messages`、`runs`、`run_output_items`、`run_output_payloads`、`session_relations`、`delegations`、`child_result_deliveries`、`provider_bindings`、`run_attempts`、`run_dispatches`、`idempotency_records`、`run_events`、`run_input_deliveries` の 14 table と、その直接制約とする。

## 旧 DB との境界

新実装は新しい DB file と現行設計の schema を初期状態として作成し、旧 DB の data migration は行わない。旧 DB schema を読む compatibility reader、import、変換 script、旧 schema からの migration test も実装しない。

旧 DB file は新実装から参照、変更、自動削除しない。`old/` と既存 user data は過去の失敗モードを確認する参考資料および手動 rollback / cleanup の対象としてのみ扱う。

この決定は旧 DB から新 DB への移行を対象とする。新実装の提供開始後に現行 schema を更新するための versioned migration は、別途必要に応じて設計する。

## 責務と参照関係

```text
sessions
├─ messages 1..N
├─ provider_bindings 0..N
└─ runs 0..N
   ├─ initiating_message_id -> messages.id
   ├─ final_assistant_message_id -> messages.id
   ├─ retry_of_run_id -------> runs.id
   ├─ run_attempts 0..N
   │  ├─ provider_binding_id -> provider_bindings.id
   │  └─ run_dispatches 1
   └─ run_output_items 0..N
     └─ run_output_payloads 0..1

session_relations
├─ parent_session_id -------> sessions.id
├─ child_session_id --------> sessions.id
├─ orchestration_root_session_id -> sessions.id
└─ delegations 1
   ├─ initial/latest_instruction_message_id -> messages.id
   ├─ latest_child_run_id ------------------> runs.id
   └─ child_result_deliveries 1..N
      ├─ child_run_id ----------------------> runs.id
      └─ first_collected_by_parent_run_id --> runs.id

idempotency_records
└─ response_ref_type / response_ref_id -> domain record

run_events
├─ run_id ------------------------------> runs.id
└─ subject_type / subject_id -----------> domain record

run_input_deliveries
├─ message_id --------------------------> messages.id
├─ run_id ------------------------------> runs.id
└─ run_attempt_id -----------------------> run_attempts.id
```

- `sessions` は会話の設定と lifecycle を持つ。実行状態と active / latest Run は `runs` から導出する。
- `provider_bindings` は Session と Provider 側会話の対応履歴だけを持つ。
- `messages` は user input と final assistant response の確定済み会話履歴を持つ。assistant detail、tool、command、raw output は持たない。commit 後の本文は更新しない。
- `runs` は実行 phase、terminal outcome、実行時設定の snapshot を持ち、Session の実行状態の正本となる。
- `run_attempts` は 1 Run 内で実際に行った Provider 実行試行と外部実行 ID を持つ。
- `run_dispatches` は Attempt の Provider request を未送信・送信中・受理済み・受理不能へ分類し、二重送信を防ぐ。
- `run_output_items` は assistant detail、tool / command / file operation、interaction、telemetry、diagnostic、Provider metadata の軽量な分類・順序・summary を持つ。
- `run_output_payloads` は 1 件の Run output の個別展開時だけ読む本文をSQLite BLOBとして持つ。
- `session_relations` は不変な親子構造と orchestration root を持つ。
- `delegations` は 1 件の依頼の継続状態と、最新 instruction / child Run への参照を持つ。
- `child_result_deliveries` は child Run ごとの結果可用性と初回回収記録を持つ。結果本文は複製しない。
- `idempotency_records` は write / wait / collect 操作の重複実行を防ぎ、同じ key へ同じ応答を返すための軽量な記録を持つ。
- `run_events` は Run 内で起きた事実の順序と関連レコードへの参照だけを持つ。現在状態や詳細本文の基準にはしない。
- `run_input_deliveries` は supplemental user Message を実行中 RunAttempt へ配送した状態だけを持つ。入力本文は複製しない。

## 共通の物理表現

| 概念 | SQLite 表現 | 規則 |
| --- | --- | --- |
| WithMate ID | `TEXT` | Application Service が発行する不透過 ID。Provider ID を使用しない |
| timestamp | `INTEGER` | UTC Unix epoch milliseconds |
| enum | `TEXT` + `CHECK` | 未知値を黙って受理しない |
| JSON | `TEXT` | UTF-8 JSON。Application Service の schema validation と `json_valid` の `CHECK` の両方を使う |
| boolean | `INTEGER` | `0` / `1` に限定する |

時刻は並び順や一意性の基準に使わない。Message / Run の順序は Session 内の `ordinal` を基準にする。

## `sessions`

1件の継続的な会話について、identity、lifecycle、workspace、既定設定を保持する。実行状態は`runs`から導出し、Session rowへprojection保存しない。通常Sessionとchild Sessionを型やcolumnで区別しない。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `id` | `TEXT` | no | WithMate Session ID |
| `provider_id` | `TEXT` | no | Session 作成時に固定する論理 Provider ID |
| `workspace_key` | `TEXT` | no | 検証済み workspace を参照する安定 key。絶対 path そのものは保存しない |
| `allowed_additional_directories_json` | `TEXT` | no | userが明示許可したworkspace外directoryのabsolute path配列 |
| `default_character_id` | `TEXT` | no | Session の既定 Character ID |
| `max_concurrent_child_runs` | `INTEGER` | no | この Session が orchestration root のときに配下全体へ適用する child Run 同時実行上限 |
| `lifecycle_status` | `TEXT` | no | `active` / `archived` / `closed` |
| `created_at` | `INTEGER` | no | 作成時刻 |
| `updated_at` | `INTEGER` | no | Session metadata を含む最終更新時刻 |
| `last_activity_at` | `INTEGER` | no | Home の recent order 用 projection。Message追加、Run受理、Run terminal確定の最大時刻 |

### 制約

- primary key は `id`。
- `allowed_additional_directories_json`は重複と包含関係を正規化したJSON arrayとする。WithMate管理のSession Files directoryは暗黙許可し、本fieldへ保存しない。
- `max_concurrent_child_runs` は 0 以上、Application Service の安全上限以下とする。`0` は Multi-Agent child Run の新規開始を無効化する。
- child Session の値は所属 tree の capacity 判定に使わない。すべての子孫は `session_relations.orchestration_root_session_id` が指す root Session の値を参照する。
- 設定値を下げた時点で予約数が新上限を超えていても、既存 child Run を強制停止しない。予約数が新上限未満になるまで新しい child Run admission を拒否する。値を上げた場合は次の admission から反映する。
- Session delete は対象Sessionをrootとするsubtree全体を明示的なPersistence actor transactionで物理削除する。通常の外部キー削除動作は`RESTRICT`を維持し、個別rowの暗黙cascade deleteに依存しない。
- `last_activity_at`は実行状態の正本ではない。初期値は`created_at`とし、Message追加、Run受理、Run terminal確定と同じtransactionで`max(current, event_at)`へ進める。retryやout-of-order eventで後退させず、metadataだけの変更では更新しない。

### index

- `INDEX sessions_lifecycle_activity_idx (lifecycle_status, last_activity_at DESC, id DESC)`
- `INDEX sessions_workspace_activity_idx (workspace_key, last_activity_at DESC, id DESC)`

Session一覧は`(last_activity_at, id)`のkeyset cursorでpaginateし、1回のqueryでSession headerと、各Sessionのordinal最大Runをwindow functionまたは同等のset queryで結合して`executionState` / `activeRunId` / `latestRunId` / `lastActivityAt`を返す。SessionごとのN+1 query、全Session hydrate、`run_output_payloads` joinは禁止する。

## `provider_bindings`

WithMate Session と Provider 側会話の対応履歴を保持する。Binding は外部会話への参照であり、Provider process、protocol、capability、model、Run outcome は持たない。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `id` | `TEXT` | no | WithMate ProviderBinding ID |
| `session_id` | `TEXT` | no | 対応する WithMate Session |
| `ordinal` | `INTEGER` | no | Session 内の Binding 履歴順 |
| `provider_id` | `TEXT` | no | 外部会話 ID の名前空間となる論理 Provider ID |
| `external_conversation_id` | `TEXT` | yes | Codex Thread ID または ACP Session ID。`creating` intentでは未確定のためnull |
| `persistence_mode` | `TEXT` | no | `persistent` / `ephemeral` |
| `binding_state` | `TEXT` | no | `creating` / `active` / `invalidated` / `superseded` |
| `created_by_run_attempt_id` | `TEXT` | no | 外部会話を作成または最初に相関した RunAttempt |
| `superseded_by_binding_id` | `TEXT` | yes | 後継 Binding |
| `invalidated_at` | `INTEGER` | yes | 利用不能または置換を確定した時刻 |
| `invalidation_reason` | `TEXT` | yes | bounded な失効理由 code |
| `created_at` | `INTEGER` | no | 作成時刻 |

### 制約と index

- primary key は `id`。`session_id` は `sessions(id)` を `RESTRICT` で参照する。
- `UNIQUE (session_id, ordinal)` とし、`ordinal >= 1` とする。時刻から履歴順を推測しない。
- `provider_id` は対応 Session の `provider_id` と一致させる。外部会話 ID がnon-nullの場合は `UNIQUE (provider_id, external_conversation_id)` とし、別 Session へ同じ外部会話を関連付けない。
- `UNIQUE INDEX provider_bindings_one_open_per_session_uq ON provider_bindings(session_id) WHERE binding_state IN ('creating', 'active')` により、1 Session の作成中またはactiveなBindingを合計最大1件にする。
- `creating`では`external_conversation_id`、`superseded_by_binding_id`、`invalidated_at`、`invalidation_reason`をすべてnullとする。`thread/start`を送る前にこのrowをdurable commitする。
- `active` では `superseded_by_binding_id`、`invalidated_at`、`invalidation_reason` をすべて null とする。
- `active` / `superseded`では`external_conversation_id`を必須とする。`invalidated`では`invalidated_at`と`invalidation_reason`を必須とし、後継Bindingは持たない。`thread/start`の受理不明から失効したBindingだけ外部会話IDがnullのまま残ることを許可する。
- `superseded` では `superseded_by_binding_id`、`invalidated_at`、`invalidation_reason` を必須とする。後継は同じ Session の、より大きい ordinal を持つ Binding に限定する。
- `created_by_run_attempt_id` は同じSessionに属するRunのAttemptを参照する。admissionでは`provider_binding_id=null`のAttemptを先に追加し、そのAttemptを参照する`creating` Bindingを同じtransactionで追加する。
- 外部会話ID確定時は、BindingへのID設定と`active`化、作成元Attemptの`provider_binding_id`設定を1つのtransactionで行い、Application Service / Persistence actorが両者のSession所属一致をcommit前に検証する。SQLiteの単純なFKだけでこのcross-table所属条件を表現したとはみなさない。
- Binding は最初のRunまで作成を遅延できる。最初のRun admissionでAttemptと`creating` Binding intentを同じtransactionに保存し、commit後だけ外部会話作成を開始する。ephemeral Bindingも診断用の外部相関として保存するが、process再起動後のresumeには使わない。
- 外部会話を作り直す場合は古い row を上書きせず、旧 Binding の `superseded` 化と新 Binding の追加を 1 transaction で確定する。
- `INDEX provider_bindings_session_ordinal_idx (session_id, ordinal)`
- `INDEX provider_bindings_state_idx (binding_state, invalidated_at)`

## `messages`

Session 内の user-visible な確定済み会話履歴を保持する。`role=assistant` は 1 Run の final assistant response だけとする。system / developer / Character prompt、assistant detail、tool / command / file operation、RunEvent、approval、error notice、streaming draft は保存しない。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `id` | `TEXT` | no | WithMate Message ID |
| `session_id` | `TEXT` | no | 所属 Session |
| `ordinal` | `INTEGER` | no | Session 内の単調増加順序 |
| `role` | `TEXT` | no | `user` / `assistant` |
| `content_blocks_json` | `TEXT` | no | version 付き content block 配列 |
| `created_at` | `INTEGER` | no | 作成時刻 |

### 制約

- primary key は `id`。
- `session_id` は `sessions(id)` を参照し、削除動作は `RESTRICT` とする。
- `UNIQUE (session_id, ordinal)` とし、`ordinal >= 1` とする。削除や失敗で生じた欠番は許容するが、一度使った ordinal を再利用しない。
- `UNIQUE (id, session_id)` を用意し、Run の複合外部キーが所属 Session も検証できるようにする。
- `content_blocks_json`はversion付きJSON arrayであり、初期版は`{ "type": "text", "text": string }`だけを保存する。file / folder / image参照は専用attachment blockやcontent snapshotにせず、text内の`@path`として保持する。
- `content_blocks_json`はUTF-8で4 MiB以下とする。user inputはRun admission前に拒否し、Provider final responseの超過は切り詰めたりRunOutputへ移したりせず、実行outcomeとlive persistence failureを分離して通知する。
- `role='assistant'` の `content_blocks_json` に assistant detail、tool call、command output、raw Provider item を含めない。これらは後続の RunOutputItem table へ保存する。
- Message row は append-only とする。DB の `UPDATE` 権限で表現するのではなく、Persistence actor の command surface から Message 本文更新を除外する。

### index

- `UNIQUE INDEX messages_session_ordinal_uq (session_id, ordinal)`
- `INDEX messages_session_created_idx (session_id, created_at)`

timeline 取得は `session_id` と ordinal cursor を使い、offset pagination を使わない。

### path referenceとSession Files

- `File` / `Folder` / `Image` pickerは選択pathをcomposerへ`@path`として挿入する。Messageはuserが確定したtextだけを正本とし、file内容、hash、MIME、size、snapshot、解決済みabsolute path metadataを別保存しない。
- Run admission前にMain processが`@path`を解決し、存在、file / directory種別、realpathを検証する。参照可能範囲はworkspace、`allowed_additional_directories_json`、`session-files/{sessionId}/`のいずれかのrealpath配下に限定し、symlink / junction経由の範囲外参照を拒否する。
- workspace内のpicker結果はworkspace相対表現を優先する。workspace外pathはuserが明示許可したdirectory配下だけ受理し、Message textに含まれるabsolute pathはuser-authored contentとして保持できる。audit、diagnostic、error summaryへraw absolute pathを重複保存しない。
- 通常のpath referenceはRun実行時のfile内容をProviderへ渡し、履歴用snapshotを作らない。同じMessageのretryもその時点でpathを再解決するため、元fileの変更・移動・削除により別内容またはvalidation errorになり得る。
- `Attach Copy`とclipboard pasteだけ、Main processがWithMate管理の`session-files/{sessionId}/`へ排他的なfile名でcopy / writeし、その保存pathを`@path`として挿入する。copy / pasteはSession存在、lifecycle、IPC callerのWindowとSessionの対応、個数・byte上限を検証する。
- folderはmanifestやsnapshotへ展開せずlive directory referenceとしてProviderへ渡す。Provider送信直前にもrealpathと許可範囲を再検証する。
- Provider Adapterは確定Message textと解決済みpath referenceを実行時入力へ変換する。Copilotはfile / directory attachment、Codexは対応するimage path / additional directory等へ変換し、Provider固有形式をMessageへ保存しない。
- Session subtree deleteは対象SessionごとのSession Files directoryも削除する。DB commit後の冪等削除と起動時orphan sweepを使用し、filesystem削除失敗を理由にDB rowを復元しない。

完了後の通常 hydrate は `messages` だけを読み、RunOutputItem を join しない。Run 詳細を開く場合は `runs` の header と、`run_output_items` を category ごとに集計した件数を取得する。assistant detail、operation summary、個別 payload はユーザーが対応する表示を展開したときだけ別 query で取得する。

## `runs`

1 件の initiating user Message を起点とする論理実行を保持する。Provider 固有の Thread / Turn / request ID はこの table の identity に使わず、後続の ProviderBinding / dispatch / attempt table で相関する。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `id` | `TEXT` | no | WithMate Run ID |
| `session_id` | `TEXT` | no | 所属 Session |
| `ordinal` | `INTEGER` | no | Session 内の Run 受理順 |
| `initiating_message_id` | `TEXT` | no | 起点となる user Message |
| `final_assistant_message_id` | `TEXT` | yes | 正常完了時の確定 assistant Message |
| `retry_of_run_id` | `TEXT` | yes | exact retry 元の Run |
| `phase` | `TEXT` | no | `queued` / `starting` / `active` / `canceling` / `finalizing` / `completed` / `failed` / `canceled` / `interrupted` |
| `execution_snapshot_json` | `TEXT` | no | Provider、model、reasoning、approval、sandbox、workspace、Character の不変 snapshot |
| `failure_origin` | `TEXT` | yes | `provider` / `transport` / `process` / `application` / `persistence` / `unknown` |
| `provider_error_code` | `TEXT` | yes | secret を含まない bounded error code |
| `error_summary` | `TEXT` | yes | redacted / bounded な診断 summary |
| `cancel_requested_at` | `INTEGER` | yes | cancel 受理時刻 |
| `cancel_acknowledged_at` | `INTEGER` | yes | Provider 側停止確認時刻 |
| `terminal_event_received_at` | `INTEGER` | yes | terminal event 受信時刻 |
| `external_side_effect_state` | `TEXT` | no | `none` / `present` / `unknown` |
| `created_at` | `INTEGER` | no | admission 受理時刻 |
| `started_at` | `INTEGER` | yes | Provider 実行開始を確定した時刻 |
| `terminal_at` | `INTEGER` | yes | terminal phase 確定時刻 |
| `updated_at` | `INTEGER` | no | 最終更新時刻 |
| `version` | `INTEGER` | no | 更新ごとに 1 増加する楽観的競合検出 version |

### 制約

- primary key は `id`。
- `UNIQUE (session_id, ordinal)` とし、`ordinal >= 1` とする。
- `UNIQUE (id, session_id)`を用意し、retry RunとSessionRelationの複合外部キーがSQLiteの親キーとして成立するようにする。
- `session_id` は `sessions(id)` を `RESTRICT` で参照する。
- `(initiating_message_id, session_id)` と `(final_assistant_message_id, session_id)` は `messages(id, session_id)` を `RESTRICT` で参照し、別 Session の Message を関連付けられないようにする。
- `(retry_of_run_id, session_id)` は `runs(id, session_id)` を `RESTRICT` で参照し、retry 元を同じ Session に限定する。
- `initiating_message_id` は `role='user'`、`final_assistant_message_id` は `role='assistant'` であることを admission / terminal transaction 内で検証する。SQLite の単純な外部キーで role まで表現できないため、Persistence actor の不変条件とする。
- `retry_of_run_id IS NOT NULL` の場合、retry 元と `initiating_message_id` が一致することを受理時に検証する。本文を変更した再実行は retry ではなく、新しい Message と Run とする。
- terminal phase は `completed` / `failed` / `canceled` / `interrupted`。terminal phase と `terminal_at IS NOT NULL` は必ず同時に成立する。
- `final_assistant_message_id` を持てるのは `phase='completed'` だけとする。`completed` でも user-visible な最終本文が空な場合は null を許容する。
- `failure_origin` / `provider_error_code` / `error_summary` は成功の判定に使わない。少なくとも `failed` / `interrupted` では `failure_origin` を必須とする。
- `version >= 0` とする。
- terminal phase の Run を non-terminal phase へ戻す更新は Persistence actor が拒否する。

### 並行実行制約と index

- `UNIQUE INDEX runs_one_non_terminal_per_session_uq ON runs(session_id) WHERE phase IN ('queued', 'starting', 'active', 'canceling', 'finalizing')`
- `UNIQUE INDEX runs_session_ordinal_uq (session_id, ordinal)`
- `UNIQUE INDEX runs_id_session_uq (id, session_id)`
- `INDEX runs_session_phase_updated_idx (session_id, phase, updated_at DESC)`
- `INDEX runs_initiating_message_idx (initiating_message_id)`
- `INDEX runs_retry_of_idx (retry_of_run_id) WHERE retry_of_run_id IS NOT NULL`

部分 unique index は「1 Session に non-terminal Run は最大 1 件」を DB で最終防衛し、active Run の導出にも使用する。

## `run_attempts`

1 件の論理 Run 内で、Provider へ実際に処理を依頼した試行を保持する。process への再接続や同じ外部実行の状態照会は新しい Attempt にせず、別の Provider 実行を開始する場合だけ追加する。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `id` | `TEXT` | no | WithMate RunAttempt ID |
| `run_id` | `TEXT` | no | 所属する論理 Run |
| `ordinal` | `INTEGER` | no | Run 内の試行順 |
| `provider_binding_id` | `TEXT` | yes | この試行で使用する ProviderBinding |
| `attempt_reason` | `TEXT` | no | `initial` / `stale_binding_recovery` |
| `attempt_state` | `TEXT` | no | `preparing` / `active` / `succeeded` / `failed` / `interrupted` |
| `external_execution_id` | `TEXT` | yes | Codex Turn ID など Provider 側の実行 ID |
| `failure_origin` | `TEXT` | yes | `provider` / `transport` / `process` / `application` / `unknown` |
| `provider_error_code` | `TEXT` | yes | secret を含まない bounded error code |
| `error_summary` | `TEXT` | yes | redacted / bounded な診断 summary |
| `created_at` | `INTEGER` | no | Attempt 作成時刻 |
| `started_at` | `INTEGER` | yes | Provider 実行開始を確定した時刻 |
| `terminal_at` | `INTEGER` | yes | Attempt 終了時刻 |

### 制約と index

- primary key は `id`。`run_id` は `runs(id)`、`provider_binding_id` は `provider_bindings(id)` を `RESTRICT` で参照する。
- `UNIQUE (run_id, ordinal)` とし、`ordinal >= 1` とする。`ordinal=1` は `attempt_reason='initial'`、2 以降だけ `stale_binding_recovery` を許可する。
- `provider_binding_id` は Binding 確定前の `preparing` と、その準備中に終わった `failed` / `interrupted` では null を許可する。`active` / `succeeded` では同じ Session に属する Binding を必須とする。
- `external_execution_id` は Provider が実行開始を受理した後だけ設定する。設定済みの場合は `UNIQUE (provider_binding_id, external_execution_id)` とする。
- non-terminal state は `preparing` / `active`、terminal state は `succeeded` / `failed` / `interrupted` とする。terminal state と `terminal_at IS NOT NULL` は同時に成立する。
- `active` / `succeeded` では `started_at` と `external_execution_id` を必須とする。`preparing` で失敗した Attempt は `started_at` と外部実行 ID を持たずに `failed` / `interrupted` へ進める。
- `failed` / `interrupted` では `failure_origin` を必須とする。`succeeded` では failure fields を持たない。
- `UNIQUE INDEX run_attempts_one_non_terminal_per_run_uq ON run_attempts(run_id) WHERE attempt_state IN ('preparing', 'active')`
- `UNIQUE INDEX run_attempts_one_succeeded_per_run_uq ON run_attempts(run_id) WHERE attempt_state='succeeded'`
- stale Binding recovery は、先行 Attempt に meaningful partial output、確定した外部副作用、受理不明の dispatch がない場合だけ許可する。一般的な失敗の自動再試行には使わない。
- Attempt が `succeeded` なら Run は同じ domain transition で `completed` へ進める。内部 Attempt が失敗後に別 Attempt で成功した場合も、先行 Attempt の診断は残す。
- CLI version、protocol version、capability、model、reasoning、approval、sandbox、Character は本 table に保存しない。実行設定は Run snapshot、接続環境の診断は Provider runtime / RunEvent の責務とする。
- `INDEX run_attempts_run_ordinal_idx (run_id, ordinal)`
- `INDEX run_attempts_binding_external_idx (provider_binding_id, external_execution_id)`

## `run_dispatches`

1 件の RunAttempt に対する Provider 実行 request の送信 intent と受理結果を保持する。request 本文、Provider 外部実行 ID、Attempt の失敗診断は持たない。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `run_attempt_id` | `TEXT` | no | 対応する RunAttempt |
| `dispatch_state` | `TEXT` | no | `pending` / `dispatching` / `accepted` / `rejected` / `ambiguous` / `aborted` |
| `request_fingerprint` | `TEXT` | no | Provider request の正規化済み内容に対する SHA-256 |
| `provider_idempotency_key` | `TEXT` | yes | Provider が native idempotency を提供する場合の不透過 key |
| `created_at` | `INTEGER` | no | admission transaction で作成した時刻 |
| `dispatching_at` | `INTEGER` | yes | 送信 intent を durable commit した時刻 |
| `resolved_at` | `INTEGER` | yes | 受理結果を確定した時刻 |

### 制約と index

- primary key は `run_attempt_id`。`run_attempts(id)` を `RESTRICT` で参照し、1 Attempt に Provider 実行 request を 1 件だけ許可する。
- `request_fingerprint` は lowercase 64 hex 文字とする。request JSON やprompt本文は保存せず、同じ Attempt の不一致検出だけに使う。
- `pending`では`dispatching_at` / `resolved_at`を持たない。未送信を証明する必要条件だが、自動送信にはRun non-terminal、Attempt `preparing`、Binding `active`も必要とする。
- `dispatching` では `dispatching_at` を必須とし、`resolved_at` は持たない。送信 intent の commit 後に Provider request を送る。
- `accepted` / `rejected` / `ambiguous` では `dispatching_at` / `resolved_at` を必須とする。`aborted`ではProvider実行requestを送っていないため`dispatching_at`をnull、`resolved_at`を必須とする。これらは terminal state であり、別 state へ戻さない。
- `accepted` は対応 Attempt の `external_execution_id` を相関できた場合だけ確定する。外部実行 ID 自体は RunAttempt に保存する。
- `rejected` は Provider が未受理を明示した場合だけ使う。timeout、transport 切断、process crash で受理有無を証明できない場合は `ambiguous` とする。
- `ambiguous` は自動再送しない。Provider native idempotency または状態照会で既存外部実行へ一意に収束できる場合だけ、同じ Attempt の外部相関を補正する。
- `provider_idempotency_key` は Provider が対応する場合だけ設定する。secret、account情報、認証情報を含めない。
- Provider process 内だけで有効な JSON-RPC request ID は保存しない。再起動後の二重実行防止に使えない一時相関は live Adapter が保持する。
- `INDEX run_dispatches_state_created_idx (dispatch_state, created_at)`

## `idempotency_records`

Application Serviceのwriteと単一Deliveryのcollect操作に対して、同じidempotency keyの重複実行を防ぎ、確定済み応答を再構築するための軽量な記録を保持する。複数Deliveryを待つ`waitAny` / `waitAll`はread-onlyで本tableを使用しない。keyはCLI / GUIがアプリ全体で一意なUUIDとして生成する。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `idempotency_key` | `TEXT` | no | 全 operation 共通で一意な不透過 key |
| `scope_session_id` | `TEXT` | no | operationの冪等性を所有するSession。`child.start`はcallerであるparent Session、`child.collect`は結果を所有するchild Session、それ以外はmutation対象Session |
| `operation` | `TEXT` | no | `run.start` / `child.collect` / `run.cancel` などの bounded operation code |
| `request_fingerprint` | `TEXT` | no | key を除く正規化済み request の SHA-256 |
| `record_state` | `TEXT` | no | `in_progress` / `completed` / `expired` |
| `response_kind` | `TEXT` | yes | `success` / `error` |
| `response_ref_type` | `TEXT` | yes | `run` / `session` / `delivery` / `interaction` / `none` |
| `response_ref_id` | `TEXT` | yes | 応答を再構築する domain record ID |
| `response_envelope_json` | `TEXT` | yes | ID、状態、error code などの bounded / redacted metadata |
| `created_at` | `INTEGER` | no | key を受理した時刻 |
| `completed_at` | `INTEGER` | yes | 応答を確定した時刻 |
| `expires_at` | `INTEGER` | yes | completed record の保持期限 |

### 制約と index

- primary key は `idempotency_key`。canonical lowercase UUID とし、別 operation や別 Session でも再利用しない。
- `scope_session_id` は`sessions(id)`を`RESTRICT`で参照する。Sessionに関係する`in_progress`、error、参照不要応答も削除対象へ確実に含めるため、response refだけで所属を推測しない。
- operationごとのscope ownerは固定し、response refの所属から後付けで選ばない。特に`child.start`のrecordはparent Sessionへscopeし、terminal child subtreeを削除してもparent Sessionが残る限りkey tombstoneを保持する。child側response refを削除する場合はrecordを`expired`へ進め、同じkeyの再送を新規child作成へ変換しない。
- `operation` は 1 から 64 文字、`request_fingerprint` は lowercase 64 hex 文字とする。request JSON、prompt、secret は保存しない。
- `in_progress` では response fields、`completed_at`、`expires_at` をすべて null とする。
- `completed` では `response_kind`、`response_ref_type`、`response_envelope_json`、`completed_at`、`expires_at` を必須とする。参照不要な応答だけ `response_ref_type='none'` / `response_ref_id=null` を許可し、それ以外では ref ID を必須とする。
- `expired`ではresponse fieldsと`response_ref_id`をすべてnullへ消去し、`completed_at` / `expires_at`は保持する。key、scope、operation、fingerprintはSession削除までtombstoneとして残す。
- `response_envelope_json` は JSON object とし、16 KiB 以下に制限する。Message本文、child結果本文、Run output payload、raw Provider response を含めない。
- `response_ref_type` は polymorphic な軽量参照であり、SQLite の単一外部キーでは表現しない。operation完了 transaction と再送時に Application Service が種別、所属、authorizationを検証する。
- 同じkeyと同じoperation / fingerprintの再送は、`completed`なら参照先とenvelopeから同じ意味の応答を再構築し、`in_progress`なら処理中、`expired`なら`idempotency_expired`を返す。operationまたはfingerprintが違う場合はrecord stateにかかわらず`idempotency_conflict`とする。
- domain mutationを伴う短い操作は、domain recordとcompleted IdempotencyRecordを同じtransactionで確定する。Provider回答待ちなどtransaction外の外部処理を伴うwriteは先に`in_progress`をcommitし、外部結果を確定後に参照先とcompleted状態を別transactionで保存できる。read-onlyなwait操作はIdempotencyRecordを作らない。
- crash後の`in_progress`は成功扱いにしない。operation固有の参照先と外部副作用を照合し、安全に収束できる場合だけ再評価する。mutationの結果を証明できない場合は診断対象とする。
- completed recordの保持中は応答再構築に必要な参照先を削除しない。`expires_at`到達時は同じtransactionで`expired`へ進め、response参照とenvelopeを消去する。expired rowは通常retentionで削除せず、scope Sessionの明示削除時だけ関連dataとして削除する。これによりSession存続中は期限切れkeyを新しい操作へ再利用できない。
- `INDEX idempotency_records_state_created_idx (record_state, created_at)`
- `INDEX idempotency_records_expires_idx (expires_at) WHERE record_state='completed'`
- `INDEX idempotency_records_scope_session_idx (scope_session_id, created_at)`

## `run_events`

Run 内で起きた事実を、再起動後も cursor で追跡できる軽量な履歴として保持する。現在状態、出力本文、Provider の生 payload は保存せず、詳細が専用 table に存在する場合はその record を参照する。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `id` | `TEXT` | no | WithMate RunEvent ID |
| `run_id` | `TEXT` | no | 所属 Run |
| `ordinal` | `INTEGER` | no | Run 内の単調増加順序 |
| `event_code` | `TEXT` | no | 起きた事実を表す Provider 非依存 code |
| `subject_type` | `TEXT` | yes | 関連する domain record の種別 |
| `subject_id` | `TEXT` | yes | 関連する domain record ID |
| `dedupe_key` | `TEXT` | yes | Provider event ID または決定的 fingerprint を正規化した重複防止 key |
| `summary` | `TEXT` | yes | warning / error など参照先を持たない事実の bounded / redacted 補足 |
| `created_at` | `INTEGER` | no | WithMate が event を記録した時刻 |

### 制約と index

- primary key は `id`。`run_id` は `runs(id)` を `RESTRICT` で参照する。
- `UNIQUE (run_id, ordinal)` とし、`ordinal >= 1` とする。欠番は許容するが、一度使った ordinal を再利用しない。event の順序は `created_at` ではなく `ordinal` を基準にする。
- `event_code` は 1 から 64 文字の定義済み code に限定する。状態遷移は `run.phase.active`、`run.phase.terminal` のように到達した事実を code で表し、任意 JSON に旧値・新値を埋め込まない。
- `subject_type` と `subject_id` は両方 null、または両方 non-null とする。Application Service は event 作成時に種別、所属、参照先の存在を検証する。
- `dedupe_key` が non-null の場合は `UNIQUE (run_id, dedupe_key)` とし、同じ Provider event の再受信で row を増やさない。外部 event ID がない場合だけ、adapter が安定して再現できる決定的 fingerprint を使用する。
- `summary` は 0 から 1024 文字の bounded / redacted text とする。出力本文、tool result、stdout / stderr、raw Provider payload、絶対 path、secret の保存先にしない。
- RunEvent は append-only とする。Run、Attempt、Dispatch、OutputItem、Interaction、Delivery などの現在状態と詳細は各専用 table を基準とし、RunEvent から状態を再構成して上書きしない。
- streaming delta ごとに row を作らない。live draft は live state または後続の assistant draft 契約で扱い、論理 output の確定時だけ参照 event を追加できる。
- Provider 時刻、severity、version、`updated_at`、任意 payload JSON は保存しない。warning / error の区別は `event_code` で表す。
- `UNIQUE INDEX run_events_run_ordinal_uq (run_id, ordinal)`
- `UNIQUE INDEX run_events_run_dedupe_uq (run_id, dedupe_key) WHERE dedupe_key IS NOT NULL`
- `INDEX run_events_run_code_ordinal_idx (run_id, event_code, ordinal)`

CLI / UI の follow は `(run_id, ordinal > cursor)` の keyset pagination で取得する。`subject_type` / `subject_id` が指す詳細は一覧 query で join せず、必要な event を開いたときだけ専用 query で取得する。

## `run_input_deliveries`

確定済み supplemental user Message を、同じ Session で実行中の RunAttempt へ配送した状態を保持する。UI / CLI からの追加指示と親 Agent から child Agent への追加指示は、どちらも対象 Session の user Message に正規化してから本 table で配送する。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `message_id` | `TEXT` | no | 配送する supplemental user Message。primary key |
| `run_id` | `TEXT` | no | 追加指示を受ける active Run |
| `run_attempt_id` | `TEXT` | no | 実際に steer する active RunAttempt |
| `delivery_state` | `TEXT` | no | `pending` / `dispatching` / `accepted` / `rejected` / `ambiguous` |
| `resolution_code` | `TEXT` | yes | 拒否または受理不明となった bounded な理由 code |
| `created_at` | `INTEGER` | no | Message と Delivery を受理した時刻 |
| `dispatching_at` | `INTEGER` | yes | Provider 呼び出し直前の durable intent 確定時刻 |
| `resolved_at` | `INTEGER` | yes | terminal delivery state の確定時刻 |

### 制約と index

- primary key は `message_id`。`message_id` は `messages(id)`、`run_id` は `runs(id)`、`run_attempt_id` は `run_attempts(id)` を `RESTRICT` で参照する。
- Message は `role='user'` であり、対象 Run と同じ Session に属することを受理 transaction 内で検証する。1 Message から複数 Delivery を作らない。
- RunAttempt は対象 Run に属し、Delivery 受理時点で Run と Attempt の両方が active であることを検証する。配送作成後に別 Attempt へ切り替わっても対象を書き換えない。
- Codex App Server では `run_attempts.external_execution_id` を `turn/steer.expectedTurnId` として使う。外部 Turn ID を本 table へ重複保存しない。
- `pending` では `dispatching_at`、`resolved_at`、`resolution_code` をすべて null とする。
- `dispatching` では `dispatching_at` を必須、`resolved_at` と `resolution_code` を null とする。
- `accepted` では `dispatching_at` と `resolved_at` を必須、`resolution_code` を null とする。
- `rejected` / `ambiguous` では `dispatching_at`、`resolved_at`、`resolution_code` を必須とする。
- terminal delivery state は `accepted` / `rejected` / `ambiguous` とし、別 state へ戻さない。競合は state を条件にした update で検出し、version column は持たない。
- `resolution_code` は 1 から 64 文字の定義済み code に限定する。Provider の生 error、response payload、本文、絶対 path、secret は保存しない。
- `INDEX run_input_deliveries_run_state_idx (run_id, delivery_state, created_at)`
- `INDEX run_input_deliveries_attempt_state_idx (run_attempt_id, delivery_state)`

### 配送と復旧

1. Session、Run、Attempt、Provider capability を検証し、supplemental user Message と `pending` Delivery を同じ transaction で durable commit する。事前検証で拒否した入力はどちらも作成しない。
2. Provider 呼び出し直前に、`pending -> dispatching` と `dispatching_at` を durable commit する。commit 後だけ Provider へ送る。
3. Provider が受理を明示した場合は `accepted`、未受理を明示した場合は `rejected`、timeoutや切断で受理有無を証明できない場合は `ambiguous` へ進める。
4. crash 復旧で自動送信できるのは `pending` だけとする。`dispatching` は Provider 側の受理を証明できなければ `ambiguous` へ収束させ、`accepted` / `rejected` / `ambiguous` は自動再送しない。
5. 明示的な再送は新しい supplemental user Message と新しい Delivery を作る。同じ idempotency key の API / CLI 再送だけは、既存 `idempotency_records` から元の Delivery outcome を返す。
6. `rejected` / `ambiguous` Message を後続 Run の initiating Message へ暗黙に転用しない。新しい Run に渡す場合は明示操作で新しい Message と Run admission を作る。

入力本文、`expectedTurnId`、Provider の一時 request ID、request fingerprint、idempotency key、Provider response JSON、CLI / protocol version、retry count、`updated_at`、version は本 table に保存しない。本文は Message、API / CLI の重複防止は IdempotencyRecord、時系列と詳細診断は RunEvent / RunOutputItem を参照する。

## `run_output_items`

Run の途中出力と実行詳細に対する軽量 index を保持する。Session の通常 hydrate では読まず、ユーザーが Run 詳細の対象 category を展開した場合だけ summary 一覧を取得する。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `id` | `TEXT` | no | WithMate Run output ID |
| `run_id` | `TEXT` | no | 所属 Run |
| `ordinal` | `INTEGER` | no | Run output 内の単調増加順序 |
| `category` | `TEXT` | no | `assistant_detail` / `operation` / `interaction` / `telemetry` / `diagnostic` / `provider_metadata` |
| `kind` | `TEXT` | no | category 内の Provider 非依存な細分類 |
| `provider_item_id` | `TEXT` | yes | Provider item との外部相関 ID |
| `summary` | `TEXT` | no | 折りたたみ header / summary 一覧用の bounded text |
| `completion_state` | `TEXT` | no | `complete` / `partial` |
| `payload_state` | `TEXT` | no | `none` / `pending` / `stored` / `omitted_size_limit` / `omitted_redaction` / `omitted_persistence` |
| `payload_original_byte_length` | `INTEGER` | yes | payloadが存在する場合の元byte数 |
| `redaction_state` | `TEXT` | no | `not_required` / `redacted` / `unknown` |
| `created_at` | `INTEGER` | no | output を確定した時刻 |

### 制約

- primary key は `id`。
- `run_id` は `runs(id)` を `RESTRICT` で参照する。
- `UNIQUE (run_id, ordinal)` とし、`ordinal >= 1` とする。欠番は許容するが ordinal は再利用しない。
- `provider_item_id` が non-null の場合は `UNIQUE (run_id, provider_item_id)` とし、同じ Provider item の重複保存を防ぐ。
- `kind` は 1 から 64 文字、`summary` はUTF-8で0から4 KiBに制限する。summaryを詳細payloadの逃げ道にしない。
- `payload_state='none'`では`payload_original_byte_length`をnull、`redaction_state='not_required'`とし、payload rowを持たない。`pending`では元byte数と`redaction_state IN ('not_required', 'redacted')`を必須とし、terminal outcomeをdetail BLOBより先にcommitする間だけpayload rowを持たない。`stored`では元byte数を必須とし、`redaction_state IN ('not_required', 'redacted')`の場合だけ同じtransactionのcommit時点で対応するpayload rowを1件持つ。`omitted_size_limit` / `omitted_persistence`では元byte数と安全性確認済みのbounded summaryだけを残し、payload rowを持たない。`omitted_redaction`では元byte数と`redaction_state='unknown'`を必須とし、payload rowを持たない。
- `redaction_state='unknown'`と`payload_state='stored'`の組合せはDB CHECKとPersistence actorの両方で拒否する。sanitizerが失敗または判定不能ならpayloadを保存せず`omitted_redaction`とし、summaryもraw payloadから切り出さない固定のbounded診断だけにする。
- RunOutputItem は Provider item または WithMate の論理 output 単位で確定する。streaming chunk ごとに row を作らない。
- terminal 前の live draft は本 table に snapshot update せず、live state または後続の assistant draft 保存契約で扱う。失敗・cancel・中断時に保存する確定済み途中出力は `completion_state='partial'` とする。

### index

- `UNIQUE INDEX run_output_items_run_ordinal_uq (run_id, ordinal)`
- `UNIQUE INDEX run_output_items_provider_item_uq (run_id, provider_item_id) WHERE provider_item_id IS NOT NULL`
- `INDEX run_output_items_run_category_ordinal_idx (run_id, category, ordinal)`

category 展開は `(run_id, category, ordinal > cursor)` の keyset pagination で取得する。この query は `run_output_payloads` を join しない。

## `run_output_payloads`

Run output 1 件の本文をSQLite内に保持する1対0..1のdetail table。ユーザーが個別outputを展開した場合だけprimary keyで1件取得する。RunOutput用のfilesystem / object storageは使用しない。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `output_item_id` | `TEXT` | no | 対応する Run output ID。primary key |
| `payload_format` | `TEXT` | no | `text` / `json` / `binary` |
| `media_type` | `TEXT` | yes | MIME type または同等の bounded media type |
| `content` | `BLOB` | no | text / JSONのUTF-8 bytesまたはbinary実体 |
| `byte_length` | `INTEGER` | no | UTF-8 または binary 実体の byte 数 |
| `content_sha256` | `TEXT` | no | payload 実体の SHA-256 |
| `created_at` | `INTEGER` | no | 作成時刻 |

### 制約

- primary key は `output_item_id`。`run_output_items(id)` を `RESTRICT` で参照する。
- text / JSONはUTF-8 bytes、binaryは元bytesを`content`へ保存する。base64へ変換しない。
- JSONはApplication ServiceでUTF-8とJSON構文を検証してから保存する。
- `byte_length`はredaction後に保存するcontent bytesの長さで、0以上16 MiB以下かつ`length(content)`と一致させる。対応Itemの`payload_original_byte_length`はredaction前の元byte数であり、一致を要求しない。`content_sha256`は保存後content bytesのlowercase 64 hex文字とする。
- 1件上限16 MiBはredaction前と保存後の両方へ適用し、どちらかが超えれば保存しない。1 Run累計64 MiB、Session累計256 MiB、app全体1 GiBのdetail payload quotaは保存後`byte_length`の合計へ適用する。app設定でこれらを下げられるが、安全上限を上げる変更は別Design Gateを必要とする。
- detail payload commit前にDB volumeの空き容量を確認し、1 GiBまたはvolume容量の10%の大きい方を最低reserveとして維持する。quotaまたはreserveを満たせない場合は、`telemetry`、`provider_metadata`、`diagnostic`、`operation`、`assistant_detail`の順に新規detailを`omitted_size_limit`へ落とす。既存payloadを暗黙削除せず、final assistant Messageとterminal outcomeはdetail quotaの対象外とする。
- JSON / binaryを部分保存せず、textのpreviewもsummaryの上限内だけにする。quota判定とinsertは同じwrite transaction内で再検証し、並行commitでhard budgetを超えないようPersistence actorが直列化する。
- payload は作成後に本文を更新しない。redaction 修正や再分類が必要な場合は、既存 record を上書きするのではなく、別の privacy / repair 契約で置き換え履歴を扱う。

### index

primary key 以外の index は初期不要とする。一覧検索や category 検索に使わず、`output_item_id` による個別取得だけを提供する。

## Run output の transaction 境界

### output 確定

1. SQLite write transactionを開始する前に、payloadをdecodeし、redaction要否判定、sanitize、UTF-8 / JSON validation、encode、SHA-256、bounded summary生成まで完了する。元bytesは判定後に破棄し、cancelされた準備結果はcommitしない。
2. CPU preparationは1件32 MiB、app全体128 MiBのin-memory working-set budgetで直列化または待機させる。budget待機中と各準備段階でcancelを受け付け、Provider受信を無制限bufferしない。
3. transaction内でProvider item IDまたは論理output IDの重複、Run状態、ordinal、redaction結果、Run / Session / app quota、disk reserveを再検証する。
4. `run_output_items`の安全な軽量summaryと、保存可能な場合だけ`run_output_payloads`を2 row以内のwriteで追加する。上限超過は`omitted_size_limit`、準備失敗は`omitted_redaction`とし、transaction内でsanitizeやhashを行わない。
5. itemとpayloadを1 transactionでcommitする。

重複Provider itemの再受信は既存output IDを返し、payloadを重複追加しない。payload保存に失敗した場合は`payload_state='stored'`のItemだけを残さない。

### Run terminal

- terminal event受信後は、Run / Attemptのterminal outcome、successful Runのfinal assistant Message、child Delivery / Delegation、準備済みの軽量output summaryを高優先度transactionで先にcommitする。detail BLOBのwriter backlogをterminal commitの前提にしない。
- terminal transaction時点で安全なsummaryだけ確定しdetail保存が残るItemは`payload_state='pending'`とする。後続のbounded best-effort transactionで`stored`へ進めるか、quota / disk pressureなら`omitted_size_limit`、write failure / crash repairなら`omitted_persistence`へ一方向に収束させる。terminal Runを巻き戻さない。
- successful Run の final assistant Message は `messages` へ保存し、`final_answer` を RunOutputItem として重複保存しない。
- failed / canceled / interrupted Run の final candidate は Message へ昇格させず、必要な場合は `assistant_detail` / `completion_state='partial'` として保存する。
- output保存のpersistence failureでProviderのterminal outcomeを`failed`へ変更しない。Main processのlive persistence stateとresponse診断で別に公開する。

## Run output 読み込み契約

```text
getRunOutputCounts(runId)
  -> run_output_items の category 別集計だけ

listRunOutputItems(runId, category, afterOrdinal?, limit?)
  -> run_output_items だけ

getRunOutputPayloadPreview(outputItemId, maxBytes?)
  -> text / JSON の先頭最大64 KiBとmetadata。binaryはmetadataだけ

readRunOutputPayloadChunk(outputItemId, offset, limit, requestId)
  -> text / JSON の最大256 KiB chunk。cancel(requestId)とconsumer ackによるbackpressureを必須とする

exportRunOutputPayload(outputItemId, destinationGrant)
  -> binaryをRendererへhydrateせず、明示許可済みdestinationへstream exportする
```

- Session timeline / message hydrate からこれらの operation を暗黙呼び出ししない。
- assistant detail 一覧は `category='assistant_detail'` だけを読み、operation / telemetry の summary も payload も読まない。
- operation 一覧は `category='operation'` の summary だけを読み、個別 payload はその output ID をユーザーが展開した場合だけ読む。
- payload 取得は authorization、workspace / Session / Run 所属、retention / privacy を再検証する。
- `offset >= 0`、`1 <= limit <= 256 KiB`とし、1 responseでfull 16 MiBをWorker -> Main -> Rendererへ複製しない。binaryの通常詳細表示はmedia type、byte length、hashだけを返し、明示export / openだけがstreamを消費する。

## `session_relations`

親子 Session の不変な構造と orchestration tree の相関を保持する。実行状態、依頼の進行、結果配送状態は持たない。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `id` | `TEXT` | no | WithMate Session relation ID |
| `parent_session_id` | `TEXT` | no | 直接の親 Session |
| `child_session_id` | `TEXT` | no | 直接の子 Session |
| `orchestration_root_session_id` | `TEXT` | no | tree 最上位の Session |
| `created_by_parent_run_id` | `TEXT` | no | 子を作成した親 Run |
| `correlation_id` | `TEXT` | no | start / wait / status 操作で使う安定した外部相関 ID |
| `label` | `TEXT` | yes | UI / Agent 整理用の bounded label |
| `purpose_summary` | `TEXT` | yes | 本文ではない bounded な目的 summary |
| `created_at` | `INTEGER` | no | relation 作成時刻 |

### 制約と index

- primary key は `id`。`correlation_id` と `child_session_id` もそれぞれ unique とし、初期版では 1 child Session に直接の親を 1 件だけ許可する。
- parent / child / root は `sessions(id)` を `RESTRICT` で参照し、`parent_session_id <> child_session_id` とする。
- `(created_by_parent_run_id, parent_session_id)` は `runs(id, session_id)` を参照し、別 Session の Run から relation を作れないようにする。
- root Session 自身が直接子を作る場合は `orchestration_root_session_id=parent_session_id`。child Session が子を作る場合は親 relation の root を継承する。この継承と cycle 不在は作成 transaction 内で Application Service が検証する。
- row は作成後 immutable とする。label / purpose の修正が必要でも親子構造を上書きせず、後続の metadata 契約で扱う。
- `label` は 128 文字以内、`purpose_summary` は 512 文字以内とし、instruction 本文や CLI request JSON を保存しない。
- `INDEX session_relations_parent_created_idx (parent_session_id, created_at)`
- `INDEX session_relations_root_created_idx (orchestration_root_session_id, created_at)`
- `INDEX session_relations_root_child_idx (orchestration_root_session_id, child_session_id)`
- `UNIQUE INDEX session_relations_correlation_uq (correlation_id)`
- `UNIQUE INDEX session_relations_child_uq (child_session_id)`

## `delegations`

親 Agent から子 Agent への 1 件の依頼と、その依頼を継続するかどうかを保持する。Session lifecycle、Run phase、結果の可用性、結果の回収有無は持たない。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `id` | `TEXT` | no | WithMate Delegation ID |
| `session_relation_id` | `TEXT` | no | 対応する親子 relation |
| `initial_instruction_message_id` | `TEXT` | no | 最初の child user Message |
| `latest_instruction_message_id` | `TEXT` | no | 現在の指示を表す child user Message |
| `latest_child_run_id` | `TEXT` | no | 現在または直近の child Run |
| `mention_text` | `TEXT` | yes | 親 timeline / UI 表示専用の mention text |
| `workflow_state` | `TEXT` | no | `active` / `clarification_required` / `closed` |
| `closure_reason` | `TEXT` | yes | `completed` / `failed` / `canceled` / `interrupted` / `abandoned` |
| `created_at` | `INTEGER` | no | 作成時刻 |
| `updated_at` | `INTEGER` | no | 最終更新時刻 |
| `version` | `INTEGER` | no | 楽観的競合検出 version |

### 制約と index

- primary key は `id`。初期版では `session_relation_id` を unique とし、1 relation に 1 Delegation とする。clarification 後も同じ Delegation を継続する。
- `session_relation_id` は `session_relations(id)` を `RESTRICT` で参照する。
- initial / latest instruction Message は relation の child Session に属する `role='user'` の Message とする。latest child Run も同じ child Session に属し、その `initiating_message_id` は latest instruction Message と一致させる。この所属と role は admission transaction 内で検証する。
- `initial_instruction_message_id` は作成後変更しない。補足指示は新しい Message と Run を作り、latest 参照だけを進める。exact retry は Message を追加せず latest child Run だけを進める。
- `workflow_state='closed'` と `closure_reason IS NOT NULL` は同時に成立する。`active` / `clarification_required` では closure reason を持たない。
- 許可する通常遷移は`active -> clarification_required -> active`、`active -> closed`、`clarification_required -> closed`とする。user / callerが明示したretryだけは、同じtransactionで新しいRunをadmitし、latest参照を進め、`closure_reason`をnullにして`closed -> active`へ戻せる。repairや自動retryでは再開せず、retry拒否時はclosedのまま変更しない。
- child Run の terminal outcome が clarification response なら `clarification_required`、依頼を継続しないなら `closed` へ更新する。実際の成功・失敗・cancel は Run を参照し、Delegation に複製しない。
- `mention_text` は 128 文字以内とし、Provider input や instruction の再構築に使用しない。CLI request JSON、model、reasoning、Character、capacity、idempotency の情報も保存しない。
- `version >= 0` とする。
- `UNIQUE INDEX delegations_relation_uq (session_relation_id)`
- `INDEX delegations_state_updated_idx (workflow_state, updated_at DESC)`
- `INDEX delegations_latest_run_idx (latest_child_run_id)`

## `child_result_deliveries`

1 件の child Run の結果が親から参照可能かと、親が初めて回収した事実を保持する。1 Delegation は clarification と補足後の実行により複数の child Run を持てるため、Delivery も 1..N とする。

| Column | Type | Null | 意味 |
| --- | --- | --- | --- |
| `id` | `TEXT` | no | WithMate Child result delivery ID |
| `delegation_id` | `TEXT` | no | 対応する Delegation |
| `ordinal` | `INTEGER` | no | Delegation 内の delivery 順序 |
| `child_run_id` | `TEXT` | no | 結果元の child Run |
| `availability_state` | `TEXT` | no | `pending` / `available` |
| `terminal_phase_snapshot` | `TEXT` | yes | result envelope用のterminal phase |
| `result_summary` | `TEXT` | yes | 一覧・Hook 通知用の redacted / bounded summary |
| `available_at` | `INTEGER` | yes | 結果参照が可能になった時刻 |
| `first_collected_by_parent_run_id` | `TEXT` | yes | 最初に結果を回収した親 Run |
| `first_collected_at` | `INTEGER` | yes | 最初の回収時刻 |
| `created_at` | `INTEGER` | no | child Run admission 時刻 |
| `updated_at` | `INTEGER` | no | 最終更新時刻 |
| `version` | `INTEGER` | no | 楽観的競合検出 version |

### 制約と index

- primary key は `id`。`child_run_id` は unique とし、1 child Run に Delivery を 1 件だけ作る。
- `delegation_id` は `delegations(id)`、`child_run_id` は `runs(id)` を `RESTRICT` で参照する。Run が Delegation relation の child Session に属することを admission transaction 内で検証する。
- `UNIQUE (delegation_id, ordinal)` とし、`ordinal >= 1` とする。欠番は許容するが再利用しない。
- `pending` では terminal snapshot、summary、available時刻を持たない。
- `available` では `terminal_phase_snapshot` と `available_at` を必須とする。
- `first_collected_by_parent_run_id` と `first_collected_at` は同時に null または non-null とする。回収 Run は relation の parent Session に属する Run であることを collect transaction 内で検証する。
- 可用性と回収済みかどうかは別軸とする。`collect` 後も `availability_state='available'` を維持し、child Sessionが存在する間は再取得を許可する。
- 結果本文や final Message 本文は複製しない。`child_run_id` から Run、final Message、Run output を必要に応じて取得する。`result_summary` は 1024 文字以内とする。
- `version >= 0` とする。
- `UNIQUE INDEX child_result_deliveries_run_uq (child_run_id)`
- `UNIQUE INDEX child_result_deliveries_delegation_ordinal_uq (delegation_id, ordinal)`
- `INDEX child_result_deliveries_availability_idx (availability_state, first_collected_at, available_at)`
- `INDEX child_result_deliveries_delegation_idx (delegation_id, ordinal)`

## admission / terminal / delivery の transaction 境界

### Session 作成

1. `sessions` に `lifecycle_status='active'` で追加する。
2. ProviderBinding は作成せず、最初の Run まで遅延できる。

### 通常 Run / child Run の受理

1. Session が `active`、non-terminal Run が存在しない、idempotency条件も満たすことを検証する。child Runではroot Sessionの`max_concurrent_child_runs`と、`runs` / `session_relations`から導出した同root配下のnon-terminal child Run件数を同じwrite transaction内で検証する。
2. 新規 instruction なら user `messages` を追加する。exact retry なら元の Message を参照し、追加しない。`child.start`のIdempotencyRecordはchildではなくcallerであるparent Sessionへscopeする。
3. `runs` に `phase='queued'`で追加し、最初の `run_attempts` を `preparing`、対応する `run_dispatches` を `pending` で作成する。active Bindingがない場合は、同じAttemptを`created_by_run_attempt_id`に持つ`creating` ProviderBindingも同じtransactionで作成する。
4. child Run では、初回だけ `session_relations` と `delegations` を作成し、毎回 `child_result_deliveries` を `pending` で追加する。補足指示と retry では既存 Delegation の latest 参照を更新する。
5. child Runでは、作成した`queued` Run自体がcommit後の1枠を表す。completed `idempotency_records`まで同じtransactionでdurable commitし、response refは作成したRunまたはChildHandleを指す。commit失敗時はProviderを起動しない。

### Provider会話の作成

1. active Bindingがなく`creating` Bindingがある場合だけ、intent rowのdurable commit後に`thread/start`等の外部会話作成requestを送る。
2. Providerが外部会話IDを返した場合は、同じBindingへのID設定と`active`化、作成元Attemptの`provider_binding_id`設定を1つのtransactionでcommitする。同じSessionへの所属を確認し、このtransaction成功後だけRunDispatchを送信できる。
3. timeout、transport切断、process crashで外部会話の作成受理を証明できない場合は、同じrequestを自動再送しない。Providerのlist / lookup / native idempotencyにより同じ会話を一意に証明できた場合だけ元BindingへIDを設定して`active`にする。
4. 一意照合できない場合は、同じtransactionでBindingを`invalidated(invalidation_reason='conversation_start_ambiguous')`、AttemptとRunを`interrupted`、未送信Dispatchを`aborted`へ収束させる。Provider側に残り得る相関不能orphan会話はboundedな診断件数として扱い、自動削除や推測相関を行わない。Provider側retention / cleanupは後続policyで扱う。
5. crash復旧時の`creating` Bindingも同じ規則で照合し、外部会話IDを証明できないまま新しい会話作成requestを送らない。

### Provider実行requestの送信

1. Run、Attempt、Binding、Dispatchが同じSession / Providerに属し、Runがnon-terminal、Attemptが`preparing`、Bindingが`active`、Dispatchが`pending`であることを検証する。この4条件を自動送信とmanual送信の共通Gateとし、terminal Runやinvalidated BindingのDispatchは送らない。
2. 条件付き update で Dispatch を `dispatching` へ進め、`dispatching_at` を設定して durable commit する。
3. commit 成功後だけ Provider request を送る。送信前に process が停止した場合も、`dispatching` を `pending` へ戻さず受理有無の照会対象にする。
4. Provider が外部実行 ID を返した場合は、同じ transaction で Attempt の `external_execution_id` / `started_at` / `attempt_state='active'` と Dispatch の `accepted` / `resolved_at` を確定する。
5. Provider が未受理を明示した場合は `rejected`、受理有無を証明できない場合は `ambiguous` へ進める。Attempt / Run の失敗への変換は retry / recovery policy が別に判断する。

### 正常完了

1. active RunAttempt を `succeeded` へ進め、user-visible な最終本文がある場合だけ assistant `messages` を追加する。
2. `runs` を `phase='completed'`、`terminal_at=<now>` へ更新し、存在する場合は `final_assistant_message_id` を設定する。
3. child Runでは、Delegation workflowと対応するDeliveryの`available`化を同じtransactionで確定する。terminal化したRunはcapacity集計から自動的に外れる。clarification responseならDelegationを`clarification_required`、継続しない結果なら`closed`にする。

### 失敗・cancel・中断

- `runs.phase` と terminal outcome を確定する。
- active RunAttempt も対応する `failed` / `interrupted` へ収束させる。user cancel による Run の `canceled` は Attempt では `interrupted` とし、cancel の事実は Run に保持する。
- child Runはterminal化した時点でcapacity集計から外れる。別の解放rowや解放処理は持たない。
- cancel request の受理だけで terminal にせず、`runs.phase='canceling'` の間は当該 Run を non-terminal として扱う。
- child Runではterminal phaseをDeliveryへsnapshotして`available`とし、Delegationを`closed`へ更新する。Run phaseは`completed -> completed`、`failed -> failed`、`canceled -> canceled`、`interrupted -> interrupted`のclosure reasonへ写し、Provider実行失敗と結果配送失敗を混同しない。

### child 結果の回収

`waitChild` / `waitAny` / `waitAll`はready handleだけを返すread-only待機であり、ChildResult本文を親tool resultへ返さず、本transactionを実行しない。複数結果を1つのIdempotencyRecordへ保存しない。結果を親Runへ渡す場合は、対象Deliveryごとに必ず`collectChildResult`を呼ぶ。

1. 単一のDeliveryが`available`で、child Runと参照対象が取得可能であることを検証する。
2. 初回だけ `first_collected_by_parent_run_id` / `first_collected_at` を設定する。別の親 Run からの再取得では初回記録を上書きしない。
3. 親 Run の tool result / RunEvent 相関と completed IdempotencyRecord を同じ transaction で保存する。response ref は Delivery を指し、応答送信前の切断後も同じ意味の envelope を再構築できるようにする。
4. Delegation workflow と Delivery availability は変更しない。

### Session treeの明示削除

1. 削除対象Sessionをrootとするsubtreeをrecursive queryで確定し、同じSQLite write transaction内で対象Sessionのlifecycleと全Runを再検証する。tree membershipやbusy判定をtransaction外のsnapshotだけで確定しない。
2. subtree内にnon-terminal Runが1件でもあればtransaction全体をrollbackし、`session_busy`を返す。deleteは暗黙のcancelを行わない。
3. subtreeのSession、Message、Run、Attempt、Dispatch、output/payload/event/input delivery、ProviderBinding、relation、Delegation、ChildResultDelivery、`scope_session_id`がsubtreeに属するIdempotencyRecordを物理削除する。Session tombstone、Delivery tombstone、復元用rowは残さない。
4. 親Sessionがsubtree外に残る場合、subtreeのSession / Run / relation / Delegation / Deliveryをsubjectとする親側RunEventを削除する。`child.start`のように親へscopeしたIdempotencyRecordは削除せず、response refを消して`expired` tombstoneへ進める。RunEvent ordinalの欠番は許容する。child result本文は親MessageやRunOutputItemへ複製保存しないため、親の会話本文や無関係なoutputは削除しない。
5. 外部キーは`RESTRICT`を維持し、関連rowをbottom-upで明示削除する。ProviderBindingとRunAttemptの循環参照、およびBindingのself referenceはdelete transaction中だけdeferred foreign keyとして検証し、commit時に参照が残っていないことを保証する。

明示deleteと自動retentionは別操作とする。初期版で確定するのはuserによるlocal明示deleteだけであり、自動retention期間は後続設計とする。初期版はProvider側Thread / Sessionの削除を要求・保証せず、local Binding削除後にremote cleanupを再試行できない。UI / APIの確認文と結果は`local_only=true`を明示し、「Provider側データも削除した」と表示しない。remote delete保証が要件化した時点で、subtree外cleanup outboxを導入してから契約を変更する。

## 修復規則

1. `runs` の partial unique index と phase から、Session の non-terminal Run を最大 1 件に確定する。
2. Run と Attempt を照合し、non-terminal Run に non-terminal Attempt が 0 件または複数ある場合は Provider を起動せず診断対象にする。外部実行 ID を推測で作成しない。
3. AttemptとDispatchを照合する。Run non-terminal、Attempt `preparing`、Binding `active`、Dispatch `pending`の4条件をすべて満たす場合だけ自動送信候補にできる。Binding作成失敗やterminal Runに残る`pending`は`aborted`へ収束させる。`dispatching`は照会後も受理を証明できなければ`ambiguous`へ進め、`accepted`の外部実行IDを推測せず、terminal stateを`pending`へ戻さない。
4. IdempotencyRecordとdomain recordを照合する。completed refの欠落は応答を捏造せず診断対象にし、`in_progress`を参照先の確認なしにcompletedへ進めない。期限到達済みcompleted recordはresponse参照を消去して`expired`へ進め、tombstoneをSession削除まで保持する。
5. creating / active BindingはSessionごとに合計最大1件へ収束させる。`creating`はProvider照合で外部会話IDを一意に証明できた場合だけactiveへ進め、証明不能ならinvalidatedへ収束させる。外部状態を確認せずrequestを再送したりinvalidated Bindingをactiveへ戻したりしない。
6. child Run と Delivery を照合し、non-terminal Run は `pending`、terminal Run は `available` へ修復する。回収記録は推測で作成しない。
7. Delegationのlatest Message / Runは実在する最大の継続組から修復する。repairは`closed`を`active`へ戻さず、明示retry admissionだけが原子的な再開を行う。
8. terminal Runの`payload_state='pending'`はpayload rowの存在を照合し、存在すれば`stored`、存在しなければ`omitted_persistence`へ収束させる。repairでterminal outcomeを巻き戻さない。

## 永続化要否の見直し

確定済み 14 table を、再起動後の復旧、二重実行防止、長期履歴・参照整合性の観点で再確認した。table 単位でメモリ管理だけへ移せるものはない。

| Table | 永続化する理由 |
| --- | --- |
| `sessions` | 会話 lifecycle、設定、一覧・復旧の起点 |
| `messages` | 確定済み user / final assistant 会話履歴 |
| `runs` | 論理実行、terminal outcome、修復判断の基準 |
| `run_output_items` | 確定済み途中出力と操作・診断の履歴 |
| `run_output_payloads` | 上限内の確定済み詳細本文 |
| `session_relations` | 再起動後も必要な不変の親子構造 |
| `delegations` | clarification をまたぐ依頼単位と継続状態 |
| `child_result_deliveries` | 結果可用性、初回回収、再取得 |
| `provider_bindings` | Provider 会話の resume と置換履歴 |
| `run_attempts` | 外部実行 ID、内部再試行、安全な復旧判断 |
| `run_dispatches` | Provider request の二重送信防止 |
| `idempotency_records` | process 再起動や応答切断をまたぐ重複操作防止 |
| `run_events` | 再起動後の cursor follow と出来事の履歴 |
| `run_input_deliveries` | steer の二重配送防止と受理不明状態の保持 |

root capacity使用数は、`session_relations.orchestration_root_session_id`配下のSessionに属するnon-terminal child Runを`runs`から数えて導出する。app全体とProvider runtime別capacityは、通常Run / Auxiliary / child Runのnon-terminal Runと、そのAttempt / Bindingから同じtransactionで導出する。各上限確認と`queued` Run追加を同じSQLite write transaction内で直列化するため、専用の枠管理tableは持たない。受理済みRunはProvider起動前から各枠を使用し、terminal化した時点で集計から外れる。

## 未決定ではない後続設計範囲

次の項目は確定済み table の責務に混ぜず、後続で定義する。

- evaluation record
- 自動retention期間とProvider側会話削除の連動policy

## メモリだけで保持する実行中状態

### live persistence state

- `idle` / `committing` / `retry_wait` / `failed` はMain processの保存処理状態としてメモリだけに保持し、`runs`には保存しない。
- `committed`は対象transactionが成功した事実そのものであり、専用columnで重複表現しない。DB write failure中の`failed`も同じDBへ確実に書けないため、復旧判断の基準にしない。
- live stateはboundedな`error_code`、`retryable`、`last_attempt_at`を持てる。保存再試行は同じ確定済みdomain transitionのcommitだけを行い、Providerを再実行しない。commit成功後はlive stateを破棄する。
- CLI / APIは実行outcomeとlive persistence結果を同じresponse envelopeの別fieldで返せる。保存失敗時は`overallStatus='partial_success'`と`persistence.status='failed'`を返し、未永続のoutcomeを復旧可能とは表示しない。
- Main process再起動後は保存失敗状態そのものを復元しない。DBに最後にcommitされたRun / Attempt / DispatchとProvider外部状態を照合し、terminal outcomeを証明できれば再commit、証明できなければ`interrupted`へ収束させる。
- SQLite障害中にMain processも終了し、Providerからterminal outcomeを再取得できない場合、そのoutcomeを失う可能性を受容する。これを防ぐ要件が生じた場合は、`runs` columnではなくSQLiteとは別のdurable journalを設計する。

### live activity

- `running` / `waiting_approval` / `waiting_input` / `waiting_child` はactive Runの表示・操作用live stateとしてMain processのApplication Serviceがメモリだけに保持し、`runs`には保存しない。
- `waiting_approval` / `waiting_input` は未解決live interaction、`waiting_child`は明示的なwait operationが存在するときだけ設定する。child Runが存在するだけで`waiting_child`を推測しない。
- 複数状態が同時に成立する場合の代表表示は`waiting_input`、`waiting_approval`、`waiting_child`、`running`の順とする。DBのRun状態は`phase`だけを基準にする。
- Session Windowはlive stateの所有者ではなく購読者とする。Windowを閉じてもMain process、Provider接続、Run、activity、draft、live interactionを破棄またはcancelしない。
- Windowを開き直す場合はMain processからlive snapshotとRunEvent cursorを同時に取得し、そのcursor以降のevent購読を開始する。古いRenderer stateだけから表示を復元しない。
- Main processまたはアプリ全体の再起動後はactivityをDBから推測しない。UIは一時的に再接続確認中と表示し、同じProvider実行と現在操作を証明できた場合だけlive activityを再構築する。証明できなければRunを`interrupted`へ収束させる。

### assistant draft

- streaming 中の assistant draft は Application Service の live state としてメモリだけに保持し、専用 table や snapshot row を作らない。
- draftはUTF-8 bytesのimmutable chunk列またはropeとしてappendし、deltaごとの全文string再生成を禁止する。1 chunkは最大64 KiB、1 Runの保持上限は4 MiB、app全体は32 MiBとする。
- Main -> Renderer配信は50 msまたは64 KiBの早い方でdeltaをcoalesceし、sequence番号とackでbackpressureをかける。未ackが1 MiBを超えたWindowと非表示Windowには本文deltaを止め、byte数とtruncated状態だけを通知する。
- per-Runまたはapp budget到達後はUI previewの追記だけを停止して`preview_truncated=true`とし、Provider Run自体は継続する。final Message生成用のProvider側確定本文はAdapterのbounded finalization pathで受け取り、live preview bufferの欠落をそのまま正常本文として確定しない。
- Renderer の再読み込みでは main process の live state から再表示できる。アプリ全体または Provider process の再起動後に draft を復元しない。
- 正常完了した本文は final assistant Message、失敗・cancel・中断時に残す確定済み partial output は RunOutputItem として保存する。streaming delta 自体は保存しない。

### pending interaction

- approval / user input / elicitation request の未解決状態は、実行中 Run と Provider 接続に結び付いた Application Service の live state としてメモリだけに保持し、専用 table を作らない。
- live state は Provider request ID、Run / RunAttempt、interaction 種別、bounded な表示内容、回答候補、timeout、回答中状態を持てるが、SQLite へ保存しない。
- 解決後の発生・回答・timeout は RunEvent に、承認対象や回答結果の bounded summary は必要に応じて RunOutputItem に保存する。Provider request / response の生 payload は保存しない。
- Renderer の再読み込みでは main process の live state から再表示できる。アプリ全体または Provider process の再起動後は未解決 request を回答可能な状態へ復元せず、対応 Run を `interrupted` へ収束させる。
- 古い request ID への回答、別 Turn への回答、timeout 後の二重回答を防ぐため、DB record だけから approval / input response を再送しない。
- process 再起動後の同一 Turn resume、未解決 request の再通知、同じ外部 request ID の未解決確認と安全な回答をruntimeで実証できた場合だけ、専用 tableへの昇格を再検討する。

## SQLite容量・WAL maintenance契約

- DB作成時に`PRAGMA journal_mode=WAL`、`auto_vacuum=INCREMENTAL`、`secure_delete=FAST`を設定する。`auto_vacuum`はtable作成前に確定し、既存DBへ後付けするmigrationは初期版に存在しない。
- connectionごとに旧実装と同じ`wal_autocheckpoint=256`、`journal_size_limit=67108864`、`busy_timeout=5000`を設定する。正常shutdownでは`wal_checkpoint(TRUNCATE)`をbounded timeout付きで試行し、失敗をDB破損やdelete rollbackとして扱わない。
- Session subtree deleteはrowと参照を1 transactionで削除するが、DB fileの即時縮小やProvider側削除までは保証しない。commit後に`wal_checkpoint(PASSIVE)`を要求し、freelistが閾値を超えた場合だけidle maintenanceで最大1024 pageずつ`incremental_vacuum`する。foregroundでfull `VACUUM`を実行しない。
- privacy保証は、query可能なrowをcommit時に除去し、`secure_delete=FAST`とcheckpoint / incremental vacuumで再利用pageをbest-effort消去・回収する範囲とする。OS、filesystem、SSD、backup、Provider側copyからの即時不可逆消去は保証しない。
- 大規模subtree deleteは対象payload bytesと想定WAL増分を事前計測し、disk reserveを割る場合は`insufficient_disk_space`で開始前に拒否する。実装前にpayload量を段階的に増やしたdeleteでtransaction時間、WAL peak、writer停止時間、checkpoint / reclaim後の容量を実測する。

## 検証 Gate

- 別 Session の Message / Run を参照する外部キーが拒否される。
- SQLiteで`runs(id, session_id)`を親キーとするretry Run / SessionRelationの代表INSERTが成立し、別Sessionの組合せは拒否され、`PRAGMA foreign_key_check`がerrorを返さない。
- 1 Session へ non-terminal Run を 2 件同時に追加できない。
- user Message / queued Run の片方だけが admission 失敗後に残らない。
- exact retry が Message を複製せず、本文変更時は新しい Message を作る。
- terminal Run を non-terminal へ戻せない。
- assistant Message の作成と completed Run の参照更新が同じ transaction で成立する。
- Session Windowを閉じてもMain processのRun、Provider接続、live activity、draft、live interactionが破棄されない。
- Window再表示時にlive snapshotとRunEvent cursorを取得し、snapshot取得とevent購読の間の更新を欠落させない。
- Main process再起動後にlive activityをDBやchild Runの存在だけから推測せず、Provider状態を証明できなければRunを`interrupted`へ収束させる。
- SQLite write失敗時にProviderのterminal outcomeをfailedへ変更せず、live responseで`partial_success`とpersistence failureを別々に返す。
- persistence retryが同じdomain transitionのcommitだけを再実行し、Provider requestを再送しない。
- Main process再起動後は過去のlive persistence failureをDB columnから復元せず、最後にcommit済みのRun / Attempt / DispatchとProvider状態から収束させる。
- Message timeline を ordinal cursor で取得し、欠番があっても順序が崩れない。
- Session一覧が`(last_activity_at, id)`のkeyset cursorでpaginateされ、1 queryでexecution state / activeRunId / latestRunIdを返し、大量Sessionでも全件hydrateやN+1 queryを行わない。
- 完了後の Session hydrate で final assistant Message だけを読み、assistant detail / tool / raw output payload を読み込まない。
- assistant detail 展開時に operation / telemetry payload を読み込まず、operation 一覧展開時に個別 operation payload を読み込まない。
- `payload_state='stored'`のRunOutputItemだけ、またはorphan payloadだけがtransaction失敗後に残らない。
- `redaction_state='unknown'`と`payload_state='stored'`の組合せを拒否し、secret / absolute pathを含むpayloadのsanitizer失敗時は`omitted_redaction`となってBLOBへ保存されない。
- redactionでbyte数が変わってもItemの元byte数とpayload rowの保存後byte数を別々に保持し、`byte_length=length(content)`が成立する。
- 重複 Provider item の再受信で output、payload が増えない。
- RunEvent を ordinal cursor で追跡でき、時刻が前後しても順序が変わらない。
- 同じ `dedupe_key` の再受信で RunEvent が増えず、別 Run の同じ key は競合しない。
- RunEvent 一覧の取得で output payload や参照先の詳細を join せず、streaming delta ごとの row も作らない。
- supplemental Message と pending RunInputDelivery の片方だけが受理 transaction 失敗後に残らない。
- RunInputDelivery は active Run / Attempt だけを対象にし、Attempt 切り替え後も配送先を書き換えない。
- Run non-terminal、Attempt `preparing`、Binding `active`、Dispatch `pending`の組だけを安全に自動送信でき、crash後の`dispatching`は受理を証明できなければ`ambiguous`へ収束する。
- 同じ idempotency key の再送が Message / Delivery を増やさず、明示的な再送は新しい Message / Delivery を作る。
- category summary一覧がpayload tableを読み込まない。
- text / JSON / binaryのBLOB保存、JSON validation、hash / byte length検証が成立する。
- redaction前または保存後の1件16 MiB、Run累計64 MiB、Session累計256 MiB、app全体1 GiB、disk reserveのいずれかを超えるとpayload rowを作らず`omitted_size_limit`となり、Run outcome自体は失敗へ変更されない。
- decode / sanitize / encode / hashがwrite transaction開始前に完了し、transaction内は再検証と2 row以内のwriteだけで、準備中のcancelとapp全体memory budgetが機能する。
- slow writer / large BLOB backlogでもterminal outcomeとfinal Messageが先にcommitされ、crash後に`pending` detailが`stored`または`omitted_persistence`へ収束する。
- previewは最大64 KiB、text / JSON chunkは最大256 KiBでcancel / backpressureが働き、binary full BLOBをRendererへhydrateせず明示exportする。
- child Session が複数の親 relation を持てず、別親 Session の Run を `created_by_parent_run_id` に設定できない。
- 入れ子 child が root Session ID を継承し、cycle を作れない。
- subtree内にnon-terminal RunがあるSession deleteが`session_busy`で全rollbackし、暗黙cancelを行わない。
- terminalなroot / intermediate child / leaf Sessionのdeleteで対象subtreeと関連local dataが残らず、subtree外の無関係なSession dataは維持される。
- Session delete後に削除済みIdempotencyRecordから旧responseを再送しない。
- `child.start -> terminal -> child subtree delete -> 同一key再送`でparent scopeのexpired tombstoneが新規child作成を拒否する。
- local-only deleteの確認・結果がProvider側削除を保証せず、Binding削除後にremote cleanup可能と誤表示しない。
- Delegation の initial instruction を変更できず、補足指示と exact retry で latest 参照が正しく進む。
- Delegation workflow に結果可用性や回収済み状態を保存しない。
- 1 Delegation の clarification と補足後 Run が別々の Delivery を持ち、状態を巻き戻さない。
- closed Delegationの明示retryだけが新Run admissionと原子的に`active`へ戻り、failed Runは`closure_reason='failed'`へ写され、repairはclosedを再開しない。
- child Run terminal、Delegation workflow、Delivery available の一部だけが残らず、terminal化したRunがcapacity集計から外れる。
- `collect` 再送で初回回収記録を上書きせず、同じ結果 envelope を返す。
- `waitChild` / `waitAny` / `waitAll`がready handleだけを返してDeliveryとIdempotencyRecordを変更せず、ChildResultの親tool result化と初回回収はDeliveryごとの明示`collect`だけで記録される。
- child Sessionが存在する間は回収済みの結果を再取得でき、再取得で初回回収記録を失わない。
- Delivery 一覧と Hook metadata が結果本文や Run output payload を読み込まない。
- 1 Sessionに`creating` / `active` ProviderBindingを同時に2件作れず、Binding置換後も旧外部会話IDと履歴を辿れる。
- `creating` Bindingのdurable commit前に外部会話作成requestを送らず、response loss後に同じrequestを自動再送しない。一意照合不能ならBinding / Attempt / Run / Dispatchがinvalidated / interrupted / abortedへ同時に収束し、orphan会話を推測相関・自動削除しない。
- Bindingのactive化と作成元Attemptの`provider_binding_id`設定が同じtransactionで成立し、別SessionのAttemptとBindingを相関できない。
- ephemeral Binding が resume 対象にならず、診断用の外部相関としては残る。
- 1 Run に non-terminal Attempt と succeeded Attempt をそれぞれ複数作れない。
- stale Binding recovery が meaningful partial、確定副作用、ambiguous dispatch の後に開始されない。
- 同じ外部実行への reconnect / 状態照会が新しい Attempt を作らない。
- 内部再試行後に Run が成功しても、先行 failed Attempt の診断が残る。
- admission 失敗後に RunAttempt または `pending` RunDispatch だけが残らない。
- `pending -> dispatching` の durable commit 前に Provider request を送らない。
- crash復旧でRun non-terminal、Attempt preparing、Binding active、Dispatch pendingの組だけを安全に自動送信し、terminal Runのpendingをabortedへ収束させ、dispatching / ambiguousを重複送信しない。
- `accepted` Dispatch と Attempt の外部実行 ID が同じ transaction で確定する。
- 同じ Attempt に異なる request fingerprint を使えず、request本文や一時的なJSON-RPC request IDを保存しない。
- 同じidempotency key / operation / fingerprintの再送がdomain mutationを重複作成せず、同じ意味の応答を返す。
- 同じkeyを異なるoperationまたはfingerprintで使用すると`idempotency_conflict`になる。
- completed IdempotencyRecordが期限到達時にresponse参照を消去して`expired`となり、同じkeyの再利用へ`idempotency_expired`を返す。expired tombstoneはscope Session削除まで残る。
- Run開始、child開始、cancel、approval回答のdomain mutationとcompleted IdempotencyRecordの一部だけが残らない。
- collectの応答送信前切断後に、同じkeyで単一Delivery参照から応答を再構築できる。
- `in_progress`のcrash復旧でmutation成功を推測せず、operation固有の外部副作用を証明できる場合だけ再評価する。
- response envelopeにMessage本文、child結果本文、Run output payload、raw Provider responseを保存しない。
- IdempotencyRecordの保持中に応答参照先だけが先に削除されない。
- 同じrootへの並行child Run admissionが、同一write transaction内の件数確認と`queued` Run追加により設定上限を超えない。
- capacity集計が通常Runや別treeのchild Runを含めず、入れ子childも同じroot配下として数える。
- child Runのterminal化後は別の解放処理なしでcapacity集計から外れ、重複terminal eventで枠数が変動しない。
- Sessionの上限値を現在のnon-terminal child Run件数より小さくしても既存Runを停止せず、新規admissionだけを拒否する。
- 複数root、通常Run、Auxiliary、child Runを合算したapp全体 / Provider runtime hard capが並行admissionでも超過せず、low-resource profileで保守的defaultが適用される。
- 複数の長時間streaming Runでdraft保持がper-Run 4 MiB / app全体32 MiBを超えず、delta coalescing、hidden Window抑制、Renderer backpressure、preview truncate後のRun継続が成立する。
- 大規模subtree deleteでWAL peakとwriter停止時間を測定し、delete後checkpointとbounded incremental vacuumが働き、foreground full VACUUMを実行しない。
