# Plan

- task: Pre-V5 delete feature cleanup
- date: 2026-06-12
- target version: v4.9.9
- owner: Codex
- design anchor: `docs/design/v5-character-transition.md`

## 目的

V5 Character 化に入る前に、V4 SingleMate / Memory / Growth 周辺で V5 初期 scope に持ち込まない機能をコードベースから一旦削除し、v4.9.9 を Character-first 再設計前のきれいな足場にする。

この plan は実装そのものではなく、削除対象、残す境界、削除順序、検証観点を固定するための棚卸しである。

## 前提

- V5 の方針正本は `docs/design/v5-character-transition.md` とする。
- V5 初期 scope は Character catalog / Character Definition / `character.md` runtime snapshot / prompt injection boundary に絞る。
- V4 SingleMate の延命になる Mate Profile / Growth / Memory / MateTalk 追加投資は止める。
- provider adapter、session runtime、Companion review、model catalog など V5 でも使う低レイヤーは削除対象にしない。
- 既存ユーザーデータを破壊する DB migration はこの cleanup には含めない。必要なら read path を外すだけにし、物理削除は別 Issue に分ける。

## 削除方針

削除の主目的は「未完成の SingleMate / Memory runtime を残したまま V5 設計へ入らないこと」である。

優先して外すもの:

- background Memory Candidate / Growth apply / embedding retrieval の実行経路
- MateTalk と、それに付随する Memory 生成経路
- Memory Management window と Memory 管理 IPC
- provider instruction sync による Mate projection 永続同期
- Mate Profile / Growth UI のうち、V5 Character 初期 scope に直接つながらない操作
- 旧 Character catalog 互換型のうち、現行 runtime から参照されていないもの

慎重に残すもの:

- session / companion の既存履歴を読むための最小型
- session 起動、provider runtime、audit log、model catalog
- V5 で再利用する可能性がある `character.md` / Character Definition 関連 design docs
- app database reset / diagnostics の低レイヤー

## 対象カテゴリ

| Category | 削除候補 | 主なファイル | 方針 |
| --- | --- | --- | --- |
| MateTalk | メイトーク window、chat mode、runtime workspace、turn service | `src/chat/MateTalkChatModeApp.tsx`, `src/chat/mate-talk-*.ts*`, `src-electron/mate-talk-*.ts`, `src/withmate-ipc-channels.ts`, `src/withmate-window-api.ts` | V5 初期 scope では Character Editor / Character Definition を先に設計するため削除候補 |
| Mate Growth | Growth settings、Growth event UI、auto apply timer、Profile update pipeline | `src/mate/mate-growth-*.ts`, `src-electron/mate-growth-*.ts`, `src-electron/main-bootstrap-service.ts`, `src-electron/main.ts` | SingleMate 延命なので v4.9.9 では外す |
| Mate Memory generation | Memory Candidate 生成、runtime workspace、schema、runner、scheduler | `src-electron/mate-memory-generation-*.ts`, `src-electron/mate-memory-runtime-instructions.ts`, `src-electron/memory-runtime-workspace.ts`, `src-electron/mate-memory-storage.ts` | V5 初期 non-goal。background provider call を止める |
| Embedding / semantic retrieval | local embedding cache、download UI、semantic index / retrieval | `src-electron/mate-embedding-*.ts`, `src-electron/mate-semantic-embedding-*.ts`, `src/mate/mate-embedding-settings.ts` | Memory 再設計に属するため削除候補 |
| Project Digest / project context | Profile Item 由来の project digest injection | `src-electron/mate-project-*.ts`, `src-electron/mate-project-context-*.ts` | V5 Character 初期では raw memory / growth history を prompt に入れないため削除候補 |
| Memory management | Memory 管理 window、page state、delete IPC | `src/memory/*`, `src-electron/memory-management-service.ts`, `src/withmate-window-api.ts`, `src/withmate-ipc-channels.ts` | 旧 Memory / Mate Profile Item 管理 UI として削除候補 |
| Session / Project memory runtime | session memory extraction / support / promotion / project retrieval | `src-electron/session-memory-*.ts`, `src-electron/project-memory-*.ts`, `src-electron/memory-orchestration-service.ts` | prompt 注入や自動生成は外す。互換 read が必要かは実装前に参照追跡 |
| Provider Instruction Sync | Mate projection を provider instruction file へ同期する設定・storage・sync | `src/provider-instruction-target-state.ts`, `src/settings/provider-instruction-target-*.ts`, `src-electron/provider-instruction-target-*.ts`, `src-electron/mate-provider-instruction-*.ts` | V5 では Character 注入の主経路にしないため削除候補 |
| Mate Profile core | SingleMate の profile storage / profile item / projection refresh / setup UI | `src/mate/MateProfileScreen.tsx`, `src/mate/MateSetupPanel.tsx`, `src/mate/mate-state.ts`, `src-electron/mate-storage.ts`, `src-electron/mate-profile-*.ts` | V5 の Character storage 設計に置換予定。全削除前に Home / session の依存を薄くする |
| Legacy Character types | 旧 `CharacterProfile` / catalog / session copy 型 | `src/character-state.ts`, `scripts/tests/character-state.test.ts` | 未参照なら削除。session/companion snapshot 互換で使うなら最小型へ縮小 |

