# Database Schema

- 作成日: 2026-03-27
- 更新日: 2026-04-27
- 対象: WithMate の current 保存構造

## Goal

WithMate が現在どこに何を保存しているかを、1 枚で把握できるようにする。  
特に、SQLite 内の table、JSON カラム、DB 外保存の `characters/` をまとめて読めることを目的にする。

## Maintenance Policy

- 永続化構造、SQLite schema、JSON カラム、DB 外保存の責務に変更がある task では、この文書を同じ task の中で更新する
- current 実装と future design を混ぜない
- future design しかない項目は `Current / Future Boundary` に分けて書く
- service 責務、IPC、window lifecycle の説明はこの文書で持たず、`electron-session-store.md`、`session-run-lifecycle.md`、`electron-window-runtime.md` に分ける

## Scope

この文書は current 実装を対象にする。

2026-04-27 時点では、V1 `withmate.db` と V2 `withmate-v2.db` を分ける方針で進める。V1 schema の SQL 正本は `src-electron/database-schema-v1.ts` に切り出し済みで、V2 schema の SQL 正本は `src-electron/database-schema-v2.ts` に置く。V2 migration 方針は `docs/design/database-v2-migration.md` を正本にする。

- SQLite DB に存在する table
- DB 外の file-based storage
- reset 対象と reset 非対象

future design だけで未実装のものは、最後に別枠で注記する。

## Storage Overview

### DB 本体

- 保存先:
  - `<userData>/withmate.db`
  - `<userData>/withmate-v2.db`
- V1 schema source:
  - `src-electron/database-schema-v1.ts`
- V2 schema source:
  - `src-electron/database-schema-v2.ts`
- V2 migration policy:
  - `docs/design/database-v2-migration.md`
- driver:
  - Node 標準の `node:sqlite`
- 共通設定:
  - `PRAGMA journal_mode = WAL`
  - `PRAGMA wal_autocheckpoint = 256`
  - `PRAGMA journal_size_limit = 67108864`
  - `PRAGMA busy_timeout = 5000`
  - `PRAGMA foreign_keys = ON`
- WAL maintenance:
  - 全 SQLite connection は `src-electron/sqlite-connection.ts` の共通 helper で初期化する
  - app 起動中は Main Process が 5 分ごとに選択中 DB の `-wal` file size を確認し、64 MiB を超えていれば短い `busy_timeout = 250` で `PRAGMA wal_checkpoint(TRUNCATE)` を実行する
  - app 終了時と DB 再生成前にも `PRAGMA wal_checkpoint(TRUNCATE)` を実行し、選択中 DB の WAL 肥大化を抑制する
  - WAL truncate は実行前に共通接続設定を適用し、DB が WAL mode でない状態からでも `journal_mode = WAL` へ戻してから checkpoint する

### DB 外保存

- character catalog:
  - `<userData>/characters/`

## V1 Current Source Of Truth

| Domain | Source Of Truth | Notes |
| --- | --- | --- |
| Session 一覧 / session metadata | `sessions` | message / stream もここに JSON 保存 |
| Session Memory | `session_memories` | `sessions.id` と 1:1 |
| Audit Log | `audit_logs` | 通常 turn と legacy background task を同居 |
| App Settings | `app_settings` | key-value 方式 |
| Model Catalog | `model_catalog_*` | revision 管理あり |
| Character Memory | `character_scopes` / `character_memory_entries` | character 単位の関係性記憶 |
| Characters | `<userData>/characters/` | DB ではなく file system |

## V2 Source Of Truth

V2 `withmate-v2.db` は、一覧と詳細 payload を分離する。V1 `withmate.db` は legacy data として残し、通常起動では破壊的 migration を実行しない。

runtime は `withmate-v2.db` が存在する場合に V2 を正本として選ぶ。V2 が存在しない V1-only install では引き続き `withmate.db` を開く。起動時に V1 -> V2 migration script は暗黙実行しない。

V2 DB を開く場合、runtime は V2 必須 table の存在を確認する。空または未完成の `withmate-v2.db` は選択せず、V1 `withmate.db` があれば V1 を開く。

