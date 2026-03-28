# Refactor Roadmap

- 作成日: 2026-03-28
- 対象: current 実装の機能棚卸しとリファクタ優先順

## Goal

WithMate の current 実装を、`今ある機能が何で、どこに責務が散っていて、どこから直すのが安全か` の観点で整理する。  
この文書は docs 精査の前段として、実装リファクタの優先順を固定するための土台にする。

## Why Refactor First

現時点の docs は current 実装へかなり追従しているが、まだ最終形ではない。  
この状態で docs を先に厳密化すると、リファクタで責務や構成が動いた時に手戻りが増える。

そのため順序は次のようにする。

1. 実装リファクタ
2. docs 精査

## Current Feature Map

current 実装は、大きく次の 8 ドメインに分けて考える。

### 1. Window / Navigation

- `Home Window`
- `Session Window`
- `Character Editor Window`
- `Diff Window`
- `Settings Window`
- `Session Monitor Window`

責務:

- window の生成 / 再利用 / focus
- 起動導線
- mode ごとの renderer 切り替え

主な実装:

- `src-electron/main.ts`
- `src-electron/preload.ts`
- `src/withmate-window.ts`
- `src/HomeApp.tsx`
- `src/App.tsx`

### 2. Session Runtime

- session 作成
- session 再開
- turn 実行
- approval
- additional directories
- terminal 起動
- diff / artifact
- run 状態更新

責務:

- coding session のライフサイクル
- 実行中 state と UI 投影

主な実装:

- `src-electron/main.ts`
- `src-electron/session-storage.ts`
- `src-electron/provider-runtime.ts`
- `src-electron/provider-artifact.ts`
- `src/App.tsx`

### 3. Provider Integration

- Codex adapter
- Copilot adapter
- provider 共通 prompt 合成
- model / reasoning / approval / custom agent

責務:

- provider 差分の吸収
- provider ごとの transport 変換

主な実装:

- `src-electron/codex-adapter.ts`
- `src-electron/copilot-adapter.ts`
- `src-electron/provider-prompt.ts`
- `src-electron/provider-runtime.ts`

### 4. Memory System

- `Session Memory`
- `Project Memory`
- `Character Memory`
- memory extraction
- project promotion
- retrieval / ranking
- 時間減衰

責務:

- 記憶の保存
- 記憶の抽出
- prompt / monologue への再利用

主な実装:

- `src-electron/session-memory-storage.ts`
- `src-electron/session-memory-extraction.ts`
- `src-electron/project-memory-storage.ts`
- `src-electron/project-memory-promotion.ts`
- `src-electron/project-memory-retrieval.ts`
- `src-electron/character-memory-storage.ts`
- `src-electron/character-memory-retrieval.ts`
- `src-electron/character-reflection.ts`
- `src-electron/memory-time-decay.ts`

### 5. Character System

- character storage
- character editor
- session copy
- monologue stream

責務:

- character 定義の保存と編集
- character 体験の UI 投影

主な実装:

- `src-electron/character-storage.ts`
- `src/CharacterEditorApp.tsx`
- `src/App.tsx`
- `src/app-state.ts`

### 6. Settings / Catalog

- coding provider settings
- memory extraction settings
- character reflection settings
- model catalog
- reset targets

責務:

- app-wide 設定の正本
- provider / model 選択肢の正本

主な実装:

- `src-electron/app-settings-storage.ts`
- `src-electron/model-catalog-storage.ts`
- `src/settings-ui.ts`
- `src/HomeApp.tsx`

### 7. Persistence / Audit

- sessions
- session memories
- project memories
- character memories
- audit logs
- database reset

責務:

- SQLite schema
- migration
- reset policy
- traceability

主な実装:

- `src-electron/session-storage.ts`
- `src-electron/audit-log-storage.ts`
- `src-electron/*-memory-storage.ts`
- `src-electron/main.ts`

### 8. UI Projection / Activity

- right pane activity
- latest command
- memory generation
- monologue
- rate limit / context usage

責務:

- backend state を Session UI に見える形で投影する

主な実装:

- `src/App.tsx`
- `src/styles.css`
- `src/app-state.ts`

## Current Hotspots

リファクタ優先度が高いのは次の 4 点である。

### 1. `src-electron/main.ts` への責務集中

current の `main.ts` は次を同時に持っている。

- window lifecycle
- session runtime orchestration
- memory / character reflection orchestration
- background activity 管理
- audit 記録
- reset 処理

最もリファクタ効果が大きい hotspot はここである。

### 2. `src/app-state.ts` の shared type 集中