## 残す対象

| Area | 理由 |
| --- | --- |
| `src-electron/provider-runtime.ts` と provider adapters | V5 でも session 実行基盤として使う |
| `src-electron/session-runtime-service.ts` / `src-electron/session-persistence-service.ts` | Character snapshot injection の受け皿になる |
| Companion review / merge / git service | V5 Character 化とは別軸の現行価値があり、削除対象に混ぜない |
| Model catalog / provider settings | V5 の provider selection に必要 |
| Audit log / live run / approval / elicitation | provider runtime の観測と安全境界として必要 |
| `docs/design/character-definition-format.md`, `docs/design/character-storage.md`, `docs/design/character-update-workspace.md` | V5 future candidate として読む対象。削除ではなく legacy/future candidate の扱いを明記する |

## 実装順序

### Phase 0: Inventory lock

- [ ] `git grep` または `Select-String` で次の参照数を記録する: `MateTalk`, `mate-talk`, `mate-memory`, `mate-growth`, `MemoryManagement`, `providerInstruction`, `ProviderInstructionTarget`, `ProjectDigest`, `CharacterProfile`, `characterId`
- [ ] `src/withmate-ipc-channels.ts`、`src/withmate-window-api.ts`、`src-electron/main-ipc-registration.ts`、`src-electron/main-ipc-deps.ts` の公開 API を削除候補別に表へ落とす
- [ ] `src-electron/main.ts` の singleton / factory / startup cleanup / timer / reset path を削除候補別に表へ落とす

### Phase 1: Public surface を閉じる

- [x] Home から Memory Management、MateTalk の導線を外す
- [x] Settings から Growth、Embedding、Provider Instruction Sync の導線を外す
- [x] renderer API から該当 method を削除する
- [x] IPC channel constant と main handler を同じ commit で削除する
- [x] preload / `window.withmate` surface から該当 API を消す

Progress:

- 2026-06-13: Phase 1 public surface を削除。`Home` の Memory Management / MateTalk 表示導線、renderer API、IPC channel / handler、preload / `window.withmate` から Memory Management、MateTalk、Growth、Embedding、Provider Instruction Sync を外した。内部 service / storage / runtime side effect は Phase 2 / Phase 3 の対象として残す。
- 2026-06-13: Review 指摘対応で `SettingsContent` の早期 return を削除し、Default Microcopy、Mate Memory Generation、Mate Reset、Model Catalog など既存 Settings UI を復帰した。
- 2026-06-13: 追加 Review 指摘対応で Settings 内の Growth / Embedding / Provider Instruction Sync surface を非表示化し、`scripts/tests/home-components.test.tsx` に削除対象 Settings surface が static render に出ないことを固定する negative test を追加した。既存 provider instruction target の runtime sync は Phase 2 の runtime side effect 停止対象として分離する。
- 2026-06-13: 公開面残存検索として `src/withmate-ipc-channels.ts`、`src/withmate-window-api.ts`、`src-electron/preload-api.ts`、`src-electron/main-ipc-registration.ts`、`src-electron/main-ipc-deps.ts` に対し、削除対象 API 名の `Select-String` 検索を実行し、該当なしを確認。
- 2026-06-13: 検証は `npm run typecheck`、`node --import tsx --test scripts/tests/home-components.test.tsx`、`node --import tsx --test scripts/tests/main-ipc-registration.test.ts scripts/tests/preload-api.test.ts scripts/tests/renderer-withmate-api.test.ts`、`node --import tsx --test scripts/tests/home-window-mode.test.ts scripts/tests/home-launch-state.test.ts scripts/tests/home-launch-projection.test.ts scripts/tests/home-launch-commands.test.ts`、`node --import tsx --test scripts/tests/main-ipc-deps.test.ts scripts/tests/main-bootstrap-deps.test.ts` が成功。

