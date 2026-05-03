# Mate Storage Schema

- 作成日: 2026-05-03
- 対象: WithMate 4.0.0 の Mate Profile / Growth / provider instruction sync 用 SQLite schema

## Goal

WithMate 4.0.0 の完全 SingleMate 方針に合わせて、`withmate-v4.db` の Mate 関連 schema を定義する。

この文書は、Mate Profile metadata、Profile Item、generated Markdown projection、Growth ledger、revision、provider instruction sync の保存境界を固定する。

## Position

- SingleMate product / API の正本は `docs/design/single-mate-architecture.md` を参照する
- provider instruction sync の詳細は `docs/design/provider-instruction-sync.md` を参照する
- current / future DB 全体の一覧は `docs/design/database-schema.md` を参照する
- 4.0.0 は後方互換なしの破壊的変更として扱い、既存 V1 / V2 / V3 DB からの暗黙 migration は行わない

## Core Decisions

- DB file は `withmate-v4.db` とする
- schema version は `4` とする
- 4.0.0 runtime は `withmate-v4.db` を正本にする
- `character_*` write path は 4.0.0 runtime に残さない
- Mate 未作成状態は `mate_profile` 0 row として表現する
- Mate 作成後は `mate_profile.id = 'current'` の singleton row とする
- Mate Profile metadata は SQLite に保存する
- `profile.json` は作らない
- Mate Profile の本文正本は SQLite の Profile Item / revision / source link とする
- `core.md` / `bond.md` / `work-style.md` / `notes.md` は SQLite から完全再生成する generated projection とし、正本にしない
- `avatar.png` は任意 file とし、未設定は有効な状態として扱う
- Mate 関連 table では JSON column を使わず、query / validation したい情報は row として保存する

## File Layout

```text
<userData>/
  withmate-v4.db
  mate/
    core.md
    bond.md
    work-style.md
    notes.md
    avatar.png
    revisions/
      <revision-id>/
        core.md
        bond.md
        work-style.md
        notes.md
        avatar.png
    project-digests/
      <project-key>.md
```

`mate/*.md` は LLM / 人間が読むための projection であり、Growth apply / メイトーク / provider sync は SQLite の ready revision と Profile Item を正本として読む。
`revisions/` は rollback / diff / redaction のための generated projection snapshot storage とする。
metadata は SQLite に置くため、revision manifest JSON は作らない。
4.0.0 MVP では忘却 redaction の負荷を下げるため `changes.patch` を保存しない。diff が必要な場合は redaction 後の snapshot から都度生成する。
`avatar.png` はユーザーが画像を指定した場合だけ作成する。未設定時は `mate_profile.avatar_file_path = ''`、`avatar_sha256 = ''`、`avatar_byte_size = 0` とし、UI が Mate name と theme color から placeholder を描画する。

## Table Summary

| Table | Purpose |
| --- | --- |
| `mate_profile` | SingleMate metadata の singleton row |
| `mate_profile_sections` | `core` / `bond` / `work_style` / `notes` file の metadata と hash |
| `mate_profile_revisions` | Mate Profile revision の metadata |
| `mate_profile_revision_sections` | revision ごとの section snapshot / diff metadata |
| `mate_growth_settings` | Growth Engine の singleton 設定 |
| `mate_growth_model_preferences` | Growth LLM 実行用 provider / model / depth の固定優先順位 |
| `mate_growth_runs` | Growth background 実行単位の summary |
| `mate_growth_cursors` | session / companion / project ごとの処理済み位置 |
| `mate_growth_events` | Growth Candidate / Growth Event の ledger |
| `mate_growth_event_links` | Growth Event 間の reinforce / update / contradict / supersede link |
| `mate_growth_event_profile_item_links` | Growth Candidate が参照した Profile Item relation |
| `mate_memory_tags` | Memory / Growth Event に付与する無制限 tag relation |
| `mate_memory_tag_catalog` | Memory tag の再利用 / 説明 / alias / usage count |
| `mate_embedding_settings` | local embedding backend / model / cache 状態 |
| `mate_semantic_embeddings` | Growth Event / Profile Item / tag catalog の semantic retrieval 用 embedding |
| `mate_growth_event_actions` | Growth Event の状態変更履歴 |
| `mate_growth_event_evidence` | Growth Event の根拠参照 |
| `mate_profile_items` | Growth から生成された現在 Profile item |
| `mate_profile_item_tags` | Profile item に付与する検索 / projection 用 tag |
| `mate_profile_item_sources` | Profile item と source Growth Event の link |
| `mate_profile_item_relations` | Profile item 同士の supersede / reinforce / correction relation |
| `mate_forgotten_tombstones` | 忘却済み内容の HMAC fingerprint |
| `mate_project_digests` | project 単位 digest file の metadata |
| `provider_instruction_targets` | provider root / instruction path / sync 設定 |
| `provider_instruction_sync_runs` | provider instruction sync の実行履歴 |

## Schema

### `mate_profile`

```sql
CREATE TABLE IF NOT EXISTS mate_profile (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  state TEXT NOT NULL CHECK (state IN ('draft', 'active', 'deleted')),
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  theme_main TEXT NOT NULL DEFAULT '#6f8cff',
  theme_sub TEXT NOT NULL DEFAULT '#6fb8c7',
  avatar_file_path TEXT NOT NULL DEFAULT '',
  avatar_sha256 TEXT NOT NULL DEFAULT '',
  avatar_byte_size INTEGER NOT NULL DEFAULT 0,
  active_revision_id TEXT,
  profile_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
```

Policy:

- 0 row: Mate 未作成
- `state = 'draft'`: onboarding 中。Mate 作成と Settings 以外は block
- `state = 'active'`: Home / Session / Companion / Growth / provider sync を許可
- `state = 'deleted'`: 将来の soft delete 用予約 state。4.0.0 MVP の reset は `mate_profile` row を物理削除して Mate 未作成状態へ戻す
- `avatar_file_path = ''` は有効な未設定状態であり、file missing として扱わない
- provider instruction projection は avatar / image 情報を使わない

### `mate_profile_sections`

```sql
CREATE TABLE IF NOT EXISTS mate_profile_sections (
  mate_id TEXT NOT NULL,
  section_key TEXT NOT NULL CHECK (section_key IN ('core', 'bond', 'work_style', 'notes')),
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  updated_by_revision_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, section_key),
  FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE
);
```

Policy:

- `file_path` は `mate/` 配下の相対 path
- `core` / `bond` / `work_style` / `notes` は active 化時に必須
- `notes` は provider instruction projection へ直接入れない
- 起動時に `sha256` / `byte_size` と実 file を照合し、missing / mismatch を recovery-required として扱う

### `mate_profile_revisions`

