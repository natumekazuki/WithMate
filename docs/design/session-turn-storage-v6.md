# V6 Session Turn Storage

- 作成日: 2026-07-05
- 対象: Session turn の永続化分類、provider output の分離、初回 migration 方針
- Status: Proposed

## Goal

Session 実行 1 turn に関する保存データを、WithMate の意味で分類し直す。

現行 V6 では `audit_events_v6.metadata_json` に、Session に表示する最終メッセージ、実行中の途中経過、provider から返却された raw/detail、WithMate 側の実行管理情報が同居している。
この構造は、Session 一覧や通常 hydrate で不要な detail を読み込みやすく、UI 表示領域ごとの責務も曖昧になりやすい。

この設計では、Codex や GitHub Copilot など個別 provider の event type を DB の中心にせず、WithMate として扱うデータ種別を先に固定する。
provider adapter は、各 provider の raw event / response を WithMate の分類へ振り分ける。

## Position

- V6 DB foundation は `docs/design/v6-database-foundation.md` を優先する。
- current 保存構造の棚卸しは `docs/design/database-schema.md` を参照する。
- 監査ログ UI と既存 audit の目的は `docs/design/audit-log.md` を参照する。
- 本書は V6 Session turn の再分類と移行方針の正本とする。

## Classification

Session turn に関するデータは、次の優先順で分類する。

1. Session に最終的に表示するメッセージ
2. 実行中に表示する途中経過本文
3. 1 と 2 以外の provider 返却データ
4. 1 から 3 以外の WithMate 側実行文脈

分類は排他的に扱う。
provider から返却された assistant text であっても、Session の最終表示本文として採用するものは 1、実行中表示の途中本文として採用するものは 2 に昇格する。
3 は、それらを取り除いた provider output の detail / trace である。

### 1. Final Session Message

Session の通常 timeline に表示する最終メッセージ。

正本は `session_messages_v6` とする。
assistant の最終レスポンスは、既存 Session UI / summary / message artifact の読み込み経路に乗るため、turn 専用 table に閉じ込めない。

対象:

- user message
- assistant final message
- Session timeline に残す tool / system message
- assistant artifact summary / artifact detail

### 2. Interim Message

実行中 UI に表示する途中経過本文。

途中経過は completion 後の最終メッセージとは別物として扱う。
実行中 UI では、途中経過専用の表示領域を作らず、現在の assistant 仮表示として扱ってよい。
completion 時に final assistant message が確定した場合、通常 UI は 1 だけを表示し、2 は Session message list / renderer state / Main Process live state から取り除く。
2 は Details / debug / crash recovery 用にだけ参照し、Details を開くまでは読み込まない。

本設計では、実行中 window refresh / crash recovery / Details 表示に備えて `session_turn_interims_v6` に保存する。
ただし、通常 UI の初期 hydrate では `session_turn_interims_v6` を読まない。

### 3. Provider Output

1 と 2 以外の provider 返却データ。

provider-specific な event / item / operation / usage / error は、Session timeline の正本ではなく、Details / Audit / debug 用の冷たい detail として保存する。
通常の Session 一覧や message hydrate では読まない。

対象:

- command / tool execution の detail
- file change / diff / artifact の raw detail
- approval / elicitation request の provider-side trace
- reasoning / status / diagnostic event
- usage
- quota / context telemetry
- background task snapshot
- provider error / warning
- raw items
- logical prompt / transport payload
- provider thread / run response detail
- adapter がまだ分類できない provider response / event snapshot

`logicalPrompt` と `transportPayload` は provider へ渡した内容や provider 実行に関する detail であり、通常表示 message ではないため 3 に分類する。
ただし、検索や一覧で必要な短い summary は 4 に重複保持してよい。

### 4. Turn Context

1 回の実行が何者かを表す WithMate 側の親レコード。

4 は「その他 payload を詰める場所」ではない。
大きな本文や raw JSON は持たず、1 / 2 / 3 を束ねるための薄い実行文脈に限定する。

対象:

- turn id
- session id / auxiliary session id
- phase / status
- provider id
- model id
- reasoning effort
- approval mode
- sandbox mode。provider が sandbox を持たない場合は空値または `NULL`
- started / completed / updated timestamp
- user message id
- assistant message id
- provider thread id の短い snapshot
- error summary / error kind
- provider output や prompt blob への summary / presence flag

## Proposed Tables