`app-state.ts` は正本 type と normalize helper の置き場として機能しているが、domain ごとの境界がかなり厚くなっている。

特に:

- Session
- Memory
- Character
- Background Activity

が 1 ファイルに集中しているため、domain 単位で分ける余地がある。

current では first pass として `Memory / background activity` の shared type と helper を `src/memory-state.ts` へ切り出した。  
second pass として `provider config / app settings` も `src/provider-settings-state.ts` へ切り出した。  
third pass として `Character` shared state も `src/character-state.ts` へ切り出した。  
次の候補は `Session` 周辺の split である。

### 3. Settings / Catalog 境界の肥大化

Settings と model catalog は app-wide の正本として機能しているが、

- main process の read/write
- renderer の form state
- provider ごとの fallback / normalize

が複数箇所に散っている。

特に memory / character reflection 用の `model / reasoning / threshold` 設定は、  
今後も増えやすいため境界整理の優先度が高い。

### 4. UI state と backend projection の混在

`App.tsx` は Session Window の正本だが、

- command
- memory generation
- monologue
- audit overlay
- provider telemetry

まで 1 component に寄っている。

## Refactor Principles

### 1. File 単位ではなく機能単位で切る

先に `main.ts を小さくする` だけを目的にしない。  
`Session Runtime`、`Memory`、`Character Reflection` のように機能単位で切る。

### 2. Orchestration と Persistence を分ける

保存基盤と trigger / 実行制御を同じ service に混ぜない。  
最低限、次を分ける。

- storage
- retrieval
- orchestration

### 3. UI projection は最後に触る

backend の責務整理が先で、UI はその投影先として後から整える。

### 4. docs の大掃除は後回し

refactor で責務が固まってから、必要 / 不要 / 重複を精査する。

## Refactor Order

### Phase 1. Session Runtime Orchestration

最初に切る。

対象:

- session 起動 / 再開 / turn 実行
- background task の起動点
- in-flight 管理
- window close 時の session 連動

目的:

- `main.ts` から session 実行責務を剥がす

想定の受け皿:

- `src-electron/session-runtime-service.ts`
- `src-electron/session-window-bridge.ts`
- `src-electron/session-persistence-service.ts`

### Phase 2. Memory Orchestration

次に切る。

対象:

- Session Memory extraction trigger
- Project promotion
- Character reflection trigger
- background audit

目的:

- `main.ts` から Memory / Character の orchestration を剥がす

想定の受け皿:

- `src-electron/memory-orchestration-service.ts`

### Phase 3. Provider Boundary

対象:

- provider runtime interface
- prompt composition
- provider-specific background execution

目的:

- coding plane と background plane の実行境界を揃える

### Phase 4. Settings / Catalog Boundary

対象:

- app settings 読み書き
- model catalog 参照
- provider 設定の正規化

目的:

- renderer と main の両方から設定を参照する経路を整理する
- `app settings` と `model catalog` の更新・rollback・fallback を service に寄せる
- renderer の provider row 組み立てを view model helper に寄せる

### Phase 5. UI Projection

対象:

- Session Window の right pane
- provider telemetry
- monologue / memory generation 表示

目的:

- `App.tsx` を domain ごとの view model へ分ける

## First Refactor Slice

最初の具体タスクは `Session Runtime Orchestration` を切り出す。  
理由:

- `main.ts` の責務集中を最も直接的に減らせる
- Memory / Character 系の background task もここに依存している
- ここが整うと後続の `Memory Orchestration` も切りやすい

最初に扱う詳細:

1. turn 実行
2. cancel
3. in-flight 管理
4. live run / background task 起動点

current の first slice では、上の 4 点を `SessionRuntimeService` として切り出す。  
`session 起動 / 再開` は window lifecycle との結合がまだ強いため、次の slice で `session open/resume bridge` として分ける。

## Current Progress

- `SessionRuntimeService`
  - 完了
  - `turn 実行 / cancel / in-flight / live run / background task 起動点`
- `SessionWindowBridge`
  - 完了
  - `Session Window` の registry / close policy / session-start / session-window-close hook
- `SessionPersistenceService`
  - 完了
  - `create / update / delete / upsert`
  - provider/model 解決
  - session memory / scope 同期
  - bulk replace / migration / rollback / reset の write path
- `MemoryOrchestrationService`
  - 完了
  - `Session Memory extraction` trigger
  - `Character reflection` trigger
  - background audit / activity 更新
  - Project promotion / Character Memory 保存への橋渡し
- `SettingsCatalogService`
  - 完了
  - `app settings` 更新
  - `model catalog` import / rollback
  - `model catalog` export / reset
  - session / telemetry invalidation