lifecycle は V1 の `SessionStorage` / `AuditLogStorage` を生成せず、`SessionStorageV2` / `AuditLogStorageV2` を V2 storage として使う。V2 runtime write-path は session / audit log の既存 write-capable method を V2 split schema へ保存する。

V2 DB では legacy memory table を作らない。`SessionMemoryStorageV2Read` / `ProjectMemoryStorageV2Read` / `CharacterMemoryStorageV2Read` は read-only/no-op adapter として使い、MemoryGeneration / Character Reflection の legacy storage を V2 schema に再導入しない。

| Domain | V2 Source Of Truth | Notes |
| --- | --- | --- |
| Session 一覧 / session metadata | `sessions` | `messages_json` / `stream_json` は持たない |
| Session messages | `session_messages` | 1 message = 1 row |
| Session message artifacts | `session_message_artifacts` | 重い artifact payload は message row から分離 |
| Audit Log 一覧 | `audit_logs` | summary / preview / counters のみ |
| Audit Log 詳細 | `audit_log_details` | prompt / payload / assistant text / raw items |
| Audit Log operations | `audit_log_operations` | 1 operation = 1 row |
| App Settings | `app_settings` | legacy MemoryGeneration / Character Reflection key は migration 対象外 |
| Model Catalog | `model_catalog_*` | revision 管理あり |
| Characters | `<userData>/characters/` | DB ではなく file system |

V2 正本 schema には `session_memories`、`project_scopes`、`project_memory_entries`、`character_scopes`、`character_memory_entries`、`sessions.stream_json` を含めない。

V2 の table detail と migration mapping は `docs/design/database-v2-migration.md` を正本にする。この文書の V1 current section にある `messages_json`、`stream_json`、`audit_logs` の detail JSON 列は V1 互換説明であり、V2 schema では使わない。

V2 read-path は V2 split table から既存 `SessionSummary` / `Session` shape を復元する。V2 には monologue legacy `stream_json` がないため、`Session.stream` は `[]` として復元する。audit log modal 初期表示では `AuditLogSummary[]` を返し、`audit_logs` と `audit_log_operations` だけを読む。Logical Prompt / Transport Payload / Response / Raw Items などの詳細は `getSessionAuditLogDetail(sessionId, auditLogId)` で対象 row だけを遅延取得する。既存互換用の `listSessionAuditLogs(sessionId)` は `AuditLogEntry[]` を復元するが、UI の初期表示経路では使わない。

## V1 Current Table Summary

| Table | Primary Key | Purpose |
| --- | --- | --- |
| `sessions` | `id` | Session 本体、message 履歴、UI 再開に必要な metadata |
| `session_memories` | `session_id` | `Session Memory v1` の正本 |
| `audit_logs` | `id` | turn 実行と legacy background task の監査ログ |
| `app_settings` | `setting_key` | app 共通設定 |
| `model_catalog_revisions` | `revision` | model catalog revision 管理 |
| `model_catalog_providers` | `(revision, provider_id)` | revision ごとの provider 定義 |
| `model_catalog_models` | `(revision, provider_id, model_id)` | revision ごとの model 定義 |
| `project_scopes` | `id` | Project Memory の anchor |
| `project_memory_entries` | `id` | project 単位の durable knowledge |
| `character_scopes` | `id` | Character Memory の anchor |
| `character_memory_entries` | `id` | character 単位の関係性記憶 |

## V1 Current Table Details

### `sessions`

Session の正本。  
1 row が 1 session を表す。

