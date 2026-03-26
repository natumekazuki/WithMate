# Project Memory Storage

- 作成日: 2026-03-26
- 対象: `Project Memory` の永続化設計

## Goal

`Project Memory` を、Git 管理の有無に依存せず「作業対象単位の durable knowledge」として保存できるようにする。  
current doc では、まず retrieval ではなく persistence model を固定する。

## Position

`Project Memory` は `Session Memory` の上位互換ではない。役割は明確に分かれる。

- `Session Memory`
  - 今の session を継続するための working memory
  - compact 後や再開後に必要な scratchpad
- `Project Memory`
  - 同じ作業対象で次回以降も通用する durable knowledge
  - session をまたいで共有したい知識

つまり `Project Memory` は、`Session Memory` から昇格した長期知識の保存先である。

## Design Summary

v1 では、保存対象を 2 層に分ける。

1. `project_scopes`
- どの作業対象に属する memory かを表す anchor

2. `project_memory_entries`
- その作業対象で再利用したい知識本体

この 2 table を分けることで、

- Git project と directory project を同じ枠組みで扱える
- 1 つの project に複数の durable memory entry をぶら下げられる
- 将来 retrieval 用 index や embedding table を増やしやすい

## Project Identity

`Project Memory` は Git 前提にしない。`project_type` を持って anchor を分ける。

### `git`

- `git_root` を第一の anchor にする
- 必要なら `git_remote_url` を補助情報として保持する

### `directory`

- 正規化した `workspace_path` を anchor にする

## Project Scope Table

```ts
type ProjectScopeRow = {
  id: string;
  projectType: "git" | "directory";
  projectKey: string;
  workspacePath: string;
  gitRoot: string | null;
  gitRemoteUrl: string | null;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};
```

### Field Roles

- `id`
  - WithMate 内部の project scope id
  - UUID を前提にする
- `projectType`
  - `git` か `directory` か
- `projectKey`
  - uniqueness を取るための canonical key
  - `git` なら `gitRoot`
  - `directory` なら正規化した `workspacePath`
- `workspacePath`
  - session 起点で使っている workspace path
- `gitRoot`
  - Git project の anchor
- `gitRemoteUrl`
  - project 同定の補助情報
  - v1 では必須にしない
- `displayName`
  - UI や debug で読むための label
- `createdAt`
  - 初回作成時刻
- `updatedAt`
  - scope が最後に触られた時刻

## Project Memory Entry Table

```ts
type ProjectMemoryEntryRow = {
  id: string;
  projectScopeId: string;
  sourceSessionId: string | null;
  category: "decision" | "constraint" | "convention" | "context" | "deferred";
  title: string;
  detail: string;
  keywordsJson: string;
  evidenceJson: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};
```

### Field Roles

- `id`
  - entry id
- `projectScopeId`
  - `project_scopes.id` への foreign key
- `sourceSessionId`
  - どの session から昇格したか
  - trace 用であり必須ではない
- `category`
  - retrieval と review を助ける coarse category
- `title`
  - 一覧や短い prompt injection で使う要約
- `detail`
  - durable knowledge の本文
- `keywordsJson`
  - 検索補助の軽量キーワード
- `evidenceJson`
  - 根拠として残したい file path / issue / note などの参照
- `createdAt`
  - 作成時刻
- `updatedAt`
  - 最終更新時刻
- `lastUsedAt`
  - retrieval で使った時刻
  - v1 では null を許容する

## Category Policy

v1 の category は coarse に保つ。

- `decision`
  - project 全体に効く確定判断
- `constraint`
  - 制約や前提
- `convention`
  - naming / layout / tool usage などの慣例
- `context`
  - durable だが上記に収まりきらない背景知識
- `deferred`
  - 継続して「今はやらない」と決めた事項

細かい taxonomy は持ち込まない。

## SQLite Schema Draft

```sql
CREATE TABLE IF NOT EXISTS project_scopes (
  id TEXT PRIMARY KEY,
  project_type TEXT NOT NULL,
  project_key TEXT NOT NULL UNIQUE,
  workspace_path TEXT NOT NULL,
  git_root TEXT,
  git_remote_url TEXT,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_memory_entries (
  id TEXT PRIMARY KEY,
  project_scope_id TEXT NOT NULL REFERENCES project_scopes(id) ON DELETE CASCADE,
  source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_project_memory_entries_scope
  ON project_memory_entries(project_scope_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_memory_entries_category
  ON project_memory_entries(project_scope_id, category, updated_at DESC);
```

## Why No FTS / Embedding Yet

v1 の主眼は「何を durable knowledge として保存するか」を壊さずに決めることにある。  
そのため、次はまだ入れない。

- FTS5 table
- embedding column / vector store
- recency decay score
- RRF

これらは retrieval layer の follow-up として追加する。

## Promotion Input

`Session -> Project` 昇格時に最低限必要なのは次の 4 つ。

- `projectScopeId`
- `sourceSessionId`
- `category`
- `title / detail`

つまり、昇格処理がやることは

1. session の属する `project scope` を解決する
2. `Session Memory` か会話要約から durable knowledge を 1 entry に整形する
3. `project_memory_entries` に upsert する

である。

## Upsert Policy

v1 では aggressive な自動マージはしない。  
まずは append 寄りに保存し、重複統合は follow-up で扱う。

### Rule

- 同一 `projectScopeId` 内で
  - `category`
  - `title`
  - `detail`
  が完全一致なら再利用
- それ以外は新規 entry

これは retrieval quality よりも、誤統合を避けることを優先した設計である。

## Relationship To Session Memory

`Project Memory` は `Session Memory` の置き換えではない。

- `Session Memory`
  - 毎 session に 1 つ
  - 最新状態を保持
- `Project Memory`
  - 1 project に複数 entry
  - durable knowledge を蓄積

したがって storage も別 table にする。

## Future Extensions

- `project_memory_entry_links`
  - entry 同士の関連
- FTS5 index
- embedding store
- decay / score metadata
- review / approval metadata

## Related

- `docs/design/memory-architecture.md`
- `docs/design/electron-session-store.md`