### Existing: `session_messages_v6`

分類 1 の正本。

`session_messages_v6` は Session timeline の通常 message table として継続する。
assistant final message は `session_turns_v6.assistant_message_seq` から参照してよいが、message 自体は `session_messages_v6` に保存する。

`session_storage_v6` は Session 保存時に message row を削除して再作成するため、`session_messages_v6.id` は turn から参照する安定 ID として扱わない。
turn と message の対応は同一 `session_id` 内の `seq` で保持する。

### New: `session_turns_v6`

分類 4 の正本。
1 turn につき 1 row とする。

概念 schema:

| Column | Meaning |
| --- | --- |
| `id` | turn id。初回 migration では `audit_events_v6.id` を引き継げる形にする |
| `session_id` | parent Session |
| `auxiliary_session_id` | parent Auxiliary Session。通常 Session では `NULL` |
| `phase` | `running` / `completed` / `failed` / `canceled` |
| `provider_id` | provider |
| `model_id` | model |
| `reasoning_effort` | reasoning depth |
| `approval_mode` | provider-neutral approval mode |
| `sandbox_mode` | Codex sandbox など。provider が sandbox を持たない場合は空値または `NULL` |
| `user_message_seq` | turn の user message seq |
| `assistant_message_seq` | final assistant message seq。未確定なら `NULL` |
| `thread_id` | provider thread / session id の短い snapshot |
| `summary` | 一覧・Details header 用の短い summary |
| `error_summary` | failure / cancel の短い表示用 error |
| `started_at` | turn 作成時刻 |
| `completed_at` | terminal 化時刻 |
| `updated_at` | 最終更新時刻 |

`session_turns_v6` は parent table であり、2 と 3 の detail table は `turn_id` でぶら下がる。

### New: `session_turn_interims_v6`

分類 2 の保存先。
completion 後も保持するが、通常 UI の main message list には出さず、Audit Log の Response detail 展開時だけ読む。

概念 schema:

| Column | Meaning |
| --- | --- |
| `id` | interim row id |
| `turn_id` | `session_turns_v6.id` |
| `seq` | turn 内順序 |
| `body` | 途中経過本文 |
| `source` | `stream_delta` / `running_snapshot` / `migration` |
| `created_at` | 作成時刻 |

同一 turn の最新途中経過だけでよい場合でも、table は append-only snapshot として持つ。
実行中 UI は Main Process live state を使い、DB から途中経過を polling しない。
terminal phase へ遷移したら live state 内の途中経過本文を破棄し、Details 展開時だけ `turn_id` で遅延取得する。

### New: `session_turn_provider_outputs_v6`

分類 3 の保存先。
provider output は種類が増えるため、単一 child table に `kind` と `payload` を持たせる。

概念 schema:

| Column | Meaning |
| --- | --- |
| `id` | output row id |
| `turn_id` | `session_turns_v6.id` |
| `seq` | turn 内順序 |
| `provider_id` | provider |
| `kind` | `operation` / `raw_items` / `usage` / `logical_prompt` / `transport_payload` / `provider_error` / `provider_metadata` など |
| `summary` | Details 折りたたみ header 用の短い summary |
| `payload_json` | 小さい payload |
| `payload_blob_id` | 大きい payload の blob 参照 |
| `created_at` | 作成時刻 |

大きな payload は DB `TEXT` へ入れず、blob 参照へ逃がす。
既存の V3 blob storage 方針と同じく、通常一覧・初期 hydrate は blob を読まない。

`kind = 'operation'` の `summary` は、Operations list を表示するための軽量 metadata として扱う。
初期実装では `{ type, summary }` の JSON を保存し、command / tool の詳細本文は `payload_json` にだけ保存する。
Audit Log の Operations section は `summary` だけを読み、個別 command の Details を開いた時だけ該当 operation row の `payload_json` を 1 件取得する。
これにより、完了後の main chat hydrate、Audit Log summary、Operations section 展開では command output / stdout / stderr / raw tool payload を memory に載せない。

## Relationship

```text
sessions_v6
  └ session_turns_v6                  -- 4. turn context
       ├ user_message_seq -> session_messages_v6.seq
       ├ assistant_message_seq -> session_messages_v6.seq
       ├ session_turn_interims_v6      -- 2. interim message
       └ session_turn_provider_outputs_v6 -- 3. provider output

session_messages_v6                   -- 1. final Session timeline
```