### Phase 2: Runtime side effects を止める

- [x] app 起動時の Growth apply timer を削除する
- [x] session / companion turn 後の Mate Memory generation scheduling を削除する
- [x] MateTalk turn 後の Memory generation scheduling を削除する
- [x] provider instruction target への Mate projection sync を session 起動前 path から外す
- [x] provider instruction target への Mate projection sync を Mate 作成 / 更新 / avatar 更新 / Growth apply / profile item refresh path から外す
- [x] memory-runtime / mate-talk temporary workspace cleanup が不要になることを確認して削除する

Progress:

- 2026-06-13: Phase 2 runtime side effects を停止。`MainBootstrapService` から Growth apply timer / stale growth cleanup 実行経路を外し、互換 API は timer を作らない no-op とした。`SessionRuntimeService` と `MateTalkService` から Mate Memory generation scheduling hook を削除し、`main.ts` の session / MateTalk callback 注入と `MateMemoryGenerationService` lazy factory を外した。Companion turn には該当 scheduling path がないことを確認した。
- 2026-06-13: provider instruction target への Mate projection sync は、Mate 作成 / 更新 / avatar 更新 / Growth apply / profile item refresh path から外した。session 起動前の明示 sync path は現行コード上で未検出。Mate reset / DB reset の disabled cleanup は既存 marker block の明示 cleanup として残し、Phase 3 の service/storage 削除対象へ分離した。
- 2026-06-13: 起動時の `cleanupMemoryRuntimeWorkspaceOnStartup` と persistent store 初期化後の `cleanupMateTalkSessionFilesDirectories` 呼び出しを削除し、memory-runtime / MateTalk temporary workspace cleanup が起動時に走らないようにした。
- 2026-06-13: 残存検索として `src-electron/main.ts`、`src-electron/main-bootstrap-service.ts`、`src-electron/main-bootstrap-deps.ts`、`src-electron/session-runtime-service.ts`、`src-electron/mate-talk-service.ts` に対し、`scheduleMateMemoryGeneration`、`scheduleMemoryGeneration`、`createGrowthApplyTimer`、`cleanupStaleGrowthApplyRuns`、`cleanupMemoryRuntimeWorkspaceOnStartup`、`cleanupMateTalkSessionFilesDirectories`、`syncEnabledProviderInstructionTargetsForMateProfile`、`syncEnabledProviderInstructionTargets(` の `Select-String` 検索を実行し、該当なしを確認。
- 2026-06-13: 検証は `npm install` 後に `npm run typecheck` と `node --import tsx --test scripts/tests/main-bootstrap-service.test.ts scripts/tests/mate-talk-service.test.ts scripts/tests/session-runtime-service.test.ts` が成功。`npm install` では既存依存に 8 件の audit warning が出たが、この Phase 2 変更では未対応。

### Phase 3: Service / storage を削る

- [x] `mate-memory-*`、`mate-growth-*`、`mate-embedding-*`、`mate-semantic-embedding-*`、`mate-project-*` service と対応 tests を削除する
- [x] `memory-management-*` UI / state / service と対応 tests を削除する
- [x] `provider-instruction-target-*` と `mate-provider-instruction-*` を削除する
- [x] `session-memory-*`、`project-memory-*`、`memory-orchestration-service.ts` は参照追跡後、runtime 削除と legacy storage 互換保持に分類する
- [x] `mate-storage.ts` / `mate-state.ts` / Mate setup UI は、Phase 4 の Mate 未作成 gate 解除 / minimal app state 化へ移管する

Progress:

- 2026-06-13: Phase 3 の初回 slice として、Electron main から Mate Memory / Growth / Embedding / semantic embedding / Mate project context / Provider Instruction Target / Memory Management service への singleton、factory、reset cleanup、session / companion prompt injection 依存を削除した。Memory Management dedicated window route は `AuxWindowService` / `MainWindowFacade` から削除した。
- 2026-06-13: `src-electron/mate-memory-*`、`src-electron/mate-growth-*`、`src-electron/mate-embedding-*`、`src-electron/mate-semantic-embedding-*`、`src-electron/mate-project-*`、`src-electron/mate-provider-instruction-*`、`src-electron/provider-instruction-target-*`、`src-electron/memory-management-service.ts` と対応する service/storage tests を削除した。`copilot-adapter.test.ts` は Mate Memory prompt schema への fixture 依存をローカル schema に置換した。
- 2026-06-13: レビュー指摘対応として、`HomeEntryMode` から削除済み Memory Management route の `"memory"` を外し、renderer 側 `HomeWindowMode` との entry contract を揃えた。`main.ts` の app settings helper 名から Growth sync 前提を外し、未参照の `forgetMateProfileItemAndRefreshProjection` helper も削除した。
- 2026-06-13: 追加レビュー指摘対応として、SettingsContent から Memory Management 専用 props / standalone mode、Mate Memory Generation、Mate Growth、Mate Embedding、Provider Instruction Sync の hidden UI / props / label constants を削除した。renderer 側 `src/memory/memory-management-*` と `MemoryManagementWindowScreen`、未使用の renderer Growth action / handler と Embedding settings 型、対応する stale tests も削除した。
- 2026-06-13: 追加レビュー指摘対応として、未参照になっていた renderer Growth artifact の `src/mate/mate-growth-feedback.ts`、`src/mate/mate-growth-apply-result.ts`、`src/mate/mate-growth-events-state.ts` と対応 test を削除した。Growth schema / storage は `mate-storage.ts` / `mate-state.ts` の legacy 境界として後続 slice に残る。
- 2026-06-13: Provider Instruction marker cleanup は v4.9.9 では one-shot 実装しない方針に決定。reset / DB recreate では外部 provider instruction file を触らず、既存ユーザー環境に残る WithMate marker block は V5 では参照しない残置物として扱う。cleanup が必要なら V5 移行後の別 Issue で明示操作として扱う。
- 2026-06-13: `session-memory-*`、`project-memory-*`、`memory-orchestration-service.ts` は `SessionRuntimeService` / persistence / reset 契約にまだ残るため今回 slice では保持した。renderer 側 `src/memory/memory-state.ts` は session / project memory runtime の互換型として残る。
- 2026-06-13: 検証は `npm install` 後に `npm run typecheck`、`node --import tsx --test scripts/tests/main-ipc-registration.test.ts scripts/tests/preload-api.test.ts scripts/tests/main-ipc-deps.test.ts scripts/tests/main-bootstrap-deps.test.ts scripts/tests/aux-window-service.test.ts scripts/tests/main-window-facade.test.ts scripts/tests/copilot-adapter.test.ts`、`node --import tsx --test scripts/tests/session-runtime-service.test.ts scripts/tests/companion-runtime-service.test.ts scripts/tests/session-persistence-service.test.ts scripts/tests/companion-session-service.test.ts`、レビュー指摘対応後に `node --import tsx --test scripts/tests/window-entry-loader.test.ts scripts/tests/aux-window-service.test.ts scripts/tests/main-window-facade.test.ts scripts/tests/main-bootstrap-deps.test.ts scripts/tests/main-ipc-deps.test.ts scripts/tests/mate-profile-projection-refresh-service.test.ts` が成功。追加 slice 後に `npm run typecheck` と `node --import tsx --test scripts/tests/home-components.test.tsx scripts/tests/settings-ui.test.ts scripts/tests/home-settings-projection.test.ts scripts/tests/home-settings-actions.test.ts scripts/tests/home-settings-view-model.test.ts scripts/tests/mate-status-load-operation.test.ts scripts/tests/main-ipc-registration.test.ts scripts/tests/preload-api.test.ts scripts/tests/main-ipc-deps.test.ts scripts/tests/main-bootstrap-deps.test.ts scripts/tests/session-memory-storage.test.ts scripts/tests/project-memory-retrieval.test.ts scripts/tests/project-memory-promotion.test.ts` が成功。`npm install` では既存依存に 8 件の audit warning が出たが、この cleanup では未対応。
- 2026-06-13: Phase 3 completion slice として、通常 Session turn の `SessionRuntimeService` 接続を default session memory / empty project memory に切り替え、Project Memory prompt injection を停止した。`src-electron/memory-orchestration-service.ts`、`src-electron/project-memory-retrieval.ts`、`src-electron/project-memory-promotion.ts` と対応 tests を削除し、`SettingsCatalogService` の reset 契約から memory orchestration reset を外した。`SessionMemorySupportService` は起動時の既存 session memory metadata / project scope 同期だけを残す互換境界に縮小した。
- 2026-06-13: `session-memory-storage.ts` / `project-memory-storage.ts` / `session-memory-extraction.ts` / `src/memory/memory-state.ts` は既存 DB の read / delete / diagnostics / provider structured output parser 互換として保持する。background extraction / promotion / prompt retrieval の実行経路は削除済みで、既存 DB の物理 migration や table drop はこの cleanup では行わない。
- 2026-06-13: `mate-storage.ts` / `mate-state.ts` / `MateSetupPanel` / `MateProfileScreen` は Phase 3 では削除しない。Home / session 起動の Mate 未作成 gate 解除、minimal app state 化、Character neutral state 化と同時に扱う Phase 4 前提作業へ移管する。
- 2026-06-13: MateTalk runtime / window / chat mode は公開導線と送信実行を閉じた状態で Phase 4 へ移管する。残存する `MateTalkChatModeApp`、`use-mate-talk-window-state.ts`、`mate-talk-*`、`MateTalkService`、window entry / facade 経路は Character-first session shell 再整理時に削除または再定義する。
- 2026-06-13: completion slice の検証は `npm run typecheck`、`node --import tsx --test scripts/tests/session-memory-support-service.test.ts scripts/tests/settings-catalog-service.test.ts scripts/tests/main-ipc-registration.test.ts scripts/tests/preload-api.test.ts scripts/tests/main-ipc-deps.test.ts scripts/tests/main-bootstrap-deps.test.ts`、`node --import tsx --test scripts/tests/session-runtime-service.test.ts scripts/tests/session-memory-support-service.test.ts scripts/tests/settings-catalog-service.test.ts`、`node --import tsx --test scripts/tests/session-runtime-service.test.ts scripts/tests/session-persistence-service.test.ts scripts/tests/companion-runtime-service.test.ts scripts/tests/companion-session-service.test.ts`、`node --import tsx --test scripts/tests/home-components.test.tsx scripts/tests/settings-ui.test.ts scripts/tests/home-settings-projection.test.ts scripts/tests/home-settings-actions.test.ts scripts/tests/home-settings-view-model.test.ts`、`node --import tsx --test scripts/tests/session-memory-storage.test.ts scripts/tests/project-memory-storage.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts` が成功。`npm install` では既存依存に 8 件の audit warning が出たが、この cleanup では未対応。