- `home-settings-view-model`
  - 完了
  - provider row の resolved selection
  - normalized provider settings の再構成
  - persisted settings payload の組み立て
- `home-settings-draft`
  - 完了
  - provider settings draft 更新 helper
  - 単一 `AppSettings` draft を更新する wrapper
- `session-ui-projection`
  - 完了
  - right pane の `LatestCommand / MemoryGeneration / Monologue`
  - quota / background activity / active tab の表示ルール
- `session-components`
  - 完了
  - `Diff modal`、`Audit Log modal`、`context pane`、`retry banner`、compact `action dock row`、expanded `composer`、message column、artifact block、`session header` を component 化
- `home-session-projection`
  - 完了
  - session search / monitor grouping / empty message
  - Home monitor 用の派生状態
- `home-launch-projection`
  - 完了
  - launch dialog の provider / character / workspace 派生状態
  - launch 開始可否と filtered character list
- `home-launch-state`
  - 完了
  - launch dialog の open / close / reset ルール
  - `CreateSessionInput` の組み立て
- `home-character-projection`
  - 完了
  - Characters 右ペインの filtered list
  - search / empty state の表示ルール
- `home-settings-projection`
  - 完了
  - Settings Window の loading/reset 派生状態
  - reset target 行と実行可否の表示ルール
- `home-settings-actions`
  - 完了
  - Settings Window の import / export / save / reset async action
  - feedback 文言と result 解釈
- `home-components`
  - 完了
  - `Settings content`、`launch dialog`、`Recent Sessions`、`Home right pane` を component 化
- `memory-state`
  - 完了
  - `Session / Project / Character Memory`
  - `Character Reflection output`
  - `Session background activity`
  - memory normalize / clone helper を `app-state.ts` から分離
- `provider-settings-state`
  - 完了
  - `AppSettings`
  - coding provider settings
  - memory extraction settings
  - character reflection settings
  - settings normalize / resolve helper を `app-state.ts` から分離
- `character-state`
  - 完了
  - `CharacterProfile`
  - theme / session copy
  - character normalize / clone helper を `app-state.ts` から分離
- `session-state`
  - 完了
  - `Session / Message / StreamEntry`
  - `buildNewSession / normalizeSession / cloneSessions`
  - Session / Diff / Character editor の URL helper を domain ごとに整理
- `runtime-state`
  - 完了
  - `Audit / LiveRun / Telemetry / Composer`
  - runtime shared state を `app-state.ts` から分離
- `SessionObservabilityService`
  - 完了
  - `live run / provider quota / context telemetry / background activity`
  - refresh dedupe と delayed timer を `main.ts` から分離
- `SessionApprovalService`
  - 完了
  - pending approval request の待機 / resolve / abort cleanup
  - live run の `approvalRequest` 同期を `main.ts` から分離
- `AuditLogService`
  - 完了
  - audit log の `list / create / update / clear`
  - `main.ts` の write path を `AuditLogStorage` 直結から分離
- `WindowBroadcastService`
  - 完了
  - `sessions / characters / model catalog / app settings / open session windows`
  - observability event broadcast も含めて window 向け送信を `main.ts` から分離
- `WindowDialogService`
  - 完了
  - `model catalog` import/export
  - `directory / file / image picker`
  - dialog I/O helper を `main.ts` から分離
- `time-state`
  - 完了
  - 日時 label / ISO timestamp helper
  - `app-state.ts` に残っていた generic helper を分離
- `SessionMemorySupportService`
  - 完了
  - session 依存の memory/scope 同期
  - project promotion / prompt retrieval
  - character memory 保存 / monologue append
  - `main.ts` の memory helper を分離
- `CharacterRuntimeService`
  - 完了
  - `create/update/delete/get/refresh/resolveSessionCharacter`
  - session 側への character 表示同期
  - editor close を含む character CRUD bridge
- `WindowEntryLoader`
  - 完了
  - `home / session / character / diff` の entry 読み込み
  - `dev server / dist` 分岐
  - `main.ts` の window entry helper を分離
- `AuxWindowService`
  - 完了
  - `Home / Monitor / Settings / CharacterEditor / Diff` の window 生成 / 再利用 / registry
  - diff preview token 管理
  - non-session window 群を `main.ts` から分離
- `main-ipc-registration`
  - 完了
  - `ipcMain.handle(...)` 群を register helper に分離
  - target window 解決も DI 経由に統一
- `PersistentStoreLifecycleService`
  - 完了
  - persistent store の `initialize / close / recreate`
  - store bundle の生成と DB ファイル再生成を `main.ts` から分離