1 は Session timeline の一部なので、4 の単なる child ではない。
4 は 1 を参照し、2 と 3 を所有する。

## Provider Adapter Mapping

DB は Codex event type や Copilot SDK event type を直接中心にしない。
各 provider adapter は、provider-specific event を WithMate の分類へ変換して storage layer に渡す。

### Codex Adapter

| Codex / provider data | WithMate classification |
| --- | --- |
| `response.output_text.delta` 由来の実行中表示本文 | 2. Interim Message |
| `response.completed` / final item 由来の最終 assistant text | 1. Final Session Message |
| command / tool / file change / reasoning item | 3. Provider Output |
| usage / raw items / transport payload | 3. Provider Output |
| phase / model / approval / startedAt | 4. Turn Context |

### GitHub Copilot Adapter

| Copilot / provider data | WithMate classification |
| --- | --- |
| stream 中の assistant text 表示用 delta / progress | 2. Interim Message |
| top-level `assistant.message` から確定した assistant text | 1. Final Session Message |
| `tool.execution_*` / mutating tool trace | 3. Provider Output |
| `assistant.usage` / `assistant.usage.quotaSnapshots` | 3. Provider Output |
| `session.usage_info` | 3. Provider Output |
| permission request / elicitation request の provider trace | 3. Provider Output |
| `session.idle.backgroundTasks` / `system.notification` snapshot | 3. Provider Output |
| `client.rpc.account.getQuota()` の取得結果 | 3. Provider Output |
| phase / model / approval / custom agent / startedAt | 4. Turn Context |

Copilot の `assistant.message` が複数回届く場合、adapter は current runtime と同じく arrival 順に連結して final message 候補を作る。
ただし、DB は `assistant.message` という provider-native 名を正本にせず、final message と provider output に分けて保存する。

provider が途中 delta を返さず、completed item だけを返す場合、2 は作らず 1 だけを保存する。
現行ログで delta が確認できない provider 実行でも、この分類は成立する。
Copilot 固有の quota、context usage、background tasks は Session timeline の message ではないため、保存する場合は 3 の provider output として扱う。

### Unsupported Provider Responses

adapter がまだ分類できない provider response / event を受け取った場合、捨てずに `session_turn_provider_outputs_v6(kind='provider_metadata')` へ保存する。

- `summary` には provider 名、event / response type、短い reason を入れる。
- `payload_json` には後から mapper を追加できる範囲の bounded / redacted snapshot を入れる。
- secret、token、巨大本文、ローカル絶対 path は保存しない。必要なら blob 化または redaction する。
- App log JSONL には同じ未対応 response / event の発生を記録する。ただし payload 全文は出さず、provider、event / response type、turn id、summary、redaction 有無などの追跡用 metadata に限定する。
- main chat hydrate / summary hydrate では読まず、Audit Log の Raw / provider metadata detail を開いた時だけ読む。
- 後続実装で正式 classification が増えた場合は、この `provider_metadata` を migration source または regression fixture として使う。

## UI Read Model

通常 UI:

- Session 一覧: `sessions_v6` と必要な latest summary だけを読む。
- Session message list: `session_messages_v6` を読む。
- 実行中表示: Main Process live state の assistant 仮表示だけを使う。途中経過専用の永続 read は行わない。
- completion 後: Session message list には final response だけを残し、途中経過は renderer state / Main Process live state から破棄する。

Details / Audit:

- Turn header: `session_turns_v6`
- Response: final は `session_messages_v6`、途中経過は Response detail 展開時だけ `session_turn_interims_v6` から遅延取得する
- Operations: command / tool の list は `session_turn_provider_outputs_v6.summary` だけを読み、個別 operation Details 展開時だけ対象 row の `payload_json` を読む
- Raw / usage / prompt / transport: 各 detail section 展開時だけ該当 `session_turn_provider_outputs_v6` row を読む

UI の表示領域は read model として扱い、永続化 table の一次分類にはしない。
永続化は WithMate のデータ意味で分ける。

## Migration Feasibility

初回 migration は可能。
ただし、既存 raw data から完全に復元できるものと、推定または欠落を許容するものを分ける。

### Migration Source

主な migration source:

- `session_messages_v6`
- `audit_events_v6`
- `audit_events_v6.metadata_json`

現行 `audit_events_v6.metadata_json` には概ね次が入る。

