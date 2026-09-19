# Electron Session Store

- 作成日: 2026-03-12
- 対象: Electron Main Process が持つ session / audit / memory persistence の責務分離

## Goal

Electron Main Process が `session metadata` と session payload の source of truth を持ち、  
SQLite-backed store により window 間整合と再起動後の復元を両立する current 実装を説明する。

## Position

- この文書は persistence orchestration の supporting doc として扱う
- table / JSON カラムの正本は `docs/design/database-schema.md` を参照する
- running session の lifecycle と background hook は `docs/design/session-run-lifecycle.md` を参照する
- BrowserWindow / preload / bootstrap detail は `docs/design/electron-window-runtime.md` を参照する

## Scope

- Main Process 内の SQLite-backed session / audit / memory persistence
- preload 経由の session query / command API
- persistence service の責務境界
- Home / Session Renderer の store 参照切り替え

## Out Of Scope

- BrowserWindow の生成や再利用 policy
- provider adapter の詳細
- table 定義の全文
- renderer UI の詳細

## Decision

- Main Process は SQLite を正本にし、必要時だけ `Session[]` をメモリへ投影する
- Renderer は `window.withmate` 経由でのみ session / audit / settings に触る
- Homeのsession一覧は `listSessionSummaryPage()` をstorage query ownerへ送り、recent / pinned / openをboundedに取得する。検索もstorage側で行い、Homeへ全summary配列を返さない
- session summary の変更通知は `scope: "ids"` または `scope: "all"` のinvalidationを `WindowBroadcastService` からHome / Session windowへ配信する。IDは最大256件で、超過時に切り捨てず `all` へ切り替える
- Session windowはinvalidationを受けた対象だけ `getSession()` で再 hydrateする。Homeはquery generationで古いresponseを失効させ、検索条件変更時だけcursor chainを初期化する。focus、open Session ID変更、invalidationでは読み込み済みrecent / pinned pageとopen special entryを保持したままboundedに再同期する
- session CRUD と bulk write path は `SessionPersistenceService` に集約する
- turn 実行は `SessionRuntimeService`、window lifecycle hook は `SessionWindowBridge` が担う
- Session / Project / Character Memory の session 起点補助は `SessionMemorySupportService` が担う
- Session Memory / Character Reflection の background orchestration は `MemoryOrchestrationService` が担う
- persistent store の初期化 / close / recreate は `PersistentStoreLifecycleService` が担う

## Runtime Model

```mermaid
flowchart LR
    HR[Home Renderer] -->|window.withmate| PL[Preload]
    SR[Session Renderer] -->|window.withmate| PL
    PL -->|ipc invoke / subscribe| MP[Main Process]
    MP --> PERSIST[Persistence Services]
    PERSIST --> STORE[(SQLite / file storage)]
    MP --> BROADCAST[WindowBroadcastService]
    BROADCAST -->|bounded query invalidation| PL
    PL --> HR
    PL --> SR
```

## Persistence Services

### SessionPersistenceService

- `createSession`
- `updateSession`
- `deleteSession`
- `deleteSessionsLastActiveBefore`
- `upsertSession`
- `replaceAllSessions`
- `listSessions`
- `getSession`

`sessions` table を正本にしつつ、Main Process 内の in-memory projection と同期する。
session 削除の副作用は単一削除と cutoff bulk 削除で同じ内部経路を通す。
cutoff bulk 削除では storage が `last_active_at` から対象 id を列挙し、実行中の session は削除対象から skip する。

### AuditLogService

- `listSessionAuditLogs`
- `createAuditLog`
- `updateAuditLog`
- `clearSessionAuditLogs`

`audit_logs` の read / write を一箇所に集約する。

### SessionMemorySupportService

- `session_memories` の同期
- project scope / character scope の同期
- project promotion / retrieval
- character memory 保存補助
- monologue append

session 実行後の memory 補助処理を persistence 側へつなぐ。

### SettingsCatalogService

- `app_settings`
- `model_catalog_*`
- reset / import / export と関連 invalidation

session 以外の app-wide persistence をまとめて扱う。

Settings credential 更新時の thread reset は collection 全体の置換を使わず、対象行の thread と更新時刻だけを条件付き更新する。Main は ID・incarnation・provider・元 thread、Auxiliary は ID・親 ID・作成時刻・provider・元 thread を照合し、削除済み行や別 thread を上書きしない。Auxiliary の payload / summary は transaction 内で現行値から更新し、本文・draft・他会話を保持する。Main の cache も現行行の対象 field のみ更新し、保存結果から削除済み cache を復活させない。