主なカラム:

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `TEXT` | session id |
| `task_title` | `TEXT` | session title |
| `task_summary` | `TEXT` | Home 一覧用の短い summary |
| `status` | `TEXT` | `running` / `idle` / `saved` |
| `updated_at` | `TEXT` | UI 表示用更新時刻 |
| `provider` | `TEXT` | `codex` / `copilot` など |
| `catalog_revision` | `INTEGER` | 適用中 model catalog revision |
| `workspace_label` | `TEXT` | 表示用 workspace 名 |
| `workspace_path` | `TEXT` | 作業ディレクトリ |
| `branch` | `TEXT` | branch 表示用文字列 |
| `session_kind` | `TEXT` | session 用途 (`default` / `character-update`) |
| `character_id` | `TEXT` | character id |
| `character_name` | `TEXT` | session snapshot としての character 名 |
| `character_icon_path` | `TEXT` | session snapshot としての icon path |
| `character_theme_main` | `TEXT` | session snapshot のテーマ色 main |
| `character_theme_sub` | `TEXT` | session snapshot のテーマ色 sub |
| `run_state` | `TEXT` | 実行状態の短い表示値 |
| `approval_mode` | `TEXT` | approval mode |
| `model` | `TEXT` | 現在選択中 model |
| `reasoning_effort` | `TEXT` | 現在選択中 reasoning depth |
| `custom_agent_name` | `TEXT` | Copilot custom agent 名 |
| `allowed_additional_directories_json` | `TEXT` | 許可済み追加 directory 一覧 |
| `thread_id` | `TEXT` | provider thread / session id |
| `messages_json` | `TEXT` | message 履歴 |
| `stream_json` | `TEXT` | stream 履歴。既存 monologue entry が残る場合がある |
| `last_active_at` | `INTEGER` | recent session 並び順用 timestamp |

JSON カラム:

#### `allowed_additional_directories_json`

```json
[
  "F:/workspace/shared-docs",
  "F:/workspace/assets"
]
```

#### `messages_json`

`Message[]` をそのまま保存する。

```json
[
  {
    "role": "user",
    "text": "Copilot の memory 設計を整理して"
  },
  {
    "role": "assistant",
    "text": "方針をまとめたよ",
    "artifact": {
      "title": "実行結果",
      "activitySummary": ["docs を更新"],
      "changedFiles": []
    }
  }
]
```

#### `stream_json`

`StreamEntry[]` を保存する。current runtime では monologue を新規追記しない。過去バージョンで `character reflection cycle` が生成した monologue entry が残る場合がある。

```json
[
  {
    "mood": "calm",
    "time": "10:24",
    "text": "次は memory を詰めよう"
  }
]
```

補足:

- `sessions` は schema migration を持つ
- 後から追加された column:
  - `model`
  - `reasoning_effort`
  - `catalog_revision`
  - `custom_agent_name`
  - `allowed_additional_directories_json`
  - `character_theme_main`
  - `character_theme_sub`

### `session_memories`

`Session Memory v1` の正本。  
`sessions.id` と 1:1 で紐づく。

主なカラム:

| Column | Type | Meaning |
| --- | --- | --- |
| `session_id` | `TEXT` | `sessions.id` を参照する主キー |
| `workspace_path` | `TEXT` | session の workspace |
| `thread_id` | `TEXT` | provider thread id |
| `schema_version` | `INTEGER` | 現在は `1` |
| `goal` | `TEXT` | session の目的 |
| `decisions_json` | `TEXT` | decision 一覧 |
| `open_questions_json` | `TEXT` | 未解決論点 |
| `next_actions_json` | `TEXT` | 次アクション |
| `notes_json` | `TEXT` | 補助メモ |
| `updated_at` | `TEXT` | 最終更新時刻 |

JSON カラム:

```json
{
  "decisions_json": ["Copilot では Character Memory を main prompt に入れない"],
  "open_questions_json": ["Project Memory retrieval の threshold をどうするか"],
  "next_actions_json": ["Project Memory の保存設計を実装する"],
  "notes_json": ["ユーザーは Character Stream 本体をまだ実装しない前提"]
}
```

補足:

- row が無い場合は session 作成時に default memory を生成する
- `session_id` は `sessions(id) ON DELETE CASCADE`

### `audit_logs`

turn 実行の監査ログ。  
通常 turn と legacy background memory / character reflection log の両方を保持できる。current runtime では MemoryGeneration / Character Reflection / Monologue の background log を新規作成しない。