- `phase`
- `provider`
- `model`
- `reasoningEffort`
- `approvalMode`
- `threadId`
- `logicalPrompt`
- `transportPayload`
- `assistantText`
- `operations`
- `rawItemsJson`
- `providerMetadata`
- `usage`
- `errorMessage`
- `sessionId`
- `createdAt`

### Directly Migratable

次は初回 migration で比較的安全に移せる。

| Source | Target |
| --- | --- |
| `audit_events_v6.id` | `session_turns_v6.id` |
| `audit_events_v6.session_id` | `session_turns_v6.session_id` |
| `audit_events_v6.auxiliary_session_id` | `session_turns_v6.auxiliary_session_id` |
| `metadata_json.phase` | `session_turns_v6.phase` |
| `metadata_json.provider` / `provider_id` | `session_turns_v6.provider_id` |
| `metadata_json.model` | `session_turns_v6.model_id` |
| `metadata_json.reasoningEffort` | `session_turns_v6.reasoning_effort` |
| `metadata_json.approvalMode` | `session_turns_v6.approval_mode` |
| `metadata_json.threadId` | `session_turns_v6.thread_id` |
| `metadata_json.errorMessage` | `session_turns_v6.error_summary` and provider output |
| `metadata_json.logicalPrompt` | `session_turn_provider_outputs_v6(kind='logical_prompt')` |
| `metadata_json.transportPayload` | `session_turn_provider_outputs_v6(kind='transport_payload')` |
| `metadata_json.operations` | `session_turn_provider_outputs_v6(kind='operation')` rows |
| `metadata_json.rawItemsJson` | `session_turn_provider_outputs_v6(kind='raw_items')` |
| `metadata_json.providerMetadata` | `session_turn_provider_outputs_v6(kind='provider_metadata')` rows |
| `metadata_json.usage` | `session_turn_provider_outputs_v6(kind='usage')` |

Copilot の quota / context telemetry / background task snapshot が既存 `transportPayload`、`operations`、`rawItemsJson`、`usage`、または adapter metadata に含まれている場合は、同じ `session_turn_provider_outputs_v6` に分解する。
既存 row に含まれない live-only telemetry は初回 migration では復元しない。

旧 V6 DB には `audit_events_v6.auxiliary_session_id` 列がない世代がある。
初回 migration はこの列の有無を検出し、存在しない場合は `NULL` として扱う。
この場合、旧 row は main Session の audit row として移行し、Auxiliary Session への推測補完は行わない。

### Partially Migratable

既存 `audit_events_v6.metadata_json.assistantText` は、現行 DB だけでは final response / interim snapshot / partial response の境界を信頼して復元できない。
そのため、初回 migration では `phase = 'completed'` の非空 `assistantText` だけを main assistant message として扱う。

- `session_messages_v6` の assistant message と完全一致する場合は、その `seq` を `session_turns_v6.assistant_message_seq` に設定する。
- `phase = 'completed'` の非空 `assistantText` は、`assistant_message_seq` の有無にかかわらず immutable audit snapshot として `legacy_assistant_text` provider output に保存する。
- `phase = 'completed'` で完全一致しない場合や一致が曖昧な場合は、起動時自動 migration では `session_messages_v6` へ追加しない。canonical timeline への追加は明示 repair の責務に分ける。
- `phase = 'completed'` でも `auxiliary_session_id` だけを持つ row は、main Session message に紐付けられないため `legacy_assistant_text` provider output に保存する。
- `background-completed` / `background-failed` / `background-canceled` は migration 時にそれぞれ `completed` / `failed` / `canceled` へ正規化する。
- `phase = 'running'` の非空 `assistantText` は main assistant message にはせず、`session_turn_interims_v6(source='migration')` に保存する。
- `phase = 'failed'` / `canceled` の非空 `assistantText` は main assistant message にはせず、`legacy_assistant_text` provider output に保存する。
- write path では、`phase = 'running'` の非空 `assistantText` を final response とは扱わず、重複を避けて `session_turn_interims_v6(source='running_snapshot')` に保存する。
- runtime write path の terminal phase では、completed の `assistantText` は final response として `session_messages_v6` に保存し、同時に audit snapshot として `legacy_assistant_text` provider output にも保存する。failed / canceled の partial response も `legacy_assistant_text` provider output に保存する。

### Not Reliably Migratable

次は既存 DB だけでは正確に復元できない場合がある。