後続処理に失敗した場合は設定を rollback し、更新成功を確認できた thread だけを同じ identity と更新後 thread を条件に戻す。本文等の並行更新は戻さず、削除・再作成・別 thread への変更はスキップする。書込み結果が不明な例外を成功扱いせず、その対象へ無条件の逆書込みをしない。この場合は thread がリセットされたまま残る可能性がある。設定だけの失敗で collection snapshot を復元しない。

model catalog import の rollback は、置換を試みた Main / Auxiliary / Companion collection に限定する。先行 collection の保存失敗で、未試行 collection の並行更新・削除を古い snapshot へ戻さない。書込み後に例外となる既存経路もあるため、試行済み collection は保存成功の応答がなくても復元を試みる。元の失敗は伝播し、rollback も失敗した場合は両方を AggregateError に保持する。

model catalog の import/reset は catalog 本体を revision 単位で置換するが、既存 Session / Auxiliary / Companion の runtime metadata は対象 field の条件付き CAS で更新する。比較には各行の現行 identity と provider runtime metadata を使い、本文・draft・messages・無関係な削除を snapshot で戻さない。成功を確認できた対象だけを同じ identity と更新後 metadata に対して reverse CAS し、書込み結果不明の対象へ無条件の逆書込みはしない。未試行 collection の並行変更は保持する。

Issue #726 の残作業は、cleanup 中の影響 provider に対する Turn admission の完全な統合、provider thread 外部後処理と Worker generation の最終検証である。

### PersistentStoreLifecycleService

- store 初期化
- close
- close 時の WAL truncate checkpoint
- DB 再生成前の WAL truncate checkpoint

Main Process の bootstrap / reset から persistent store を束ねる。
WAL truncate checkpoint は best-effort とし、失敗しても close / recreate を中断しない。

### WAL Maintenance Timer

- Main Process が `startWalMaintenance()` / `stopWalMaintenance()` で interval を管理する
- interval は 5 分ごとに WAL size を確認し、64 MiB を超えている場合だけ truncate checkpoint を実行する
- interval 側の checkpoint は短い busy timeout を使い、Main Process の event loop block を抑える

## Query / Command Boundary

Renderer は `window.withmate` から session 系 API を呼ぶ。  
Main Process 側では `MainQueryService`、`SessionRuntimeService`、`SessionPersistenceService`、`AuditLogService` などへ振り分ける。

### 主な query

- `listSessions`
- `getSession`
- `listSessionAuditLogs`
- `listSessionSkills`
- `listSessionCustomAgents`

### 主な command

- `createSession`
- `updateSession`
- `deleteSession`
- `deleteSessionsLastActiveBefore`
- `runSessionTurn`
- `cancelSessionTurn`

## Persistence Boundary

- `sessions`
  - session metadata
  - `messages_json`
  - `stream_json`
  - `session_kind` による用途分離
- `session_memories`
  - `Session Memory v1`
- `audit_logs`
  - turn 実行と background task の監査ログ
- `project_scopes` / `project_memory_entries`
  - project 単位の durable knowledge
- `character_scopes` / `character_memory_entries`
  - character 単位の関係性記憶

table 詳細と JSON カラム一覧は `docs/design/database-schema.md` を参照する。

## Renderer Responsibilities

### Home Renderer

- boundedなsession summary pageの取得、cursor chain、検索generationの管理
- session invalidation受信時のloaded recent / pinned page、open special entryのbounded refresh
- random Character用のCharacter usage projectionとopen Session ID chunkの利用
- Settings / Model Catalog 操作
- `createSession()` 後の Session Window 起動

### Session Renderer

- 初回 `getSession()` と軽量 invalidation 通知受信時の再 hydrate
- title / approval / model / reasoning depth の更新
- turn 実行と cancel
- audit log / observability 表示

## Relation To Current Docs

- `database-schema.md`
  - table / JSON カラムの正本
- `session-run-lifecycle.md`
  - turn 実行と background task の lifecycle
- `electron-window-runtime.md`
  - BrowserWindow / preload / bootstrap detail

## Open Questions

- `messages_json` / `stream_json` を今後どの粒度で正規化するか
- audit log export を後で追加するか
- `Session Memory` / `Project Memory` / `Character Memory` の renderer expose をどこまで広げるか