```sql
CREATE TABLE IF NOT EXISTS mate_profile_revisions (
  id TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_revision_id TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN (
    'staging',
    'committing_files',
    'ready',
    'failed'
  )),
  kind TEXT NOT NULL CHECK (kind IN (
    'initial',
    'manual_edit',
    'growth_apply',
    'growth_correct',
    'growth_forget',
    'growth_disable',
    'growth_enable',
    'avatar_update',
    'profile_delete',
    'restore'
  )),
  source_growth_event_id TEXT,
  summary TEXT NOT NULL,
  snapshot_dir_path TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL CHECK (created_by IN ('user', 'system')),
  created_at TEXT NOT NULL,
  ready_at TEXT,
  failed_at TEXT,
  reverted_by_revision_id TEXT,
  UNIQUE (mate_id, seq),
  FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
  FOREIGN KEY (source_growth_event_id) REFERENCES mate_growth_events(id) ON DELETE SET NULL,
  FOREIGN KEY (reverted_by_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mate_profile_revisions_mate_seq
  ON mate_profile_revisions(mate_id, seq DESC);

CREATE INDEX IF NOT EXISTS idx_mate_profile_revisions_growth_event
  ON mate_profile_revisions(source_growth_event_id);
```

Policy:

- `seq` は Mate ごとの revision number
- snapshot 本文は generated projection file として置く
- SQLite は revision metadata と file hash を持つ
- `status = 'ready'` の revision だけを `mate_profile.active_revision_id` にできる
- `status = 'committing_files'` は revision snapshot は DB に保存済みだが current projection file の入れ替えが未完了の状態を表す
- provider instruction sync は `ready` な active revision だけを読む
- 起動時 recovery は `committing_files` / `failed` revision を current として採用せず、直近の `ready` revision から generated projection を復元する
- 完全忘却では、該当内容を含む snapshot を redaction 対象にし、古い revision への rollback を制限してよい

### `mate_profile_revision_sections`

```sql
CREATE TABLE IF NOT EXISTS mate_profile_revision_sections (
  revision_id TEXT NOT NULL,
  section_key TEXT NOT NULL CHECK (section_key IN ('core', 'bond', 'work_style', 'notes', 'avatar')),
  file_path TEXT NOT NULL DEFAULT '',
  before_sha256 TEXT NOT NULL DEFAULT '',
  after_sha256 TEXT NOT NULL DEFAULT '',
  before_byte_size INTEGER NOT NULL DEFAULT 0,
  after_byte_size INTEGER NOT NULL DEFAULT 0,
  diff_path TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (revision_id, section_key),
  FOREIGN KEY (revision_id) REFERENCES mate_profile_revisions(id) ON DELETE CASCADE
);
```

### `mate_growth_settings`

```sql
CREATE TABLE IF NOT EXISTS mate_growth_settings (
  mate_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_apply_enabled INTEGER NOT NULL DEFAULT 1,
  min_auto_apply_confidence INTEGER NOT NULL DEFAULT 75,
  memory_candidate_mode TEXT NOT NULL DEFAULT 'every_turn' CHECK (memory_candidate_mode IN ('every_turn', 'threshold', 'manual')),
  memory_candidate_timeout_seconds INTEGER NOT NULL DEFAULT 60,
  retrieval_strategy TEXT NOT NULL DEFAULT 'hybrid' CHECK (retrieval_strategy IN ('hybrid', 'sql_only')),
  retrieval_sql_candidate_limit INTEGER NOT NULL DEFAULT 80,
  retrieval_embedding_candidate_limit INTEGER NOT NULL DEFAULT 40,
  retrieval_final_limit INTEGER NOT NULL DEFAULT 12,
  pending_count_threshold INTEGER NOT NULL DEFAULT 10,
  pending_salience_threshold INTEGER NOT NULL DEFAULT 300,
  cooldown_seconds INTEGER NOT NULL DEFAULT 900,
  timeout_seconds INTEGER NOT NULL DEFAULT 180,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE
);
```

Policy:

- Mate が active でない場合、Growth settings に関係なく Growth は開始しない
- `enabled = 0` では candidate 抽出自体を行わない
- `auto_apply_enabled = 0` では candidate を作っても profile へ自律反映しない
- `memory_candidate_mode = 'every_turn'` では turn 完了後に軽量 background run で Memory Candidate を生成する
- `memory_candidate_mode = 'threshold'` では token / pending / elapsed time による抑制を優先する
- `apply_interval_minutes` / Growth apply cooldown は consolidation / Profile apply にだけ効き、`every_turn` の Memory Candidate 生成を止めない
- Memory Candidate 生成の provider / model / depth は `mate_growth_model_preferences` の固定優先順位を使う
- `memory_candidate_timeout_seconds` は通常 turn response を妨げないため短めにする
- Memory Candidate 生成の入力範囲はユーザー設定にしない。実装内の固定 policy として current turn と必要 metadata に限定する
- `retrieval_strategy = 'hybrid'` を 4.0.0 MVP の正規ルートとする
- `sql_only` は embedding model cache missing / recovery / debug 用 fallback とする
- embedding は Codex / Copilot などの AI agent provider ではなく、local embedding backend で生成する
- 4.0.0 MVP は `mate_embedding_settings` の local cache 設定を正本にする
- `retrieval_strategy = 'hybrid'` で model cache が存在しない場合、Growth は configuration-required ではなく SQL / tag / claimKey retrieval に fallback する
- retrieval limit は internal tuning 用であり、通常 UI には詳細設定として出さない
- `pending_count_threshold` は前回 consolidation 以降の未処理 Memory 件数 trigger に使う
- `pending_salience_threshold` は件数が少なくても重要度が高い Memory をまとめて処理する補助 trigger に使う

### `mate_growth_model_preferences`

```sql
CREATE TABLE IF NOT EXISTS mate_growth_model_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mate_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'memory_candidate',
    'profile_update',
    'project_digest'
  )),
  priority INTEGER NOT NULL CHECK (priority >= 1),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL DEFAULT 'low',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_status IN (
    'unknown',
    'available',
    'unavailable',
    'failed'
  )),
  last_error_preview TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (mate_id, purpose, priority),
  UNIQUE (mate_id, purpose, provider_id, model, reasoning_effort),
  FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mate_growth_model_preferences_enabled
  ON mate_growth_model_preferences(mate_id, purpose, enabled, priority);
```

Policy:

- Growth LLM execution は purpose ごとに固定 priority list を持つ
- `memory_candidate` は turn ごとの軽量抽出用で、既定 depth は `low`
- `profile_update` は consolidation / Profile Operation 作成用で、`memory_candidate` より深い depth を設定してよい
- `project_digest` は project tag 付き digest 更新用で、必要なら `profile_update` と別 priority にできる
- 実行時は `enabled = 1` の row を `priority ASC` で試す
- 上位 provider / model / depth が unavailable / failed の場合だけ、保存済み priority list 内で次の候補へ deterministic fallback する
- fallback は未設定 provider / model を自動採用しない
- Settings では `1. Codex model A depth low`、`2. Copilot model B depth medium` のように並べ替えできる
- embedding は reasoning depth を持たないため、この table ではなく `mate_embedding_settings` で管理する