主なカラム:

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `INTEGER` | audit log id |
| `session_id` | `TEXT` | 対象 session |
| `created_at` | `TEXT` | 作成時刻 |
| `phase` | `TEXT` | 実行 phase |
| `provider` | `TEXT` | provider |
| `model` | `TEXT` | model |
| `reasoning_effort` | `TEXT` | reasoning depth |
| `approval_mode` | `TEXT` | approval mode snapshot |
| `thread_id` | `TEXT` | provider thread id |
| `logical_prompt_json` | `TEXT` | logical prompt |
| `transport_payload_json` | `TEXT` | transport payload summary |
| `assistant_text` | `TEXT` | assistant text |
| `operations_json` | `TEXT` | operation timeline |
| `raw_items_json` | `TEXT` | provider raw item 群 |
| `usage_json` | `TEXT` | token usage |
| `error_message` | `TEXT` | error text |

`phase` の代表値:

- 通常 turn:
  - `running`
  - `completed`
  - `failed`
  - `canceled`
- background task:
  - `background-running`
  - `background-completed`
  - `background-failed`
  - `background-canceled`

JSON カラム:

#### `logical_prompt_json`

```json
{
  "systemText": "# System Prompt\n...",
  "inputText": "# User Input\n...",
  "composedText": "# System Prompt\n...\n# User Input\n..."
}
```

#### `transport_payload_json`

```json
{
  "summary": "Copilot systemMessage + send prompt",
  "fields": [
    { "label": "systemMessage", "value": "..." },
    { "label": "sendPrompt", "value": "..." }
  ]
}
```

#### `operations_json`

```json
[
  {
    "type": "tool",
    "summary": "powershell を実行",
    "details": "npm run build"
  }
]
```

#### `usage_json`

```json
{
  "inputTokens": 1820,
  "cachedInputTokens": 640,
  "outputTokens": 248
}
```

補足:

- `session_id` は `sessions(id) ON DELETE CASCADE`
- current schema は `logical_prompt_json` / `transport_payload_json` へ移行済み

### `app_settings`

app 共通設定の key-value table。

主なカラム:

| Column | Type | Meaning |
| --- | --- | --- |
| `setting_key` | `TEXT` | 設定キー |
| `setting_value` | `TEXT` | 設定値 |
| `updated_at` | `TEXT` | 更新時刻 |

current 実装の key:

| setting_key | Meaning |
| --- | --- |
| `system_prompt_prefix` | app 共通の system prompt prefix |
| `coding_provider_settings_json` | coding plane provider 設定 |
| `memory_extraction_provider_settings_json` | memory extraction provider 設定 |
| `character_reflection_provider_settings_json` | character reflection provider 設定 |

補足:

- `memory_extraction_provider_settings_json` と `character_reflection_provider_settings_json` は互換用の legacy key として残る場合がある
- current UI では MemoryGeneration / Character Reflection 設定を表示しない
- current runtime ではこれらの設定を参照して background task を起動しない

`coding_provider_settings_json` の例:

```json
{
  "codex": {
    "enabled": true,
    "apiKey": "",
    "skillRootPath": ""
  },
  "copilot": {
    "enabled": true,
    "apiKey": "",
    "skillRootPath": ""
  }
}
```

`memory_extraction_provider_settings_json` の例:

```json
{
  "codex": {
    "model": "gpt-5.4-mini",
    "reasoningEffort": "medium",
    "outputTokensThreshold": 300000,
    "timeoutSeconds": 180
  },
  "copilot": {
    "model": "gpt-5.4-mini",
    "reasoningEffort": "medium",
    "outputTokensThreshold": 300000,
    "timeoutSeconds": 180
  }
}
```

`character_reflection_provider_settings_json` の例:

```json
{
  "codex": {
    "model": "gpt-5.4-mini",
    "reasoningEffort": "medium",
    "timeoutSeconds": 180
  },
  "copilot": {
    "model": "gpt-5.4-mini",
    "reasoningEffort": "medium",
    "timeoutSeconds": 180
  }
}
```