- stream delta の chunk 境界
- provider event の正確な到着順
- running 中に上書き更新された過去の途中経過 snapshot
- final response と途中経過の差分履歴
- completed row の `assistantText` がどの `session_messages_v6` row から来たかの完全な対応
- Copilot live-only quota / context telemetry / background task snapshot

このため、初回 migration は「現在残っている latest state の再分類」として扱い、過去の streaming history を完全復元するものではない。

### Initial Migration Strategy

1. 新 table を追加する。
2. `audit_events_v6.event_type = 'session_turn'` を scan する。
   `auxiliary_session_id` 列が存在しない旧 table では、同列を `NULL` として扱う。
3. 各 audit row から `session_turns_v6` を作成する。
4. `phase = 'completed'` の非空 `assistantText` だけを main assistant message として扱う。
5. 既存 `session_messages_v6` の assistant message と完全一致する場合は `assistant_message_seq` を設定する。
6. `phase = 'completed'` の非空 `assistantText` は、照合成功時も含めて `legacy_assistant_text` provider output に保存する。完全一致しない、または一致が曖昧な `assistantText` は、起動時自動 migration では `session_messages_v6` へ追加しない。Auxiliary Session など main message に紐付けられない completed text も同じ扱いにする。
7. `phase = 'running'` の `assistantText` は `session_turn_interims_v6(source='migration')`、`failed` / `canceled` の `assistantText` は `legacy_assistant_text` provider output へ分ける。
8. `logicalPrompt` / `transportPayload` / `operations` / `rawItemsJson` / `usage` / `errorMessage` を `session_turn_provider_outputs_v6` に分解する。
9. migration marker を `app_settings` に保存し、再実行を idempotent にする。
10. orphan row として `session_id` / `auxiliary_session_id` をどちらも持たない audit row は移行しない。
11. 既存 `audit_events_v6` は移行ソースとしてだけ扱い、turn read / write path の切替後に削除する。
    ただし `event_type = 'session_turn'` 以外の row が残る場合は、この migration では移行も破棄もせず、destructive migration を拒否して source table と marker 未設定状態を残す。
12. V6 DB 内に legacy Memory table が残っている場合は、V6 正本へ持ち込まず削除する。
    `companion_*` table は現行Companion runtimeが参照するため、このmigrationでは削除しない。

初回 migration の write path は、`audit_events_v6` を削除する前に `session_turns_v6` / child table への投入を完了し、migration marker を保存する。
削除は同一 transaction 内で行い、途中失敗時に旧 source だけが消えないようにする。
invalid metadata JSON、`session_id` / `auxiliary_session_id` をどちらも持たない skipped row、または `event_type = 'session_turn'` 以外の未移行 row がある場合は、移行可能な valid `session_turn` row だけを非破壊で `session_turns_v6` へ投入する。
この場合、`audit_events_v6` と marker 未設定状態を残し、起動時 cleanup で source table を削除しない。
ただし legacy Memory table などの forbidden table cleanup は `audit_events_v6` source cleanup と独立して実行し、partial migration 状態でも V6 DB の valid 判定を維持する。
同じ DB で再実行されても、既に投入済みの `session_turns_v6.id` は重複投入しない。
skipped row が後続 repair や削除で解消された場合、既に投入済みの `session_turns_v6.id` は idempotent に扱い、未投入 row がなければ migration marker 設定と source cleanup へ進む。

初期実装では write migration の前に dry-run report を用意する。

```bash
npx tsx scripts/migrate-session-turn-storage-v6.ts --dry-run --v6 <path-to-withmate-v6.db>
```

dry-run は DB を更新せず、次を報告する。

- `audit_events_v6` の `session_turn` row 数
- 追加予定の `session_turns_v6` row 数
- 追加予定の main assistant message 数
- 追加予定の `session_turn_interims_v6` row 数
- `session_turn_provider_outputs_v6` の `kind` 別件数
- completed `assistantText` と `session_messages_v6` assistant message の照合成功/失敗数
- `event_type = 'session_turn'` 以外の未移行 audit row 数
- `session_id` / `auxiliary_session_id` を持たない orphan row 数
- 移行完了後に削除する `audit_events_v6` / legacy Memory table 候補
- migration で復元できない caveat

## Compatibility

移行直後は、read path を段階的に切り替える。