- `AppLifecycleService`
  - 完了
  - `activate / window-all-closed / before-quit` の app lifecycle を `main.ts` から分離
- `MainBootstrapService`
  - 完了
  - `whenReady()` の起動シーケンス
  - IPC registration deps の組み立てを `main.ts` から分離
- `provider-support`
  - 完了
  - provider catalog 解決
  - provider adapter 解決
  - quota fetch helper を `main.ts` から分離
- `MainInfrastructureRegistry`
  - 完了
  - `WindowBroadcast / WindowDialog / WindowEntryLoader / AuxWindow / PersistentStoreLifecycle / AppLifecycle / MainBootstrap`
  - infrastructure singleton の lazy 生成と reset を `main.ts` から分離
- `MainQueryService`
  - 完了
  - session / character の query
  - skill / custom agent discovery
  - composer preview / workspace search / terminal 起動
  - `main.ts` の query helper を分離
- `MainObservabilityFacade`
  - 完了
  - provider quota / session context / background activity / live run
  - observability の forwarding と quota refresh helper を `main.ts` から分離
- `MainBroadcastFacade`
  - 完了
  - sessions / characters / model catalog / app settings / open session windows
  - broadcast payload の組み立てと forwarding を `main.ts` から分離
- `MainSessionCommandFacade`
  - 完了
  - session create/update/delete/run/cancel
  - Copilot quota refresh 前処理を含む command forwarding を `main.ts` から分離
- `MainSessionPersistenceFacade`
  - 完了
  - `upsertSession / replaceAllSessions / recoverInterruptedSessions`
  - session persistence wrapper を `main.ts` から分離
- `MainProviderFacade`
  - 完了
  - model catalog / provider adapter / thread invalidation
  - provider 関連の thin wrapper を `main.ts` から分離
- `MainCharacterFacade`
  - 完了
  - list / refresh / get / create / update / delete / resolveSessionCharacter
  - character query/runtime の束ねを `main.ts` から分離
- `MainWindowFacade`
  - 完了
  - `open*Window / listOpenSessionWindowIds / closeResetTargetWindows`
  - window 操作の thin wrapper を `main.ts` から分離
- `Provider Boundary`
  - 完了
  - `ProviderCodingAdapter / ProviderBackgroundAdapter / ProviderTurnAdapter` の責務分割
  - coding plane の quota / thread invalidation と background plane の memory / reflection 実行を分離
  - `MainProviderFacade`、`MainObservabilityFacade`、`MemoryOrchestrationService` の依存を plane ごとに整理
- `Provider Adapter Internals`
  - 完了
  - `CodexAdapter` と `CopilotAdapter` の background 実行 helper を共通 private method に整理
  - `runSessionTurn` の stream event 集約を state/helper に寄せ、coding plane 側の実装境界を読みやすくした
- `Provider Coding Runtime Cleanup`
  - 完了
  - `SessionRuntimeService` を `ProviderCodingAdapter` 専用依存へ変更
  - `MainProviderFacade` / `main.ts` の曖昧な `getProviderAdapter` wrapper を除去
  - `provider-support` の公開 helper を coding/background 入口へ整理
- `withmate-window` IPC public surface
  - 完了
  - IPC channel 定数、window bridge type、reset type を module ごとに分離
  - `src/withmate-window.ts` は public entry として re-export のみを担当
- `preload-api`
  - 完了
  - preload 側の `invoke / subscribe` bridge を domain ごとの helper に分離
  - `src-electron/preload.ts` は `contextBridge.exposeInMainWorld(...)` のみを担当
- `main-ipc-registration`
  - 完了
  - window / catalog / settings / session query / session runtime / character の register group に整理
  - IPC registration の読み順を domain 単位へ固定
- `main-ipc-deps`
  - 完了
  - IPC registration builder の入力を `window / catalog / settings / sessionQuery / sessionRuntime / character` に grouped 化
  - `main-bootstrap-deps` と `main.ts` の wiring も同じ grouping に揃えた
- 次の候補
  - preload / IPC boundary の unit test を domain ごとに増やすかの判断
  - renderer 側から見た `withmateApi` 利用箇所の型 import 整理

## After Refactor

実装の責務が固まった後で、次を行う。

1. docs 精査
2. 不要 doc の統合 / 削除判断
3. `database-schema.md` を含む current 正本群の再整理

## Related

- `docs/design/window-architecture.md`
- `docs/design/provider-adapter.md`
- `docs/design/memory-architecture.md`
- `docs/design/database-schema.md`