Phase 3 legacy boundaries:

- `src-electron/session-memory-storage.ts` / `src-electron/project-memory-storage.ts`: 既存 DB の read / delete / reset target / diagnostics 互換のため保持する。V5 初期 scope では prompt injection や background generation には接続しない。
- `src-electron/session-memory-support-service.ts`: 起動時に既存 session memory metadata と project scope を同期する互換 helper として保持する。Project Memory retrieval / promotion は削除済み。
- `src-electron/session-memory-extraction.ts`: provider structured output parser と既存 tests の互換として保持する。background extraction を呼ぶ service は削除済み。
- `src/mate/mate-state.ts` / `src-electron/mate-storage.ts` / `src/mate/MateSetupPanel.tsx` / `src/mate/MateProfileScreen.tsx`: Mate 未作成 gate と Home 表示が残るため Phase 4 へ移管する。
- MateTalk runtime / window / chat mode: Home からの公開導線と送信実行は閉じた状態で、Phase 4 の Character-first session shell 整理へ移管する。

### Phase 4: Character-first の足場へ戻す

- [x] Home は SingleMate 必須 gate ではなく、V5 Character 未実装の neutral state にする
- [x] session 起動は Mate 未作成 block に依存しないようにする
- [x] `character.md` snapshot / Character catalog の詳細設計へ入るため、旧 Character design docs の扱いを `docs/design/v5-character-transition.md` から明示参照する
- [x] package version を `4.9.9` にする

Progress:

- 2026-06-13: Phase 4 として、Home の Mate 未作成 gate を解除した。`HomeApp` は Mate 未作成でも session / companion summaries subscription を開始し、主要 Home 操作は Mate profile の有無ではなく Mate state load 完了後に使えるようにした。`HomeAppRouter` は `not_created` で `MateProfileScreen` へ強制遷移しない。
- 2026-06-13: session / companion 起動 payload は Mate profile が無い場合に `withmate-neutral-character` / `WithMate` / default character theme の neutral snapshot を使うようにした。launch validation と launch dialog open handler から Mate 作成必須 check を削除した。
- 2026-06-13: Electron main IPC wrapper の Mate 作成必須 gate を削除し、Mate 未作成でも session runtime IPC を wrapper が block しないようにした。Mate 作成 / 更新 API 自体は既存 Mate service の責務として残す。
- 2026-06-13: `docs/design/v5-character-transition.md` に旧 Character docs の扱いを追記し、`character-definition-format.md`、`character-storage.md`、`character-update-workspace.md` は Phase 4 時点の正本ではなく V5 詳細設計の future candidate と明記した。
- 2026-06-13: `package.json` / `package-lock.json` の version を `4.9.9` に更新した。
- 2026-06-13: 残存検索として `Mate を作成してから開始してね`、`Mate を確認してから開始してね`、`本機能を実行できません`、`MATE_NOT_CREATED_ERROR_MESSAGE`、`MATE_CREATED_REQUIRED_CHANNEL_WHITELIST`、`ensureMateCreated`、`canUsePrimaryFeatures = mateState !== "not_created"` の `Select-String` 検索を実行し、該当なしを確認。
- 2026-06-13: 検証は `npm install` 後に `node --import tsx --test scripts/tests/home-launch-state.test.ts scripts/tests/home-launch-actions.test.ts scripts/tests/home-launch-projection.test.ts scripts/tests/home-components.test.tsx`、`node --import tsx --test scripts/tests/main-ipc-registration.test.ts scripts/tests/preload-api.test.ts scripts/tests/renderer-withmate-api.test.ts`、`npm run typecheck`、`npm run build` が成功。`npm install` では既存依存に 8 件の audit warning、`npm run build` では Vite の chunk size warning が出たが、この cleanup では未対応。

## 検証方針

Targeted checks:

- `npm run typecheck`
- `node --import tsx --test scripts/tests/main-ipc-registration.test.ts`
- `node --import tsx --test scripts/tests/renderer-withmate-api.test.ts`
- `node --import tsx --test scripts/tests/provider-runtime.test.ts`
- `node --import tsx --test scripts/tests/session-runtime-service.test.ts`
- `node --import tsx --test scripts/tests/session-persistence-service.test.ts`
- `node --import tsx --test scripts/tests/companion-runtime-service.test.ts`
- `node --import tsx --test scripts/tests/companion-session-service.test.ts`

Deletion-specific checks:

- `MemoryManagement|mate-memory|mate-growth|providerInstruction|ProviderInstructionTarget|ProjectDigest` の runtime 参照が残っていないこと
- `runSessionMemoryExtraction|MemoryOrchestrationService|project-memory-retrieval|project-memory-promotion` の runtime / test 参照が残っていないこと
- `MateTalk|mate-talk` の残存参照は Phase 4 移管として分類され、Home 公開導線と送信実行が閉じていること
- `withmate-ipc-channels.ts`、`withmate-window-api.ts`、`main-ipc-registration.ts` の削除対象 API が揃って消えていること
- app 起動時に Growth apply timer / Memory runtime workspace cleanup / provider instruction cleanup が走らないこと
- Mate 未作成状態でも Home / Settings / session 起動の意図した導線が壊れていないこと
- packaged build 前に `npm run build` を実行し、必要なら `npm run dist:win` で installer resources に削除済みコードが残らないことを確認する

## 完了条件

- `docs/design/v5-character-transition.md` の V5 初期 scope と矛盾する SingleMate / Memory / Growth runtime が起動・IPC・UI から外れている
- v4.9.9 の package version が設定されている
- session / companion / provider runtime の低レイヤーは維持されている
- 既存 DB を破壊する migration を混ぜていない
- targeted tests と typecheck が通る
- 残す legacy docs と削除済み runtime の関係が説明できる

## リスク

- `main.ts` に Mate / Memory / Provider Instruction の依存が集中しているため、一括削除は compile error が広がりやすい。
- `MateStorage` は Mate 未作成 gate、Home 表示、session 起動前処理に絡むため、削除順を誤ると app 起動自体が壊れる。
- session / companion の persisted snapshot に `character*` metadata が残っている可能性がある。履歴表示互換が必要な型は最後まで削除しない。
- provider instruction sync 削除により、既存ユーザーの provider instruction file に WithMate marker block が残る可能性がある。v4.9.9 では外部 provider instruction file cleanup を実装せず、V5 からは参照しない残置物として無視する。
- Memory / Growth tables は物理削除しない方針のため、DB diagnostics や reset の対象名に残る可能性がある。UI から見えないことと schema に残ることを混同しない。

## 未決事項

- `MateStorage` を完全削除するか、V5 Character storage 実装まで minimal app state として残すか。
- session / companion persisted data の `characterId` / `characterName` / `characterIconPath` を履歴表示用 metadata として残すか。
- docs の `single-mate-architecture.md` / `memory-architecture.md` は archive 扱いに移すか、V4 legacy design として残すか。