### `model_catalog_revisions`

model catalog の revision 管理 table。

| Column | Type | Meaning |
| --- | --- | --- |
| `revision` | `INTEGER` | revision id |
| `source` | `TEXT` | `bundled` / `imported` / `rollback` |
| `imported_at` | `TEXT` | import 時刻 |
| `is_active` | `INTEGER` | active revision flag |

### `model_catalog_providers`

revision ごとの provider 定義。

| Column | Type | Meaning |
| --- | --- | --- |
| `revision` | `INTEGER` | revision |
| `provider_id` | `TEXT` | provider id |
| `label` | `TEXT` | UI 表示名 |
| `default_model_id` | `TEXT` | provider default model |
| `default_reasoning_effort` | `TEXT` | provider default reasoning |
| `sort_order` | `INTEGER` | 並び順 |

### `model_catalog_models`

revision ごとの model 定義。

| Column | Type | Meaning |
| --- | --- | --- |
| `revision` | `INTEGER` | revision |
| `provider_id` | `TEXT` | provider id |
| `model_id` | `TEXT` | model id |
| `label` | `TEXT` | UI 表示名 |
| `reasoning_efforts_json` | `TEXT` | 許可される reasoning depth |
| `sort_order` | `INTEGER` | 並び順 |

`reasoning_efforts_json` の例:

```json
["minimal", "low", "medium", "high"]
```

### `project_scopes`

Project Memory の anchor table。

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `TEXT` | project scope id |
| `project_type` | `TEXT` | `git` or `directory` |
| `project_key` | `TEXT` | canonical key |
| `workspace_path` | `TEXT` | session 起点の workspace path |
| `git_root` | `TEXT` | git root |
| `git_remote_url` | `TEXT` | future 用の補助情報 |
| `display_name` | `TEXT` | 表示名 |
| `created_at` | `TEXT` | 初回作成時刻 |
| `updated_at` | `TEXT` | 最終同期時刻 |

補足:

- `project_key` は `git:<path>` または `directory:<path>` の形で一意にする
- current 実装では `gitRemoteUrl` は `null` 許容のまま保持する

### `project_memory_entries`

Project Memory entry の本体 table。

legacy 実装では、`Session Memory` extraction の結果から次だけを昇格保存していた。

- `decisions`
  - 常に `decision`
- `notes`
  - `constraint:` / `convention:` / `context:` / `deferred:` prefix を持つものだけ対応 category へ昇格

`goal` / `openQuestions` / `nextActions` は current slice では保存しない。

current runtime では turn 完了後の自動昇格と coding plane prompt への再注入を行わない。
legacy retrieval で使われた `last_used_at` は既存データとして残る場合がある。

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `TEXT` | entry id |
| `project_scope_id` | `TEXT` | `project_scopes.id` |
| `source_session_id` | `TEXT` | 昇格元 session |
| `category` | `TEXT` | `decision / constraint / convention / context / deferred` |
| `title` | `TEXT` | 短い題名 |
| `detail` | `TEXT` | durable knowledge 本文 |
| `keywords_json` | `TEXT` | 検索補助キーワード |
| `evidence_json` | `TEXT` | 根拠参照 |
| `created_at` | `TEXT` | 作成時刻 |
| `updated_at` | `TEXT` | 最終更新時刻 |
| `last_used_at` | `TEXT` | retrieval 利用時刻 |

JSON カラム:

```json
{
  "keywords_json": ["memory", "project", "prompt"],
  "evidence_json": ["docs/design/memory-architecture.md"]
}
```

### `character_scopes`

Character Memory の anchor table。

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `TEXT` | character scope id |
| `character_id` | `TEXT` | character id |
| `display_name` | `TEXT` | 表示名 |
| `created_at` | `TEXT` | 初回作成時刻 |
| `updated_at` | `TEXT` | 最終同期時刻 |

補足:

- `character_id` は一意で、同じ character の scope を再利用する
- current 実装では session の保存時と app 起動時に scope を同期する

### `character_memory_entries`

