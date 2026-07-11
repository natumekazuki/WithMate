# Feature Inventory

- 作成日: 2026-07-09
- 目的: 現行 WithMate の機能を洗い出し、新バージョンに残すかどうかを取捨選択する
- 根拠: 退避済みの `old/README.md`、`old/docs/design/`、`old/docs/task-backlog.md`、主要 `old/src/` / `old/src-electron/` entry、`old/scripts/tests/`
- 現行資源の退避先: `old/`

## Decision Legend

| Decision | Meaning |
| --- | --- |
| Keep | 新バージョンでも初期スコープ候補として残す |
| Reconsider | 価値はあるが、仕様・責務・UI・実装方式を再設計してから採否判断する |
| Defer | 将来候補。初期版には入れない |
| Drop | 新バージョンには入れない |
| Unknown | 追加調査が必要 |

## Feature Table

| Category | Feature | Current Evidence | Decision | Reason |
| --- | --- | --- | --- | --- |
| Product core | CLI 系 coding agent 体験に character layer を重ねる方針 | `old/README.md`, `old/docs/design/product-direction.md`, `old/docs/design/coding-agent-capability-matrix.md` | Keep | WithMate の中心価値。新バージョンの出発点にする。 |
| Window architecture | Home / Session / Character Editor / Diff / Companion Review の多 window 構成 | `old/README.md`, `old/docs/design/window-architecture.md`, `old/src/*-main.tsx` | Keep | 必要なところは多 window のまま維持する。0 ベースでは window 数を目的化せず、責務ごとに独立 window が必要かを判断する。 |
| Home | セッション一覧、起動、キャラクター導線、設定導線 | `old/src/HomeApp.tsx`, `old/src/home/`, `old/scripts/tests/home-*.test.ts` | Keep | GUI の入口として残すが、本格実装は CLI と Application Service の主要 use case が成立した後に行う。UI は作り直す。 |
| Session chat | message list、composer、right pane、turn 実行表示 | `old/src/session-main.tsx`, `old/src/chat/`, `old/docs/design/session-run-lifecycle.md`, `old/scripts/tests/session-*.test.ts` | Keep | message list と composer はコアとして残す。composer は送信用の入力欄と送信操作、添付、model/approval/sandbox などの実行設定を含む領域。right pane は使用頻度が低いため見直す。turn 実行表示は必要だが見直し対象とし、実行中の assistant 出力、pending message、approval/elicitation、reasoning/running details、audit log などの表示範囲と見せ方を再設計する。message bubble など細部の UI 実装も作り直し対象にする。共通 timeline と途中出力の境界は `docs/design/session-run-message-contract.md` を正本とする。 |
| Session runtime | run / cancel / retry / close / live state / persistence coordination | `old/src-electron/session-runtime-service.ts`, `old/src-electron/session-persistence-service.ts`, `old/scripts/tests/session-runtime-service.test.ts` | Keep | ないと session 実行が成立しないため残す。Session に実行状態を兼用させず、Run と RunEvent を独立させる。共通 lifecycle と永続化前の不変条件は `docs/design/session-run-message-contract.md` を正本とする。 |
| Provider adapters | Codex / GitHub Copilot provider 接続、model / reasoning / approval / sandbox 設定 | `old/src-electron/codex-adapter.ts`, `old/src-electron/copilot-adapter.ts`, `old/docs/design/provider-adapter.md`, `old/scripts/tests/provider-*.test.ts` | Keep | 初期 Provider は Codex と GitHub Copilot に限定する。Codex は Codex App Server、GitHub Copilot は Copilot CLI ACP server へ接続し、SDK を直接組み込まない。Provider 固有 protocol は Adapter 内で WithMate 共通 contract へ変換する。詳細は `docs/design/provider-integration.md` を正本とする。 |
| Approval / elicitation | approval request、provider elicitation、pending UI | `old/src-electron/session-approval-service.ts`, `old/src-electron/session-elicitation-service.ts`, `old/scripts/tests/approval-mode.test.ts` | Keep | agent 操作の安全境界として残す。CodexAppServer 経由なら Codex でも approval request を扱える可能性があるため、JSON-RPC provider 境界と合わせて approval / elicitation / pending UI を再設計する。 |
| Character management | character 定義、notes、snapshot、editor、archive | `old/src/CharacterEditorApp.tsx`, `old/src-electron/character-service.ts`, `old/docs/design/character-storage.md` | Keep | WithMate 固有価値として残す。format と authoring 支援は再検討する。要検討事項として、ユーザー向け名称を Character から Mate に変更するか判断する。 |
| Character runtime prompt | session / companion 開始時 snapshot と prompt composition | `old/src/character/`, `old/src-electron/provider-prompt.ts`, `old/docs/design/prompt-composition.md` | Keep | WithMate の character layer の中核であり、残さないとプロダクトの意味が薄れるため残す。session / companion 開始時 snapshot と prompt composition は必要だが、Memory 注入との境界を明確化して再設計する。 |
| Memory | Session / Project / Character Memory、検索、抽出、review、protected objects、WithMateCLI | `old/src-electron/memory-v6-*`, `old/src/memory-v6/`, `old/docs/design/v6-memory-foundation.md`, `old/scripts/tests/memory-v6-*.test.ts` | Keep | Memory はかなり役立っているため残す。ただし V6 実装は引き継がず削除し、owner/scope、forget、object store、prompt 注入を再設計する。CLI は WithMateCLI に統一する。 |
| Memory management UI | Memory 一覧、検索、削除、review screen | `old/src/memory-v6/MemoryV6ReviewScreen.tsx`, `old/scripts/tests/memory-v6-review-screen.test.tsx` | Defer | 既存 UI はほとんど使っていないため初期版には入れない。必要な Memory 管理は WithMateCLI で実行するか、エージェントに操作させる方針にする。 |
| Audit log | run audit、details、provider metadata、lazy detail load | `old/src-electron/audit-log-*`, `old/docs/design/audit-log.md`, `old/scripts/tests/audit-log-*.test.ts` | Keep | ログはデバッグと安全性のため記録として残す。ただし専用画面で見える必要はなく、基本は JSON などの構造化ログとして保持し、必要時は WithMateCLI で確認する。Chat UI と重複する audit log UI / lazy detail view は初期版から外す。 |
| App log | app JSONL log | `old/src-electron/app-log-service.ts`, `old/docs/design/app-log-base.md` | Keep | アプリログは不具合調査に必要なため残す。DB は完全に再設計し、既存 DB migration を行わないため database diagnostics は削除する。旧データは移行せず、必要ならクリーンインストールで新規作成する。 |
| Persistence foundation | 新 DB schema、blob / object storage、bootstrap | `old/src-electron/database-schema-v*.ts`, `old/scripts/migrate-*.ts`, `old/docs/design/database-schema.md` | Keep | 旧 SQLite schema v1-v6 と migration は引き継がない。データはすべて破棄して新規作成し、既存ユーザー向け migration / compatibility / diagnostics は用意しない。新バージョン用の persistence foundation と bootstrap を 0 ベースで再設計する。 |
| Diff / artifact viewing | file diff viewer、changed files、artifact detail | `old/src/DiffApp.tsx`, `old/src/DiffViewer.tsx`, `old/scripts/tests/diff-viewer-css.test.ts` | Defer | Diff は不要。storage 圧迫があり、実利用も少ないため初期版には入れない。artifact detail の Operations / Run Checks も画面ではほぼ見ていないため、必要な情報は構造化ログまたは WithMateCLI で確認する方針にする。 |
| Companion mode | companion session、merge review、git integration | `old/src/CompanionReviewApp.tsx`, `old/src-electron/companion-*`, `old/scripts/tests/companion-*.test.ts` | Drop | 実利用がほぼなく、通常の Git worktree で代替できるため削除する。companion session / merge review / git integration は新バージョンには入れない。 |
| Auxiliary session | auxiliary session 起動、parent session 連携、runtime option | `old/src-electron/auxiliary-*`, `old/src/auxiliary-*`, `old/scripts/tests/auxiliary-*.test.ts` | Keep | レビュー用途などでよく使うため残す。main session との連携、並行性、runtime option、audit/log owner は 0 ベースで再設計する。 |
| Session monitor | 実行中 session monitor window | `old/docs/design/session-live-activity-monitor.md`, `old/scripts/tests/home-monitor-style.test.ts` | Keep | 実行中 session の状態を追う用途として残す。独立 window として維持するか、Home / Session からの導線に統合するかは UI 再設計時に判断する。 |
| Settings | provider settings、model catalog、diagnostics、reset | `old/src/settings/`, `old/src-electron/app-settings-storage.ts`, `old/scripts/tests/settings-*.test.ts` | Reconsider | 残したいが、最悪なくても運用可能。provider settings / model catalog は UI を残す案と、JSON export / edit / validate / import を WithMateCLI で行う案を比較する。diagnostics / reset は UI から外す。 |
| Model catalog | model catalog import / revision / selection | `old/src-electron/model-catalog-storage.ts`, `old/public/model-catalog.json`, `old/docs/design/model-catalog.md` | Keep | provider / model selection に必要なため残す。WithMateCLI で catalog refresh / export / validate / import を管理できるようにする。Codex App Server / Copilot ACP から取得できる model と capability は設計検証で確認し、取得できない場合は bundled JSON fallback を使う。 |
| Additional directories | workspace 外 directory allowlist / attachment | `old/src-electron/additional-directories.ts`, `old/src/additional-directory-state.ts` | Keep | 実際に使っているため残す。workspace 外 directory allowlist / attachment は必要だが、security / privacy 境界として UI、許可単位、provider への渡し方を再設計する。 |
| Packaging | Electron builder、icon generation、provider binary staging | `old/package.json`, `old/scripts/generate-app-icon.ts`, `old/scripts/stage-provider-binaries.ts`, `old/build/` | Keep | 配布・起動・provider 連携に必須のため残す。新 stack 決定後に packaging、icon generation、provider binary / app server staging を 0 ベースで再構築する。 |
| Browser preview / browser use | Browser Preview、visual comments、browser artifact | GitHub Issue #107 | Defer | 作り方がまだ決まっていないため将来判断に回す。現行実装ではなく将来構想として扱い、V7 / multi-agent / provider capability が固まった段階で再検討する。 |
| Multi-agent / control plane | delegation graph、orchestrator、CLI/Skill entry | GitHub Issue #222, #29 | Keep | 複数エージェントは新バージョンのタイミングで実装する。delegation graph、orchestrator、CLI / Skill entry の方式は既存案をそのまま使わず、改めて設計し直す。 |
| Monologue / Character Stream | 独り言、character reflection、stream 統合 | `old/docs/task-backlog.md`, `old/docs/design/monologue-provider-policy.md` | Drop | 独り言、旧 character reflection cycle、stream 統合案は削除する。Memory は MemoryCLI を Skill から呼ぶ形で扱うため、この機能としては新バージョンに入れない。 |
| Provider instruction sync | provider instruction projection / sync | `old/src-electron/provider-prompt.ts`, `old/src-electron/mate-instruction-projection.ts`, `old/docs/design/provider-instruction-sync.md` | Drop | 不要なため削除する。provider instruction projection / sync は新バージョンに入れない。 |

## Initial Keep Scope

初期版に残す候補は次の順に扱う。

1. 画面に依存しない Application Service と CLI の基本 contract
2. Codex App Server / GitHub Copilot ACP の Provider Adapter contract
3. Session / Run / Message の共通 lifecycle と会話履歴
4. Character 定義と runtime prompt snapshot
5. 新 persistence foundation と clean install 前提の bootstrap
6. Memory / Audit log / App log の CLI 前提運用
7. Settings / model catalog の WithMateCLI 管理
8. Additional directories
9. Multi-agent / control plane
10. Home / Session GUI
11. Packaging / distribution

## Initial Reconsider Scope

次は残す価値があるが、現行実装をそのまま移植しない。

- Settings
- Multi-window policy
- Provider-specific advanced features

## Initial Defer Scope

初期版に入れない候補。

- Memory management UI
- Diff / artifact viewing
- Browser Preview / Browser Use
- Character authoring pack import
- Tauri migration

## Initial Drop Scope

新バージョンに入れない候補。

- Companion mode
- Monologue / Character Stream
- Provider instruction sync