1. 起動時に migration marker がなく `audit_events_v6` が残っている V6 DB は、runtime storage を開く前に session turn storage へ移行する。
   skipped / unmigrated row により migration が拒否された場合は、起動を塞がず、旧 source table と marker 未設定状態を残して起動を継続する。
2. 新 table が存在する場合は `session_turns_v6` / child table を読む。
   migration 未完了または起動時 migration 失敗により `audit_events_v6` が残っている場合は、`session_turns_v6.id` に未投入の `event_type = 'session_turn'` row だけを legacy fallback として読む。
   fallback read でも `audit_events_v6.auxiliary_session_id` 列が存在しない旧 table は、同列を `NULL` として扱う。
3. 新 write path は `audit_events_v6` を新規作成せず、turn data を新 table へ直接保存する。
4. migration marker 済みの DB では `audit_events_v6` を削除してよい。

Audit Log の明示削除は transitional source にも適用する。
`clearAuditLogs()` は `session_turns_v6` に加えて、存在する場合だけ `audit_events_v6.event_type = 'session_turn'` も削除し、次回起動時に旧 source から削除済み audit が復活しないようにする。

`audit_events_v6` に残っていた Memory mutation / runtime binding / diagnostic は V6 current runtime の正本にしない。
ただし起動時自動 migration はこれらを暗黙に破棄しない。
`event_type = 'session_turn'` 以外の row が残る場合は migration を拒否し、明示的な削除または別途 repair / export の判断に分ける。

## Risks

| Risk | Mitigation |
| --- | --- |
| completed `assistantText` と `session_messages_v6` の対応が曖昧 | completed の非空 `assistantText` は常に `legacy_assistant_text` provider output に保存し、main assistant message への追加は照合成功時の参照または明示 repair に分ける |
| running row の途中経過が上書き済みで履歴が残らない | legacy migration は最新 snapshot だけを `session_turn_interims_v6(source='migration')` に保存し、main message へ混ぜない |
| 旧 `audit_events_v6` に新しい列がない | migration と legacy fallback read は table column を検出し、存在しない列は `NULL` として扱う。存在しない `auxiliary_session_id` は main Session row として移行または表示する |
| `audit_events_v6` に session turn 以外の row が残る | 起動時自動 migration では destructive cleanup を拒否し、source table と marker 未設定状態を残す |
| partial migration と legacy Memory table が同居し V6 が invalid 扱いになる | `audit_events_v6` source cleanup と forbidden table cleanup を独立させ、source table を残す場合でも cleanup 可能な forbidden table は削除する |
| 起動時 migration 失敗後に旧 audit が UI から不可視になる | migration 未完了時は `session_turns_v6` に未投入の `audit_events_v6.event_type = 'session_turn'` row を read fallback として扱う |
| Audit Log 削除後に旧 source から session turn audit が復活する | `clearAuditLogs()` は transitional `audit_events_v6.event_type = 'session_turn'` も削除する |
| completed audit が未保存の assistant message seq を参照する | runtime completed path は final assistant message を含む Session を先に保存し、その後に completed audit の `assistant_message_seq` を保存する |
| completed Session 保存後の audit 更新失敗で成功応答が failed 扱いになる | completed audit 更新だけの失敗は provider failure recovery に流さず、成功 Session を正本として返す。通常 completed audit の保存に失敗した場合は、最小 completed audit と `audit_persistence_degraded` provider metadata を再保存して診断可能にする |
| Session rewrite で `assistant_message_seq` の参照先が消える、または別 message へ変わる | completed audit は `assistant_message_seq` に加えて immutable `legacy_assistant_text` を保持し、Audit Log detail は fallback text を優先する |
| 未対応 provider response / event の payload が App log に複製される | App log JSONL は payload 全文を含めず、provider、kind、source、event / response type、summary、payload redacted / type などの追跡 metadata だけを記録する |
| provider output table に巨大 JSON が溜まる | summary + blob ref を正本にし、DB `TEXT` は小さい payload に限定する |
| UI が新旧 table を二重に読む | migration marker 後は新 table だけを読む |
| Session delete 時の cleanup 対象が増える | `session_turns_v6` を Session に cascade し、child table も cascade する |
| `audit_events_v6` 削除前に新 write path が未実装 | storage adapter を先に新 table へ切り替え、旧 table 依存を落としてから削除する |

## Non Goals

- provider stream packet の全量逐次保存
- 過去の delta chunk 境界の完全復元
- provider-specific event type を DB schema の正本にすること
- Session timeline と Details UI の表示分類を DB table 名へ直結させること
- V6 current runtime で使わない legacy audit row の保存