Character Memory entry の本体 table。

legacy v1 では `character reflection cycle` が `CharacterMemoryDelta` をこの table へ保存していた。
current runtime では background reflection を実行せず、新規 entry を自動保存しない。
legacy retrieval で使われた `last_used_at` は既存データとして残る場合がある。

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `TEXT` | entry id |
| `character_scope_id` | `TEXT` | `character_scopes.id` |
| `source_session_id` | `TEXT` | 元になった session |
| `category` | `TEXT` | `preference / relationship / shared_moment / tone / boundary` |
| `title` | `TEXT` | 短い題名 |
| `detail` | `TEXT` | 関係性記憶の本文 |
| `keywords_json` | `TEXT` | 検索補助キーワード |
| `evidence_json` | `TEXT` | 根拠参照 |
| `created_at` | `TEXT` | 作成時刻 |
| `updated_at` | `TEXT` | 最終更新時刻 |
| `last_used_at` | `TEXT` | retrieval 利用時刻 |

JSON カラム:

```json
{
  "keywords_json": ["距離感", "友人"],
  "evidence_json": ["docs/design/character-memory-storage.md"]
}
```
```

## DB Outside: Characters

character は SQLite ではなく file system に保存する。

保存先:

```text
<userData>/
  characters/
    <character-id>/
      meta.json
      character.md
      character-notes.md
      character.png
``` 

構成:

| File | Meaning |
| --- | --- |
| `meta.json` | 一覧表示と軽量 metadata |
| `character.md` | role の正本 |
| `character-notes.md` | 採用理由、出典、保留事項、改稿履歴 |
| `character.png` | icon |

`meta.json` の代表項目:

```json
{
  "id": "sample-character",
  "name": "Sample Character",
  "description": "Home 一覧用の説明",
  "theme": {
    "main": "#6f8cff",
    "sub": "#6fb8c7"
  },
  "sessionCopy": {
    "pendingApproval": ["確認中"],
    "pendingWorking": ["処理中"]
  },
  "iconFile": "character.png",
  "roleFile": "character.md",
  "createdAt": "2026-03-27T10:00:00.000Z",
  "updatedAt": "2026-03-27T10:00:00.000Z"
}
```

## Reset Policy

Settings の `DB を初期化` で対象にできるのは次の 6 系統。

- `sessions`
- `audit logs`
- `app settings`
- `model catalog`
- `project memory`
- `character memory`

補足:

- `sessions` を選ぶと `audit logs` も同伴する
- `characters` は DB 外保存なので reset 対象外
- `session_memories` は `sessions` に従属して一緒に消える前提で扱う

## Current / Future Boundary

### Current 実装

- `sessions`
- `session_memories`
- `audit_logs`
- `app_settings`
- `model_catalog_revisions`
- `model_catalog_providers`
- `model_catalog_models`
- `project_scopes`
- `project_memory_entries`
- `character_scopes`
- `character_memory_entries`
- `<userData>/characters/`

### V2 migration target

`src-electron/database-schema-v2.ts` で固定した V2 schema は、次の table を持つ。

- `sessions`
- `session_messages`
- `session_message_artifacts`
- `audit_logs`
- `audit_log_details`
- `audit_log_operations`
- `app_settings`
- `model_catalog_revisions`
- `model_catalog_providers`
- `model_catalog_models`

V2 では Home 一覧と audit log modal 初期表示で巨大 JSON を読まない。session message 本文と audit detail payload は、session 選択時または detail 展開時に遅延取得する。

### Future design only

まだ未実装だが design があるもの:

- `project_memory_entry_links`
- FTS / embedding 系 index

詳細は `docs/design/project-memory-storage.md` を参照する。

## Reading Order

最初に全体を掴むなら、この順で読むと分かりやすい。

1. 本書
2. `docs/design/electron-session-store.md`
3. `docs/design/audit-log.md`
4. `docs/design/model-catalog.md`
5. `docs/design/character-storage.md`
6. `docs/design/project-memory-storage.md`
7. `docs/design/character-memory-storage.md`
