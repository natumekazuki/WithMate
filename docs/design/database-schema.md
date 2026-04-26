# Database Schema

- 作成日: 2026-03-27
- 更新日: 2026-04-26
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

- SQLite DB に存在する table
- DB 外の file-based storage
- reset 対象と reset 非対象

future design だけで未実装のものは、最後に別枠で注記する。

## Storage Overview

### DB 本体

- 保存先:
  - `<userData>/withmate.db`
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
  - app 起動中は Main Process が 5 分ごとに `withmate.db-wal` の size を確認し、64 MiB を超えていれば短い `busy_timeout = 250` で `PRAGMA wal_checkpoint(TRUNCATE)` を実行する
  - app 終了時と DB 再生成前にも `PRAGMA wal_checkpoint(TRUNCATE)` を実行し、`withmate.db-wal` の肥大化を抑制する
  - WAL truncate は実行前に共通接続設定を適用し、DB が WAL mode でない状態からでも `journal_mode = WAL` へ戻してから checkpoint する

### DB 外保存

- character catalog:
  - `<userData>/characters/`

## Source Of Truth

| Domain | Source Of Truth | Notes |
| --- | --- | --- |
| Session 一覧 / session metadata | `sessions` | message / stream もここに JSON 保存 |
| Session Memory | `session_memories` | `sessions.id` と 1:1 |
| Audit Log | `audit_logs` | 通常 turn と background task を同居 |
| App Settings | `app_settings` | key-value 方式 |
| Model Catalog | `model_catalog_*` | revision 管理あり |
| Character Memory | `character_scopes` / `character_memory_entries` | character 単位の関係性記憶 |
| Characters | `<userData>/characters/` | DB ではなく file system |
| Companion Mode | `companion_groups` / `companion_sessions` / `companion_merge_runs` | Git repo root 単位の Companion 作業単位 |

## Table Summary

| Table | Primary Key | Purpose |
| --- | --- | --- |
| `sessions` | `id` | Session 本体、message 履歴、UI 再開に必要な metadata |
| `session_memories` | `session_id` | `Session Memory v1` の正本 |
| `audit_logs` | `id` | turn 実行と background memory extraction の監査ログ |
| `app_settings` | `setting_key` | app 共通設定 |
| `model_catalog_revisions` | `revision` | model catalog revision 管理 |
| `model_catalog_providers` | `(revision, provider_id)` | revision ごとの provider 定義 |
| `model_catalog_models` | `(revision, provider_id, model_id)` | revision ごとの model 定義 |
| `project_scopes` | `id` | Project Memory の anchor |
| `project_memory_entries` | `id` | project 単位の durable knowledge |
| `character_scopes` | `id` | Character Memory の anchor |
| `character_memory_entries` | `id` | character 単位の関係性記憶 |
| `companion_groups` | `id` | Companion Mode の repo root 単位の親 |
| `companion_sessions` | `id` | Companion Mode の 1 chat / 1 branch / 1 worktree 作業単位 |
| `companion_merge_runs` | `id` | Companion Mode の merge / discard terminal 操作履歴 |

## Table Details

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
| `stream_json` | `TEXT` | monologue を含む stream 履歴 |
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

`StreamEntry[]` を保存する。current v1 では `character reflection cycle` が生成した monologue をここへ追記する。

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
通常 turn と background memory / character reflection の両方を保持する。

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

current 実装では、`Session Memory` extraction の結果から次だけを昇格保存する。

- `decisions`
  - 常に `decision`
- `notes`
  - `constraint:` / `convention:` / `context:` / `deferred:` prefix を持つものだけ対応 category へ昇格

`goal` / `openQuestions` / `nextActions` は current slice では保存しない。

retrieval 側では、`title` / `detail` / `keywords_json` を使って lexical match を行い、coding plane prompt へ最大 3 件まで再注入する。
注入した entry は `last_used_at` を更新し、current 実装の時間減衰 ranking でも参照する。

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

current v1 では `character reflection cycle` が `CharacterMemoryDelta` をこの table へ保存する。
monologue / reflection 用 retrieval では `last_used_at` と `updated_at` を時間減衰 ranking に使う。

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

### `companion_groups`

Companion Mode の repo root 単位の親。  
1 row が 1 Git repo root を表す。

主なカラム:

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `TEXT` | CompanionGroup id |
| `repo_root` | `TEXT` | Git repo root |
| `display_name` | `TEXT` | Home 表示用名 |
| `created_at` | `TEXT` | 作成時刻 |
| `updated_at` | `TEXT` | 更新時刻 |