### `mate_growth_runs`

```sql
CREATE TABLE IF NOT EXISTS mate_growth_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mate_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('session', 'companion', 'manual', 'system')),
  source_session_id TEXT,
  source_audit_log_id INTEGER,
  project_digest_id TEXT,
  trigger_reason TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  reasoning_effort TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN (
    'queued',
    'extracting',
    'consolidating',
    'applying',
    'completed',
    'failed',
    'canceled',
    'skipped',
    'recovered'
  )),
  operation_id TEXT NOT NULL DEFAULT '',
  input_hash TEXT NOT NULL DEFAULT '',
  output_revision_id TEXT,
  output_hash TEXT NOT NULL DEFAULT '',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  applied_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  error_preview TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (output_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
  FOREIGN KEY (project_digest_id) REFERENCES mate_project_digests(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mate_growth_runs_source
  ON mate_growth_runs(source_type, source_session_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_mate_growth_runs_status
  ON mate_growth_runs(status, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mate_growth_runs_operation
  ON mate_growth_runs(mate_id, operation_id)
  WHERE operation_id <> '';
```

Policy:

- Growth run は background 実行単位の summary だけを保存する
- raw prompt / raw transcript は保存しない
- error は `error_preview` へ短く保存し、local path や secret を含めない
- `operation_id` は retry idempotency に使う
- `status = 'applying'` のまま起動した場合は recovery 対象にする

### `mate_growth_cursors`

```sql
CREATE TABLE IF NOT EXISTS mate_growth_cursors (
  mate_id TEXT NOT NULL,
  cursor_key TEXT NOT NULL CHECK (cursor_key IN (
    'extraction_cursor',
    'consolidation_cursor',
    'applied_event_watermark',
    'project_digest_cursor'
  )),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'session', 'companion', 'project')),
  scope_id TEXT NOT NULL DEFAULT '',
  last_message_id TEXT NOT NULL DEFAULT '',
  last_audit_log_id INTEGER,
  last_growth_event_id TEXT NOT NULL DEFAULT '',
  last_profile_generation INTEGER NOT NULL DEFAULT 0,
  content_fingerprint TEXT NOT NULL DEFAULT '',
  updated_by_run_id INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mate_id, cursor_key, scope_type, scope_id),
  FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by_run_id) REFERENCES mate_growth_runs(id) ON DELETE SET NULL
);
```

Policy:

- Growth Engine は cursor と cooldown で短時間の重複実行を抑制する
- `cursor_key` は処理済み位置の意味を固定し、nullable unique に依存しない
- `scope_type = 'global'` の場合は `scope_id = ''` とする
- `scope_type = 'session' | 'companion' | 'project'` の場合は `scope_id` に provider-neutral な session id または project key を入れる
- `last_message_id` は provider / session 実装差を吸収するため TEXT として扱う
- `last_message_id` は順序比較に使わない。順序は `last_audit_log_id`、source message の stored sequence、または source service が返す deterministic range boundary で判断する
- `content_fingerprint` は処理済み入力の重複判定に使う
- cursor は session / companion の raw content を持たない
- 更新時は old cursor value / `content_fingerprint` を比較し、古い background run が新しい cursor を巻き戻さないようにする

### `mate_growth_events`

```sql
CREATE TABLE IF NOT EXISTS mate_growth_events (
  id TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL,
  source_growth_run_id INTEGER,
  source_type TEXT NOT NULL CHECK (source_type IN ('session', 'companion', 'manual', 'system')),
  source_session_id TEXT,
  source_audit_log_id INTEGER,
  project_digest_id TEXT,
  growth_source_type TEXT NOT NULL CHECK (growth_source_type IN (
    'explicit_user_instruction',
    'user_correction',
    'repeated_user_behavior',
    'assistant_inference',
    'tool_or_file_observation'
  )),
  kind TEXT NOT NULL CHECK (kind IN (
    'conversation',
    'preference',
    'relationship',
    'work_style',
    'boundary',
    'project_context',
    'curiosity',
    'observation',
    'correction'
  )),
  target_section TEXT NOT NULL DEFAULT 'none' CHECK (target_section IN ('bond', 'work_style', 'project_digest', 'core', 'none')),
  statement TEXT NOT NULL,
  statement_fingerprint TEXT NOT NULL DEFAULT '',
  rationale_preview TEXT NOT NULL DEFAULT '',
  retention TEXT NOT NULL DEFAULT 'auto' CHECK (retention IN ('auto', 'force')),
  relation TEXT NOT NULL DEFAULT 'new' CHECK (relation IN ('new', 'reinforces', 'updates', 'contradicts')),
  target_claim_key TEXT NOT NULL DEFAULT '',
  confidence INTEGER NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
  salience_score INTEGER NOT NULL DEFAULT 0 CHECK (salience_score >= 0 AND salience_score <= 100),
  recurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (recurrence_count >= 1),
  policy_decision TEXT NOT NULL DEFAULT 'pending' CHECK (policy_decision IN ('pending', 'auto_apply', 'manual_only')),
  projection_allowed INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN (
    'candidate',
    'applied',
    'corrected',
    'superseded',
    'disabled',
    'forgotten',
    'failed'
  )),
  applied_revision_id TEXT,
  corrected_by_event_id TEXT,
  superseded_by_event_id TEXT,
  forgotten_revision_id TEXT,
  disabled_revision_id TEXT,
  content_redacted INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  decay_after_at TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  updated_at TEXT NOT NULL,
  forgotten_at TEXT,
  disabled_at TEXT,
  FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (source_growth_run_id) REFERENCES mate_growth_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (applied_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
  FOREIGN KEY (corrected_by_event_id) REFERENCES mate_growth_events(id) ON DELETE SET NULL,
  FOREIGN KEY (superseded_by_event_id) REFERENCES mate_growth_events(id) ON DELETE SET NULL,
  FOREIGN KEY (forgotten_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
  FOREIGN KEY (disabled_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mate_growth_events_state_created
  ON mate_growth_events(state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mate_growth_events_target_state
  ON mate_growth_events(target_section, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_mate_growth_events_project
  ON mate_growth_events(project_digest_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_mate_growth_events_fingerprint
  ON mate_growth_events(statement_fingerprint, state);

CREATE INDEX IF NOT EXISTS idx_mate_growth_events_seen
  ON mate_growth_events(last_seen_at DESC, salience_score DESC);
```

Policy:

- Growth Candidate は 4.0.0 から実装する
- 毎回のユーザー承認は要求しない
- Memory Candidate 生成 LLM が返した candidate は schema validation 後に全件保存する
- 保存しない判断は LLM が `memories[]` に含めないことで表現する
- `kind` は Memory Candidate の `kind` と同じ値を保存する
- `target_section` / `policy_decision` / `projection_allowed` は保存時に `none` / `pending` / `0` で初期化し、GrowthPolicyGate / PostPolicyGate が Profile apply 前に更新する
- `policy_decision = 'auto_apply'` の candidate は profile へ自律反映してよい
- `policy_decision = 'manual_only'` の candidate は保存してよいが自律反映しない
- `target_section = 'core'` は人格の芯を揺らすため、4.0.0 MVP では自律反映しない
- `projection_allowed = 0` の event は provider instruction projection へ出さない
- profile 反映可否と provider projection 可否は別判定にする
- `growth_source_type = 'assistant_inference'` は原則 `manual_only` とする
- `growth_source_type = 'tool_or_file_observation'` は user preference ではなく project context として扱う
- `statement_fingerprint` は関連候補、forgotten tombstone との照合、Growth apply 時の圧縮判断に使う
- 同じ `statement_fingerprint` が再出現しても、4.0.0 MVP では保存前に重複統合しない
- `retention = 'auto'` は通常候補として保存する
- `retention = 'force'` は LLM が強く覚えるべきと判断した保存候補であり、app は意味判定で降格しない
- `relation` は既存 Memory / Profile Item との関係を表す。`updates` / `contradicts` は correction / supersede 候補として扱う
- `target_claim_key` は値を含めない安定 facet 名であり、同じ claim の変化検出に使う
- `superseded_by_event_id` は、この event が後続 event に置き換えられたことを表す
- `salience_score` は明示的な重要表現、反復、今後への影響を反映する
- `decay_after_at` を過ぎた一時的な Memory は provider instruction projection へ出さない
- `statement` は短く正規化された記憶内容にする
- 長い transcript や raw evidence は保存しない
- health / religion / politics / sexual orientation / secret / credential / customer name / workplace name / legal / finance / medical / inferred personality / inferred emotion は Memory 生成 prompt で `memories[]` に含めないよう指示する
- app は保存価値の意味判定を行わず、schema validation と DB 整合性だけを行う
- tag は `mate_memory_tags` に無制限に付与する
- tag catalog は candidate 抽出 input に毎回渡し、既存 tag の再利用を優先する

State transition:

```text
candidate -> applied
candidate -> failed
applied -> corrected
applied -> superseded
applied -> disabled
applied -> forgotten
corrected -> forgotten
superseded -> forgotten
disabled -> applied
disabled -> forgotten
```

### `mate_growth_event_links`

```sql
CREATE TABLE IF NOT EXISTS mate_growth_event_links (
  source_growth_event_id TEXT NOT NULL,
  target_growth_event_id TEXT NOT NULL,
  link_type TEXT NOT NULL CHECK (link_type IN (
    'related',
    'reinforces',
    'updates',
    'contradicts',
    'supersedes'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_growth_event_id, target_growth_event_id, link_type),
  FOREIGN KEY (source_growth_event_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE,
  FOREIGN KEY (target_growth_event_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mate_growth_event_links_target
  ON mate_growth_event_links(target_growth_event_id, link_type);
```

Policy:

- Memory Candidate の `relatedRefs` / `supersedesRefs` のうち `type = "memory"` を保存する relation table
- 1 candidate が複数の既存 Memory を強化、更新、矛盾、置換できる
- `source_growth_event_id` は新しく抽出された event、`target_growth_event_id` は既存 event を指す
- `relation = 'reinforces'` は `link_type = 'reinforces'` を作る
- `relation = 'updates'` は `link_type = 'updates'` を作り、必要なら古い event を `superseded` にする
- `relation = 'contradicts'` は `link_type = 'contradicts'` を作り、Profile Update Skill が correction / supersede operation を判断する
- `supersedesRefs` の memory ref は `link_type = 'supersedes'` として保存し、古い event の `superseded_by_event_id` 更新と併用してよい
- `type = "profile_item"` の ref は `mate_growth_event_profile_item_links` に保存する

### `mate_growth_event_profile_item_links`

```sql
CREATE TABLE IF NOT EXISTS mate_growth_event_profile_item_links (
  growth_event_id TEXT NOT NULL,
  profile_item_id TEXT NOT NULL,
  link_type TEXT NOT NULL CHECK (link_type IN (
    'related',
    'reinforces',
    'updates',
    'contradicts',
    'supersedes'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (growth_event_id, profile_item_id, link_type),
  FOREIGN KEY (growth_event_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE,
  FOREIGN KEY (profile_item_id) REFERENCES mate_profile_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mate_growth_event_profile_item_links_item
  ON mate_growth_event_profile_item_links(profile_item_id, link_type);
```

Policy:

- Memory Candidate の `relatedRefs` / `supersedesRefs` のうち `type = "profile_item"` を保存する relation table
- Profile apply はこの relation を見て、既存 Profile Item の強化、更新、矛盾、置換候補を復元できる
- Profile Item の主 source link は `mate_profile_item_sources` に保存し、この table は candidate extraction 時点の参照関係を保存する

### `mate_memory_tags`

```sql
CREATE TABLE IF NOT EXISTS mate_memory_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  tag_type TEXT NOT NULL,
  tag_value TEXT NOT NULL DEFAULT '',
  tag_value_normalized TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mate_memory_tags_memory
  ON mate_memory_tags(memory_id);

CREATE INDEX IF NOT EXISTS idx_mate_memory_tags_lookup
  ON mate_memory_tags(tag_type, tag_value_normalized);
```

Policy:

- `memory_id` は 4.0.0 MVP では `mate_growth_events.id` を指す
- tag は `tag_type` と `tag_value` の open string とし、種類数を制限しない
- 1 Memory に付与できる tag 数を schema では制限しない
- 同じ `tag_type` を複数付与してよい
- unique constraint は置かず、必要なら service layer で重複整理する
- Git 管理下 workspace は `tag_type = 'project'` の tag を Git 情報から付与する
- Git 非管理 workspace には project tag を付与しない
- tag は検索、filter、projection selection 用 metadata であり、単独で provider instruction に出さない

### `mate_memory_tag_catalog`

```sql
CREATE TABLE IF NOT EXISTS mate_memory_tag_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_type TEXT NOT NULL,
  tag_value TEXT NOT NULL DEFAULT '',
  tag_value_normalized TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  created_by TEXT NOT NULL CHECK (created_by IN ('app', 'llm', 'user')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mate_memory_tag_catalog_unique
  ON mate_memory_tag_catalog(tag_type, tag_value_normalized);

CREATE INDEX IF NOT EXISTS idx_mate_memory_tag_catalog_lookup
  ON mate_memory_tag_catalog(tag_type, usage_count DESC, updated_at DESC);
```

Policy:

- catalog は tag relation の正規化と再利用促進のために使う
- `tag_type` / `tag_value` は open string とし、DB CHECK で enum 化しない
- app は `tag_type` / `tag_value` / `description` / `aliases` を保存前に sanitizer に通す
- secret、PII、URL、local path、repo path、顧客名、職場名、prompt injection 文を含む tag は catalog に保存しない
- project tag は raw path や repository 名ではなく、Git 情報から作った安定 key を使う
- `aliases` は JSON column ではなく、4.0.0 MVP では改行区切りまたは service layer の正規化文字列として扱う
- Memory Candidate 生成時は catalog snapshot を background run に渡し、既存 tag 優先を prompt / schema で要求する
- LLM は未知 tag を直接確定せず、`newTags` と理由を返す
- app は `newTags` を保存前に正規化し、既存 catalog の近似 / alias / duplicate を確認してから追加する
- 初期 catalog は最低限の予約 tag だけを app が作成する
- catalog は毎回全件を渡す方針とするが、raw Memory 本文は渡さず、`tag_type` / `tag_value` / `description` / `aliases` / `usage_count` の sanitized snapshot だけを渡す
- retrieval / prompt injection では `state = 'active'` の catalog entry だけを使う
- 類似 tag や誤登録 tag は削除せず `disabled` にして、既存 relation の履歴を壊さない

Initial reserved tags:

```text
scope = global
scope = project
source = chat
source = manual
salience = low
salience = medium
salience = high
entity = user
entity = mate
topic = general
```

Git 管理下 workspace では app が Git 情報から project tag を自動付与する。
Git 非管理 workspace では project tag も匿名 project label も作らない。

### `mate_embedding_settings`

```sql
CREATE TABLE IF NOT EXISTS mate_embedding_settings (
  mate_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  backend_type TEXT NOT NULL DEFAULT 'local_transformers_js' CHECK (backend_type IN (
    'local_transformers_js'
  )),
  model_id TEXT NOT NULL DEFAULT 'Xenova/multilingual-e5-small',
  source_model_id TEXT NOT NULL DEFAULT 'intfloat/multilingual-e5-small',
  dimension INTEGER NOT NULL DEFAULT 384,
  cache_policy TEXT NOT NULL DEFAULT 'download_once_local_cache' CHECK (cache_policy IN (
    'download_once_local_cache'
  )),
  cache_state TEXT NOT NULL DEFAULT 'missing' CHECK (cache_state IN (
    'missing',
    'downloading',
    'ready',
    'failed',
    'stale'
  )),
  cache_dir_path TEXT NOT NULL DEFAULT '',
  cache_manifest_sha256 TEXT NOT NULL DEFAULT '',
  model_revision TEXT NOT NULL DEFAULT '',
  cache_size_bytes INTEGER NOT NULL DEFAULT 0,
  cache_updated_at TEXT,
  last_verified_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_status IN (
    'unknown',
    'available',
    'unavailable',
    'failed'
  )),
  last_error_preview TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE
);
```

Policy:

- embedding は Codex / Copilot などの AI agent provider ではなく、local embedding backend で生成する
- 4.0.0 MVP の backend は `local_transformers_js` に固定する
- 既定 model は Transformers.js / ONNX 互換の `Xenova/multilingual-e5-small` とする
- `source_model_id` は元 model card / license 確認用の参照であり、実行時 load には `model_id` を使う
- `dimension` は user が選ぶ値ではなく、model 固有の出力 vector 長である
- `Xenova/multilingual-e5-small` は 384 dimension として扱う
- 初回 model download は自動実行しない。Settings の明示 download button から開始する
- download 未完了の間、embedding を必要とする機能は実行しない
- ここで止める対象は semantic retrieval、embedding generation、embedding similarity rerank であり、Memory Candidate 生成そのものは SQL / tag / claimKey retrieval に縮退して実行してよい
- 初回だけ model を download し、以後は app 管理 cache から CPU 実行する
- 完全 offline 環境では `cache_state = 'ready'` の場合だけ embedding を有効化する
- `cache_state != 'ready'` の場合、hybrid retrieval は SQL / tag / claimKey retrieval に fallback する
- `cache_dir_path` は app 管理 directory からの相対 path とする
- `cache_manifest_sha256` は download manifest / file list / model id / dimension / revision を正規化した hash とする
- download は temporary directory に行い、必須 file と manifest を検証してから active cache へ昇格する
- 起動時、Settings 表示時、retrieval 実行前に cache manifest を検証できる
- manifest / 必須 file / hash が不一致の場合は `cache_state = 'failed'` または `stale` にし、semantic retrieval を止める
- `model_revision` が変わった場合、既存 embedding は stale とし、再生成 job を enqueue する
- model / dimension が変わる場合、該当 embedding は stale として再生成する
- 4.0.0 MVP では embedding model の priority list や環境依存 auto selection は持たない

### `mate_semantic_embeddings`

```sql
CREATE TABLE IF NOT EXISTS mate_semantic_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mate_id TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('growth_event', 'profile_item', 'tag_catalog')),
  owner_id TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  embedding_backend_type TEXT NOT NULL DEFAULT '',
  embedding_model_id TEXT NOT NULL DEFAULT '',
  dimension INTEGER NOT NULL CHECK (dimension > 0),
  vector_blob BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_type, owner_id, embedding_backend_type, embedding_model_id, text_hash),
  FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mate_semantic_embeddings_owner
  ON mate_semantic_embeddings(owner_type, owner_id);

CREATE INDEX IF NOT EXISTS idx_mate_semantic_embeddings_model
  ON mate_semantic_embeddings(embedding_backend_type, embedding_model_id, dimension);
```

Policy:

- 4.0.0 MVP の Relevant Memory Retrieval は hybrid retrieval を正規ルートにする
- `owner_type = 'growth_event'` は `mate_growth_events.statement` を主な embedding source にする
- `owner_type = 'profile_item'` は `claim_key + claim_value_normalized + rendered_text` を embedding source にする
- `owner_type = 'tag_catalog'` は tag catalog の `tag_type + tag_value + description + aliases` を embedding source にする
- `vector_blob` は embedding float vector を binary 化した値とする。SQLite extension / vector index の採否は実装時に選べるよう、schema は backend-neutral にする
- vector index が使えない環境では、SQL で候補を絞った後に app process で bounded cosine similarity を計算してよい
- embedding が未生成または model / dimension mismatch の場合は stale として再生成する
- current retrieval は `mate_embedding_settings.enabled = 1` かつ `cache_state = 'ready'` の local embedding backend だけを使う
- backend / model / dimension を変更した場合、既存 embedding は stale として扱い、background で再生成する
- forgotten / redacted / disabled owner の embedding は retrieval に使わない。忘却時は削除または redacted text で再生成する
- raw transcript は embedding source にしない。短い statement / profile item / tag catalog のみを対象にする

Hybrid retrieval score:

```text
final_score =
  semantic_similarity
  + claim_key_match_bonus
  + tag_overlap_bonus
  + salience_bonus
  + recurrence_bonus
  + recency_bonus
  + source_trust_bonus
  - decay_penalty
```

MVP では係数を固定値として app に持ち、UI 設定には出さない。

