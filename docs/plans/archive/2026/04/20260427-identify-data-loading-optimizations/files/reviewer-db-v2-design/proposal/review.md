# V2 DB 設計完了 slice レビュー

- 対象: V2 DB 設計完了 slice
- 実施日: 2026-04-27
- レビュー種別: correctness / regression / design drift / test coverage

## Findings

### 1. V2 filename / schema version の正本が `database-schema-v2.ts` に置かれていない

- Severity: Medium
- Scope: same-plan
- 対象:
  - `src-electron/database-schema-v2.ts:3`
  - `src-electron/database-schema-v1.ts:5`
  - `src-electron/database-schema-v1.ts:7`
  - `docs/plans/20260427-identify-data-loading-optimizations/files/planner-db-v2-design-retry1/proposal/design.md:198`

`database-schema-v2.ts` は `APP_DATABASE_V2_FILENAME` と `APP_DATABASE_V2_SCHEMA_VERSION` を自ファイルで定義せず、`database-schema-v1.ts` から import / re-export している。設計 proposal は `src-electron/database-schema-v2.ts` に V2 API 定数を置く前提で、`docs/design/database-v2-migration.md` も V1 / V2 schema source を分ける方針を示している。

このままだと、V2 正本を確認する読者や次 slice の実装者が V2 の version / filename 正本を V1 module に見に行く必要があり、V1 schema source の責務が V2 へ漏れる。SQL DDL の実害はまだないが、V2 migration script 実装前に正本境界を戻すべき。

Recommendation:

- same-plan で `APP_DATABASE_V2_FILENAME` / `APP_DATABASE_V2_SCHEMA_VERSION` を `src-electron/database-schema-v2.ts` に移す。
- `src-electron/database-schema-v1.ts` は V1 filename / version のみを export する。
- `scripts/tests/database-schema-v2.test.ts` で `APP_DATABASE_V2_SCHEMA_VERSION === 2` も固定する。

### 2. `database-schema.md` の V1 / V2 境界が曖昧で、V2 方針と同じ文書内で衝突して読める

- Severity: Medium
- Scope: same-plan
- 対象:
  - `docs/design/database-schema.md:14`
  - `docs/design/database-schema.md:15`
  - `docs/design/database-schema.md:74`
  - `docs/design/database-schema.md:88`
  - `docs/design/database-schema.md:90`
  - `docs/design/database-schema.md:94`
  - `docs/design/database-schema.md:140`
  - `docs/design/database-schema.md:141`
  - `docs/design/database-schema.md:239`
  - `docs/design/database-schema.md:257`
  - `docs/design/database-schema.md:260`
  - `docs/design/database-schema.md:261`
  - `docs/design/database-schema.md:262`

`database-schema.md` は maintenance policy で current 実装と future design を混ぜないとしているが、V2 Source Of Truth では `sessions.stream_json` を含めないと書いた直後に、無印の Table Summary / Table Details が `sessions` に message 履歴や `messages_json` / `stream_json` を持つ形を説明している。`audit_logs` も summary / detail 分離後の V2 ではなく、detail JSON 列を同一 table に持つ V1 形の説明のままになっている。

内容自体は V1 current の説明としては成立するが、見出しが V1 と明示されていないため、V2 設計完了後の正本 docs としては設計 drift を誘発する。次 slice で V2 storage / migration script を実装する際、どの table detail が V2 正本なのかを誤読しやすい。

Recommendation:

- same-plan で `Source Of Truth` / `Table Summary` / `Table Details` を V1 current と明示する。
- V2 の詳細列は `docs/design/database-v2-migration.md` を正本にするか、`database-schema.md` に V2 table summary だけを置いて詳細は migration doc へ誘導する。
- どちらにしても `sessions.messages_json` / `sessions.stream_json` と `audit_logs.logical_prompt_json` などの detail JSON が V2 の table detail に見えない構成へ直す。

### 3. V2 schema test が exact contract ではなく subset / 一部 negative 固定に寄っている

- Severity: Low
- Scope: same-plan
- 対象:
  - `scripts/tests/database-schema-v2.test.ts:64`
  - `scripts/tests/database-schema-v2.test.ts:82`
  - `scripts/tests/database-schema-v2.test.ts:83`
  - `scripts/tests/database-schema-v2.test.ts:90`

現テストは V2 schema の作成、table 一覧、`sessions.messages_json` / `sessions.stream_json` 不在、legacy tables 不在を固定しており、今回の主要設計意図は押さえている。一方で summary column 定数は table column の subset であることだけを見ており、V2 summary contract の exactness は固定していない。

特に audit log は `logical_prompt_json` / `transport_payload_json` / `operations_json` / `raw_items_json` の不在は見るが、detail payload である `assistant_text` / `usage_json` が `audit_logs` に混入してもこのテストでは落ちない。設計固定テストとしては、次 slice の query 実装前に contract をもう一段固定した方がよい。

Recommendation:

- same-plan で `audit_logs` に detail payload column が混入していないことを full negative list で固定する。
- `audit_log_details` は `logical_prompt_json` / `transport_payload_json` / `assistant_text` / `operations_json` / `raw_items_json` / `usage_json` を exact set として固定する。
- `V2_SESSION_SUMMARY_COLUMNS` / `V2_AUDIT_LOG_SUMMARY_COLUMNS` は「一覧 API が読む列」として exact expectation を持たせるか、table columns と意図的に異なるならコメントかテスト名で役割を明確化する。

## Same-Plan Recommendation

次 slice へ進む前に、同一 plan 内で次を直すべき。

1. `APP_DATABASE_V2_FILENAME` / `APP_DATABASE_V2_SCHEMA_VERSION` の正本を `src-electron/database-schema-v2.ts` に移す。
2. `docs/design/database-schema.md` の V1 current と V2 future / migration target の境界を明示する。
3. `scripts/tests/database-schema-v2.test.ts` を exact contract 寄りに強化し、audit detail payload の混入をより広く検出する。

理由: いずれも V2 DB 設計完了 slice の正本性と固定テストに直接関わる。migration script や V2 storage 実装に入る前に直す方が、後続 slice の前提が安定する。

## New-Plan Recommendation

このレビュー範囲で new-plan follow-up に分けるべき追加問題はない。

V2 migration script 実装、session storage V2 化、audit log paging / detail lazy loading、Memory Management API 分割は既に plan の残タスクとして独立 slice になっている。今回の findings はそれらの実装前提を固める同一 plan 内の補正で足りる。

## 確認結果

- `sessions` は header table、`session_messages` は message detail table として分離されている。
- `audit_logs` は summary / preview / counter table、`audit_log_details` は detail payload table として分離されている。
- V2 DDL に `session_memories`、`project_scopes`、`project_memory_entries`、`character_scopes`、`character_memory_entries`、`monologue` table、`sessions.stream_json` は含まれていない。
- `docs/design/database-v2-migration.md` と `docs/design/data-loading-performance-audit.md` は V2 方針と概ね一致している。
- `design_proposal_path` は明示されていないため、利用可能な proposal evidence として `docs/plans/20260427-identify-data-loading-optimizations/files/planner-db-v2-design-retry1/proposal/design.md` を確認した。

## 検証

- `npx tsx --test scripts/tests/database-schema-v2.test.ts`: pass