補足:

- `repo_root` は unique
- Companion 起動時に同一 repo root の group があれば再利用する

### `companion_sessions`

Companion Mode の作業単位。  
1 row が 1 CompanionSession を表す。

主なカラム:

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `TEXT` | CompanionSession id |
| `group_id` | `TEXT` | `companion_groups.id` |
| `task_title` | `TEXT` | session title |
| `status` | `TEXT` | `active` / `merged` / `discarded` / `recovery-required` |
| `repo_root` | `TEXT` | 作業対象 Git repo root |
| `focus_path` | `TEXT` | 起動元 workspace が repo root 配下の sub directory だった場合の相対 path |
| `target_branch` | `TEXT` | merge 対象 branch |
| `base_snapshot_ref` | `TEXT` | CompanionSession の base snapshot ref |
| `base_snapshot_commit` | `TEXT` | base snapshot commit hash |
| `companion_branch` | `TEXT` | Companion 用 branch 名 |
| `worktree_path` | `TEXT` | shadow worktree path |
| `selected_paths_json` | `TEXT` | merge 時に選択された file path の JSON 配列 |
| `changed_files_json` | `TEXT` | terminal 操作時点の changed file summary JSON 配列 |
| `sibling_warnings_json` | `TEXT` | merge 完了時の sibling warning summary JSON 配列 |
| `provider` | `TEXT` | coding provider |
| `catalog_revision` | `INTEGER` | model catalog revision |
| `model` | `TEXT` | model |
| `reasoning_effort` | `TEXT` | reasoning depth |
| `custom_agent_name` | `TEXT` | Copilot custom agent 名 |
| `approval_mode` | `TEXT` | approval mode |
| `codex_sandbox_mode` | `TEXT` | Codex sandbox mode |
| `character_id` | `TEXT` | character id |
| `character_name` | `TEXT` | session snapshot としての character 名 |
| `character_icon_path` | `TEXT` | session snapshot としての icon path |
| `character_theme_main` | `TEXT` | session snapshot のテーマ色 main |
| `character_theme_sub` | `TEXT` | session snapshot のテーマ色 sub |
| `created_at` | `TEXT` | 作成時刻 |
| `updated_at` | `TEXT` | 更新時刻 |

補足:

- current 実装では CompanionSession 作成時に base snapshot ref と shadow worktree を実体化する
- selected files merge / discard は `status`、`updated_at`、`selected_paths_json`、`changed_files_json`、`sibling_warnings_json` を更新し、terminal session は Home の history card として表示する
- sibling warning は merge 完了時のみ保存し、discard では空配列にする
- `base_snapshot_ref`、`companion_branch`、`worktree_path` は DB id 由来の safe id で生成する
- `companion_sessions.group_id` は `companion_groups(id) ON DELETE CASCADE`

### `companion_merge_runs`

Companion Mode の merge / discard terminal 操作履歴。

| column | type | description |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | merge run id |
| `session_id` | `TEXT` | `companion_sessions.id` |
| `group_id` | `TEXT` | `companion_groups.id` |
| `operation` | `TEXT` | `merge` / `discard` |
| `selected_paths_json` | `TEXT` | merge 時に選択された file path の JSON 配列 |
| `changed_files_json` | `TEXT` | terminal 操作時点の changed file summary JSON 配列 |
| `diff_snapshot_json` | `TEXT` | terminal 操作時点の `ChangedFile[]` diff snapshot JSON 配列 |
| `sibling_warnings_json` | `TEXT` | merge 完了時の sibling warning summary JSON 配列 |
| `created_at` | `TEXT` | terminal 操作日時 |

補足:

- current 実装では completed の merge / discard 操作だけを保存する
- `diff_snapshot_json` は cleanup 後の read-only Review Window で diff rows を復元するために使う
- blocked / failed merge attempt の履歴化は future slice
- Home 履歴カードは latest merge run を優先して summary を表示する
- terminal read-only Review Window は session の merge runs を newest-first timeline として表示する
- `companion_merge_runs.session_id` は `companion_sessions(id) ON DELETE CASCADE`
- `companion_merge_runs.group_id` は `companion_groups(id) ON DELETE CASCADE`

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
- `companion_groups`
- `companion_sessions`
- `companion_merge_runs`
- `<userData>/characters/`

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