### `mate_growth_event_actions`

```sql
CREATE TABLE IF NOT EXISTS mate_growth_event_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  growth_event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'extract',
    'auto_apply',
    'manual_apply',
    'correct',
    'forget',
    'disable',
    'enable',
    'restore',
    'redact',
    'fail'
  )),
  actor TEXT NOT NULL CHECK (actor IN ('system', 'user')),
  revision_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (growth_event_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE,
  FOREIGN KEY (revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mate_growth_event_actions_event
  ON mate_growth_event_actions(growth_event_id, id);
```

### `mate_growth_event_evidence`

```sql
CREATE TABLE IF NOT EXISTS mate_growth_event_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  growth_event_id TEXT NOT NULL,
  source_session_id TEXT,
  source_message_id TEXT,
  source_audit_log_id INTEGER,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
    'message',
    'audit_log',
    'manual_note',
    'system',
    'tool_output',
    'repo_file',
    'terminal_output'
  )),
  source_role TEXT NOT NULL CHECK (source_role IN ('user', 'assistant', 'tool', 'system', 'file')),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'chat_message',
    'tool_output',
    'repo_file',
    'terminal_output',
    'manual_note',
    'system'
  )),
  trust_level TEXT NOT NULL CHECK (trust_level IN (
    'user_authored',
    'assistant_generated',
    'untrusted_external'
  )),
  quote_preview TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (growth_event_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mate_growth_event_evidence_event
  ON mate_growth_event_evidence(growth_event_id, id);
```

Policy:

- evidence は短い preview と参照だけを持つ
- `source_message_id` は provider / session 実装差を吸収するため TEXT として扱う
- full transcript の重複保存はしない
- 忘却時は `quote_preview` を redaction できる
- auto apply の基本条件は `source_role = 'user'` かつ `trust_level = 'user_authored'`
- `tool` / `file` / `terminal_output` 由来の evidence は user preference に使わず、project context に限定する

### `mate_profile_items`

```sql
CREATE TABLE IF NOT EXISTS mate_profile_items (
  id TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL,
  section_key TEXT NOT NULL CHECK (section_key IN ('core', 'bond', 'work_style', 'notes', 'project_digest')),
  project_digest_id TEXT,
  category TEXT NOT NULL CHECK (category IN ('persona', 'voice', 'preference', 'relationship', 'work_style', 'boundary', 'project_context', 'note')),
  claim_key TEXT NOT NULL,
  claim_value TEXT NOT NULL DEFAULT '',
  claim_value_normalized TEXT NOT NULL DEFAULT '',
  rendered_text TEXT NOT NULL,
  normalized_claim TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  salience_score INTEGER NOT NULL DEFAULT 0 CHECK (salience_score BETWEEN 0 AND 100),
  recurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (recurrence_count >= 1),
  projection_allowed INTEGER NOT NULL DEFAULT 0 CHECK (projection_allowed IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'forgotten', 'superseded')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_revision_id TEXT,
  updated_revision_id TEXT,
  disabled_revision_id TEXT,
  forgotten_revision_id TEXT,
  disabled_at TEXT,
  forgotten_at TEXT,
  superseded_by_item_id TEXT,
  content_redacted INTEGER NOT NULL DEFAULT 0 CHECK (content_redacted IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((section_key = 'project_digest') = (project_digest_id IS NOT NULL)),
  FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (project_digest_id) REFERENCES mate_project_digests(id) ON DELETE CASCADE,
  FOREIGN KEY (created_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
  FOREIGN KEY (disabled_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
  FOREIGN KEY (forgotten_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
  FOREIGN KEY (superseded_by_item_id) REFERENCES mate_profile_items(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mate_profile_items_active_claim_global
  ON mate_profile_items(mate_id, section_key, claim_key)
  WHERE state = 'active' AND project_digest_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mate_profile_items_active_claim_project
  ON mate_profile_items(mate_id, project_digest_id, claim_key)
  WHERE state = 'active' AND project_digest_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mate_profile_items_render
  ON mate_profile_items(mate_id, section_key, state, salience_score DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_mate_profile_items_projection
  ON mate_profile_items(mate_id, section_key, projection_allowed, state, salience_score DESC);
```

Policy:

- Growth Event は履歴、Profile Item は現在状態とする
- Markdown は active Profile Item から render する。`core` は一人称、二人称、呼びかけ、口調、語尾、性格傾向などの manual / メイトーク由来 item を正本にする
- `notes` は provider instruction projection へ直接出さない manual note item の保存先とし、`projection_allowed = 1` でも provider projection では無視する
- 4.0.0 MVP では通常 Growth apply は `core` を自律更新しない。`core` 更新は手動編集、メイトーク由来の明示的な Profile Operation、または後続バージョンの専用 gate に限定する
- 同じ `claim_key` で `claim_value` が変わる場合は contradiction / supersede 候補とする
- `corrected` は item state に持たず、旧 item を `superseded`、新 item を `active` として表現する
- `projection_allowed = 0` の item は provider instruction projection へ出さない
- `claim_key` には値や個人情報を含めない
- `claim_value_normalized` は HMAC tombstone と contradiction 判定の入力に使う
- Markdown 全文は SQLite に重複保存しない
- Memory / Growth は project 単位で分割せず、Memory ID に紐づく tag relation で分類する
- project digest は `project` tag を持つ Profile Item から作る projection の一種である

### `mate_profile_item_tags`

```sql
CREATE TABLE IF NOT EXISTS mate_profile_item_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_item_id TEXT NOT NULL,
  tag_type TEXT NOT NULL,
  tag_value TEXT NOT NULL DEFAULT '',
  tag_value_normalized TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (profile_item_id) REFERENCES mate_profile_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mate_profile_item_tags_item
  ON mate_profile_item_tags(profile_item_id);

CREATE INDEX IF NOT EXISTS idx_mate_profile_item_tags_lookup
  ON mate_profile_item_tags(tag_type, tag_value_normalized);
```

Policy:

- Profile Item tag は source Memory tags から継承または render 時に派生させる
- tag は `tag_type` と `tag_value` の open string とし、種類数を制限しない
- 1 Profile Item に付与できる tag 数を schema では制限しない
- 同じ `tag_type` を複数付与してよい
- unique constraint は置かず、必要なら service layer で重複整理する
- Git 管理下 workspace は Git 情報から `project` tag を付与する
- Git 非管理 workspace は project tag を付与しない
- workspace path hash による非 Git project label は 4.0.0 MVP では作らない
- tag は retrieval / filter / projection 用 metadata であり、単独で provider instruction に出さない

### `mate_profile_item_sources`