## Decisions

- `session_turn_interims_v6` は completion 後も保持する。ただし通常 UI / main message hydrate では読まず、Audit Log の Response detail 展開時だけ遅延取得する。
- 初期実装では `logicalPrompt` / `transportPayload` / `rawItemsJson` / `usage` / `provider_error` は `session_turn_provider_outputs_v6.payload_json` に保存する。blob 化は payload が肥大化した段階の follow-up とし、通常 UI と summary hydrate では `payload_json` を読まない。
- `sandbox_mode` / `user_message_seq` は取得できる場合は保存する。provider / runtime から信頼できる値が渡らない場合だけ空値または `NULL` を許容し、turn 保存や migration を失敗させない。
- 未対応 provider response / event は捨てず、bounded / redacted な `provider_metadata` として保存し、payload 全文を含めない追跡用 App log JSONL も残す。App log の data へは Audit Log 用 metadata をそのまま渡さず、payload を除いた summary-only metadata に変換する。

## Open Questions

- Auxiliary Session の final message を `session_messages_v6` と同じ扱いに寄せるか、Auxiliary 専用 message table が必要か。

## Implementation Slices

1. 新 schema と validation を追加する。Done: `session_turns_v6` / `session_turn_interims_v6` / `session_turn_provider_outputs_v6` を追加済み。
2. 初回 migration dry-run を追加し、件数、照合成功数、照合失敗数を報告する。Done: `scripts/migrate-session-turn-storage-v6.ts`。
3. 新 storage adapter を追加し、既存 `AuditLogStorageV6` の DTO を新 table から復元できるようにする。Done: summary / detail / section detail を `session_turns_v6` と child table から復元する。
4. write path を新 table へ切り替える。Done: `AuditLogStorageV6` は `audit_events_v6` を新規作成しない。
5. `phase = 'running'` の途中経過を `session_turn_interims_v6` に保存し、Response detail 展開時だけ返す。Done: final response は main response として分離し、running snapshot は `interimMessages` として遅延取得する。
6. `audit_events_v6.metadata_json` の turn detail 依存を削除する。Done: V6 storage read path は新 table を正本にし、migration 未完了時だけ `session_turns_v6` に未投入の legacy `session_turn` row を fallback として読む。
7. Operations section と個別 operation Details の read path を分離する。Done: Operations section は軽量 summary だけを返し、個別 Details 展開時だけ operation payload を 1 件読む。
8. migration で作成または照合した main assistant message を Audit Log detail / summary で復元する。Done: completed snapshot と terminal partial は `legacy_assistant_text` provider output から復元し、`assistant_message_seq` は main message 参照として保持する。
9. provider / runtime から取得できる `sandbox_mode` / `user_message_seq` を write path に接続する。Done: 値がない provider では空値 / `NULL` を許容する。
10. 未対応 provider response / event を `provider_metadata` provider output と App log JSONL に保存する。Done: adapter ごとに bounded snapshot、summary、App log metadata を残す。
11. write migration を実行し、成功後に `audit_events_v6` と legacy Memory table を削除する。Done: migration script は同一 transaction で新 table へ投入し、`audit_events_v6` と legacy Memory table を削除する。`companion_*` table は現行 runtime が使うため残す。

## Validation Strategy

- schema test: 新 table / index / FK / CHECK が存在すること。
- migration dry-run test: `audit_events_v6.metadata_json` から分類件数を報告できること。
- migration write test: completed / running / failed / canceled の代表 row を再分類でき、migration 後の Audit Log summary / detail で assistant text が復元できること。
- storage roundtrip test: 旧 `AuditLogEntry` 相当の summary / detail / section detail を新 table から復元できること。
- operation detail lazy-load test: Operations section では command details を返さず、個別 operation Details API だけが details を返すこと。
- optional context test: `sandbox_mode` / `user_message_seq` は値がある場合に保存され、値がない場合も turn 保存が成功すること。
- unsupported provider metadata test: 未対応 provider response / event が `provider_metadata` として保存され、App log JSONL に payload 全文なしの追跡 metadata が残り、summary hydrate では payload を読まず、detail 展開で取得できること。
- UI projection test: Session 一覧と message list が provider output を読まずに表示できること。
- cleanup test: Session delete で turn / interim / provider output が消えること。