```sql
CREATE TABLE IF NOT EXISTS mate_profile_item_sources (
  profile_item_id TEXT NOT NULL,
  growth_event_id TEXT NOT NULL,
  link_type TEXT NOT NULL CHECK (link_type IN ('created_by', 'reinforced_by', 'corrected_by', 'superseded_by')),
  created_revision_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_item_id, growth_event_id, link_type),
  FOREIGN KEY (profile_item_id) REFERENCES mate_profile_items(id) ON DELETE CASCADE,
  FOREIGN KEY (growth_event_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE,
  FOREIGN KEY (created_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mate_profile_item_sources_event
  ON mate_profile_item_sources(growth_event_id);
```

Policy:

- Profile Item と Growth Event の対応を保存する
- forget / correction / disable は source link をたどって派生物を更新する

### `mate_profile_item_relations`

```sql
CREATE TABLE IF NOT EXISTS mate_profile_item_relations (
  from_profile_item_id TEXT NOT NULL,
  to_profile_item_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('reinforces', 'updates', 'contradicts', 'supersedes')),
  source_growth_event_id TEXT,
  created_revision_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_profile_item_id, to_profile_item_id, relation_type),
  FOREIGN KEY (from_profile_item_id) REFERENCES mate_profile_items(id) ON DELETE CASCADE,
  FOREIGN KEY (to_profile_item_id) REFERENCES mate_profile_items(id) ON DELETE CASCADE,
  FOREIGN KEY (source_growth_event_id) REFERENCES mate_growth_events(id) ON DELETE SET NULL,
  FOREIGN KEY (created_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mate_profile_item_relations_to
  ON mate_profile_item_relations(to_profile_item_id, relation_type);
```

Policy:

- `mate_growth_event_profile_item_links` は candidate / event layer の参照を保存する
- `mate_profile_item_relations` は apply 後の current Profile Item 同士の関係を保存する
- correction / forget / disable は source link と item relation の両方をたどり、派生 item を更新対象に含める

### `mate_forgotten_tombstones`

```sql
CREATE TABLE IF NOT EXISTS mate_forgotten_tombstones (
  id TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL,
  hmac_digest TEXT NOT NULL,
  hmac_version INTEGER NOT NULL,
  hmac_key_id TEXT NOT NULL DEFAULT 'default',
  digest_kind TEXT NOT NULL CHECK (digest_kind IN ('normalized_claim', 'growth_statement', 'rendered_text')),
  category TEXT NOT NULL CHECK (category IN ('persona', 'voice', 'preference', 'relationship', 'work_style', 'boundary', 'project_context', 'note')),
  section_key TEXT NOT NULL CHECK (section_key IN ('core', 'bond', 'work_style', 'notes', 'project_digest')),
  project_digest_id TEXT,
  source_growth_event_id TEXT,
  source_profile_item_id TEXT,
  redaction_revision_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (mate_id, hmac_version, hmac_key_id, digest_kind, hmac_digest),
  FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (project_digest_id) REFERENCES mate_project_digests(id) ON DELETE SET NULL,
  FOREIGN KEY (source_growth_event_id) REFERENCES mate_growth_events(id) ON DELETE SET NULL,
  FOREIGN KEY (source_profile_item_id) REFERENCES mate_profile_items(id) ON DELETE SET NULL,
  FOREIGN KEY (redaction_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
);
```

Policy:

- 忘却済み内容の再抽出を防ぐ
- `hmac_digest` は plain hash ではなく app secret salt を使った HMAC とする
- `normalized_claim` そのものは tombstone に保存しない

### `mate_project_digests`

```sql
CREATE TABLE IF NOT EXISTS mate_project_digests (
  id TEXT PRIMARY KEY,
  mate_id TEXT NOT NULL,
  project_type TEXT NOT NULL CHECK (project_type IN ('git')),
  project_key TEXT NOT NULL UNIQUE,
  workspace_path TEXT NOT NULL,
  git_root TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL,
  digest_file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  active_revision_id TEXT,
  last_growth_event_id TEXT,
  last_compiled_at TEXT,
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
  FOREIGN KEY (active_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
  FOREIGN KEY (last_growth_event_id) REFERENCES mate_growth_events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mate_project_digests_project_key
  ON mate_project_digests(project_key);
```

Policy:

- Git 管理下 workspace だけ `mate_project_digests` を作る
- `project_key` は Git 情報から作る
- Git 非管理 workspace には project digest row を作らない
- project digest は Memory storage の分割単位ではなく、project tag 付き Profile Item から render する file projection である

## Provider Instruction Sync Tables

### `provider_instruction_targets`

```sql
CREATE TABLE IF NOT EXISTS provider_instruction_targets (
  provider_id TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT 'main',
  enabled INTEGER NOT NULL DEFAULT 0,
  root_directory TEXT NOT NULL DEFAULT '',
  instruction_relative_path TEXT NOT NULL DEFAULT '',
  write_mode TEXT NOT NULL CHECK (write_mode IN ('managed_file', 'managed_block')),
  projection_scope TEXT NOT NULL DEFAULT 'mate_only' CHECK (projection_scope IN ('mate_only')),
  fail_policy TEXT NOT NULL CHECK (fail_policy IN ('block_session', 'warn_continue')),
  requires_restart INTEGER NOT NULL DEFAULT 0,
  last_sync_state TEXT NOT NULL CHECK (last_sync_state IN ('never', 'stale', 'redaction_required', 'synced', 'skipped', 'failed')),
  last_synced_revision_id TEXT,
  last_sync_run_id INTEGER,
  last_error_preview TEXT NOT NULL DEFAULT '',
  last_synced_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_instruction_targets_enabled
  ON provider_instruction_targets(enabled, provider_id, target_id);
```

Policy:

- `provider_id` は DB CHECK では固定しない
- 4.0.0 MVP の既定 `target_id` は `main` とする
- runtime は current supported provider list と照合し、unsupported provider は sync 対象外にする
- `instruction_relative_path` は相対 path のみ
- absolute path、`..`、root 外解決、symlink escape は validation で拒否する
- UI / API は `managed-block` / `managed-file` の kebab-case を使い、SQLite には `managed_block` / `managed_file` の snake_case として保存する
- 4.0.0 MVP は `write_mode = 'managed_block'`、`projection_scope = 'mate_only'` を基本にする
- `managed_file` は専用 file をユーザーが明示指定した場合だけ使う
- project digest は provider global instruction へ混ぜない。prompt 送信時に relevant Memory / Profile Item を検索し、session request の一時 context として注入する
- managed-block marker は `provider_id` / `target_id` / `write_mode` が保存済み target と一致する場合だけ更新する

### `provider_instruction_sync_runs`

```sql
CREATE TABLE IF NOT EXISTS provider_instruction_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT 'main',
  mate_revision_id TEXT,
  write_mode TEXT NOT NULL,
  projection_scope TEXT NOT NULL,
  projection_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('synced', 'skipped', 'failed')),
  error_preview TEXT NOT NULL DEFAULT '',
  requires_restart INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  FOREIGN KEY (provider_id, target_id) REFERENCES provider_instruction_targets(provider_id, target_id) ON DELETE CASCADE,
  FOREIGN KEY (mate_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_instruction_sync_runs_provider
  ON provider_instruction_sync_runs(provider_id, target_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_provider_instruction_sync_runs_revision
  ON provider_instruction_sync_runs(mate_revision_id, id DESC);
```

## Session Snapshot Boundary

4.0.0 の `sessions` / `companion_sessions` は V3 の split/blob 方針を継承しつつ、character snapshot column を Mate snapshot column に置き換える。

候補 column:

```text
mate_id
mate_name
mate_avatar_file_path
mate_theme_main
mate_theme_sub
mate_revision_id
provider_instruction_sync_run_id
```

`mate_avatar_file_path` は未設定時に空文字を保存する。placeholder は snapshot せず、表示時に Mate name / theme から再計算する。

`character_id` / `character_name` / `character_icon_path` / `character_theme_*` は 4.0.0 write path に残さない。

## Reset Policy

4.0.0 では reset 対象を次のように再定義する。

- Mate Profile reset
  - `mate_profile`
  - `mate_profile_sections`
  - `mate_profile_revisions`
  - `mate_profile_revision_sections`
  - `mate_growth_settings`
  - `mate_growth_model_preferences`
  - `mate_growth_runs`
  - `mate_growth_cursors`
  - `mate_growth_events`
  - `mate_growth_event_links`
  - `mate_growth_event_profile_item_links`
  - `mate_memory_tags`
  - `mate_memory_tag_catalog`
  - `mate_embedding_settings`
  - `mate_semantic_embeddings`
  - `mate_growth_event_actions`
  - `mate_growth_event_evidence`
  - `mate_profile_items`
  - `mate_profile_item_tags`
  - `mate_profile_item_sources`
  - `mate_profile_item_relations`
  - `mate_project_digests`
  - `<userData>/mate/`
- Provider instruction target reset
  - `provider_instruction_targets`
  - `provider_instruction_sync_runs`
- Session reset
  - `sessions`
  - `session_messages`
  - audit log 系

DB だけ消して `mate/*.md` が残る状態、または file だけ消えて active revision が残る状態を禁止する。
reset は DB と file cleanup の結果を recovery report として返す。

Mate Profile reset は `mate_profile` row を物理削除し、初回起動 flow と同じ Mate 未作成状態へ戻す。
`state = 'deleted'` は将来の soft delete 用に残すが、4.0.0 MVP の reset 完了状態としては使わない。
Mate Profile reset は provider instruction target row を既定では残す。
ただし reset 実行時に、enabled target の managed block / managed file から旧 Mate projection を削除し、空の WithMate block または disabled projection へ同期する。
provider instruction file の書き換えに失敗した target は `stale` / `redaction_required` warning とし、Settings に再同期導線を出す。
旧 Mate projection が provider instruction file に残ったまま silent success にしない。
reset cleanup の provider sync run は `mate_revision_id = NULL` で記録できる。
Mate Profile reset 後は `provider_instruction_targets.last_synced_revision_id` を必ず `NULL` にし、削除済み revision を指さない。

## Atomicity / Recovery

SQLite と file storage は完全 atomic ではない。

DB の `mate_profile.active_revision_id` を recovery 時の正本にする。
file が DB と不一致になった場合は、active revision snapshot から current Markdown を復元する。

更新は次の順で行う。

1. 単一 writer lock を取る
2. SQLite の current Profile Item と pending Growth Event から in-memory の proposed Profile Item set を作る
3. proposed Profile Item set から staging file を render する
4. staging file の hash / byte size を計算する
5. revision snapshot を durable な revision directory へ保存する
6. SQLite transaction で `committing_files` revision metadata と revision section metadata だけを保存する。この時点では current Profile Item / Growth Event state / source link / cursor / `mate_profile.active_revision_id` を進めない
7. transaction commit 後に current generated projection file を revision snapshot から入れ替える
8. current file の hash を再計算し、revision section metadata と一致することを確認する
9. SQLite transaction で Profile Item 更新、Growth Event state / applied_revision_id、source link、revision `ready`、`mate_profile.active_revision_id`、`mate_profile.profile_generation` increment、section metadata、provider target stale、cursor を同時に更新する
10. verification 失敗時は recovery-required として直近の `ready` active revision snapshot から復元する。step 9 前なら current Profile Item は旧状態のままなので DB rollback は不要
11. transaction 失敗時は orphan staging / snapshot を cleanup 対象にする

起動時 recovery:

- `mate_profile_sections` の file missing / hash mismatch を検出する
- active revision の snapshot missing を検出する
- provider target path が root 外へ解決される場合は disabled 扱いにする
- Growth Event が `applied` なのに revision がない場合は recovery-required とする
- `mate_growth_runs.status = 'applying'` の run を検出する
- `mate_profile_revisions.status = 'committing_files' | 'failed'` の revision を検出する
- `committing_files` revision は current Profile Item へ反映済みではないものとして扱い、直近の `ready` active revision snapshot から file を戻して revision を `failed` にする
- provider projection に forgotten item が残る状態を検出する
- DB は新しいが file が古い場合、active revision snapshot から file を復元する
- file は新しいが DB が古い場合、DB の active revision を正本として file を戻す

## Validation

- `mate_profile` は 0/1 row だけを許容する
- `state != 'active'` では session / companion / provider sync / Growth を開始しない
- Growth auto apply は event / revision / section update を同一 service transaction 境界で扱う
- forget / redact 後、同じ Growth が再抽出されないよう forgotten tombstone を Memory 生成 input に渡す
- Growth apply / correct / forget / disable は単一 writer lock を通す
- `projection_allowed = 0` の Growth が provider instruction projection に含まれないことを検証する
- forgotten Growth は profile、revision snapshot、evidence preview、project digest、provider projection から redaction する
- forget 後、provider instruction target は `redaction_required` になり、4.0.0 MVP では warning state として扱う
- provider instruction sync は `active_revision_id` を read snapshot とし、compose 後に revision が変わっていないことを再確認する
- `profile_generation` は `active_revision_id` と同じ transaction でだけ増加し、cursor の `last_profile_generation` はその値を保存する
- apply retry は `operation_id` または source event / claim / operation kind の idempotency key で重複を防ぐ
- provider instruction path は root 配下の相対 path だけ許可する
- sync run log / UI / docs に full local path をそのまま残さない
- revision retention / GC は別途 retention policy で決める

## Deferred / Validation Items

- Mate reset は 4.0.0 MVP で扱う。export / import と複数端末同期は後続設計へ送る
- 完全忘却時の過去 revision snapshot 物理削除 / redaction snapshot 置換は後続で詰める
- provider instruction sync schema には `project_digest_id` や `mate_project` projection scope を持たせない。Project Digest は prompt composition の一時 context として扱う

## Related

- `docs/design/single-mate-architecture.md`
- `docs/design/provider-instruction-sync.md`
- `docs/design/database-schema.md`
- `docs/design/database-v3-blob-storage.md`
