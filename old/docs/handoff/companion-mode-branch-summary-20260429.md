# Companion Mode Branch Summary

- 作成日: 2026-04-29
- 対象 branch: `feat/companion-mode`
- 対象 head: `21938bf`
- 比較対象: `origin/master` at `432c4ed`
- 目的: 最新 `origin/master` から新規 branch を切り直して Companion Mode を移植するために、現 branch の実装状況、残作業、移植時の注意点を整理する。

## 判断

`feat/companion-mode` に `origin/master` を直接 merge して進めるより、最新 `origin/master` から新規 branch を切り、Companion Mode の実装を機能単位で移植する方が安全。

理由:

- `origin/master` 側は DB v2、data loading、message / audit log virtualization、runtime reset guard など、基盤側の変更が大きい。
- dry-run merge では `main.ts`、IPC、preload、Home UI、永続化 lifecycle 周辺に content conflict が出ている。
- Companion Mode は `main.ts` / IPC / preload / Home UI / storage / provider runtime の統合点に強く依存している。
- conflict を機械的に解いても、master 側の新しい設計に合わせた再接続が必要になる。

## 実装済み機能

### CompanionSession 作成導線

- Home から CompanionSession を作成する導線を追加済み。
- Git repo root / focus path / target branch を解決する。
- CompanionGroup / CompanionSession / CompanionMessage を専用 storage に保存する。
- 通常 Session とは別の Companion 専用 lifecycle として扱う。

主なファイル:

- `src/companion-state.ts`
- `src-electron/companion-storage.ts`
- `src-electron/companion-session-service.ts`
- `src-electron/companion-git.ts`
- `src/HomeApp.tsx`
- `src/home-components.tsx`

### snapshot commit / shadow worktree

- CompanionSession 作成時に base snapshot commit を作成する。
- snapshot ref は `refs/withmate/companion/<sessionId>/base`。
- companion branch は snapshot commit から作る。
- shadow worktree は AI と user 手修正用の隔離 worktree として作る。
- branch / ref / worktree 名は DB の ID から safe id 規則で生成する。
- merge / discard 完了時に companion branch、snapshot ref、shadow worktree を cleanup する。

主なファイル:

- `src-electron/companion-git.ts`
- `src-electron/companion-session-service.ts`
- `scripts/tests/companion-git.test.ts`
- `scripts/tests/companion-session-service.test.ts`

### provider 実行 cwd 切り替え

- provider runtime に `executionWorkspacePath` を渡せるようにした。
- CompanionSession の AI 実行は shadow worktree を cwd / workspace として使う。
- CompanionSession の `threadId`、`runState`、messages を専用 storage に永続化する。
- Companion の初期 provider 実行導線では、通常 `sessions` table には保存しない。

主なファイル:

- `src-electron/companion-runtime-service.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/copilot-adapter.ts`
- `src-electron/provider-runtime.ts`
- `scripts/tests/companion-runtime-service.test.ts`
- `scripts/tests/codex-adapter.test.ts`
- `scripts/tests/copilot-adapter.test.ts`

### Companion Review Window

- `review.html` と `CompanionReviewApp` を追加した。
- active CompanionSession の changed files と split diff を表示する。
- changed files は default selected とし、file 単位で merge 対象から外せる。
- merge readiness を表示する。
- terminal CompanionSession は read-only Review Window として開ける。

主なファイル:

- `review.html`
- `src/CompanionReviewApp.tsx`
- `src/companion-review-main.tsx`
- `src/companion-review-state.ts`
- `src-electron/companion-review-service.ts`
- `vite.config.ts`

### selected files merge / discard

- selected files だけを target workspace に反映する。
- discard は target workspace を変更せず CompanionSession を終了する。
- merge 前に blocker を判定する。
- target branch drift は blocker。
- target workspace dirty は selected path 以外も含めて blocker。
- 一時 index 上で selected files merge simulation を行う。
- merge / discard 後、CompanionSession は terminal status になる。

主なファイル:

- `src-electron/companion-review-service.ts`
- `scripts/tests/companion-review-service.test.ts`

### sibling check

- merge 後に同じ CompanionGroup の active sibling CompanionSession を確認する。
- selected files と sibling changed files の path overlap を warning として返す。
- warning は merge 自体を止めない。
- warning は terminal session の `sibling_warnings_json` と merge run に保存する。

主なファイル:

- `src-electron/companion-review-service.ts`
- `src-electron/companion-storage.ts`
- `scripts/tests/companion-review-service.test.ts`

### 履歴表示

- Home に active CompanionSession と terminal CompanionSession を分けて表示する。
- terminal CompanionSession は read-only history card として扱う。
- selected files summary、changed files summary、sibling warning summary を履歴カードに表示する。
- terminal history card から read-only Review Window を開ける。

主なファイル:

- `src/HomeApp.tsx`
- `src/home-components.tsx`
- `src-electron/companion-storage.ts`
- `src-electron/main.ts`

### merge / discard operation history

- `companion_merge_runs` を追加し、merge / discard の completed operation を保存する。
- `CompanionSessionSummary` は latest merge run を持つ。
- read-only Review Window は session の merge runs を newest-first timeline として表示する。
- latest merge run を changed file summary の優先 source として使う。

主なファイル:

- `src/companion-state.ts`
- `src-electron/companion-storage.ts`
- `src-electron/companion-review-service.ts`
- `src/CompanionReviewApp.tsx`

### diff snapshot 永続化

- `companion_merge_runs.diff_snapshot_json` に completed 時点の `ChangedFile[]` を保存する。
- merge / discard 完了前に active Review と同等の diff snapshot を作る。
- cleanup 後も read-only Review Window で latest merge run の diff rows を表示できる。
- 古い履歴など diff snapshot がない場合は changed file summary + empty diff rows に fallback する。

主なファイル:

- `src/companion-state.ts`
- `src-electron/companion-storage.ts`
- `src-electron/companion-review-service.ts`
- `scripts/tests/companion-storage.test.ts`
- `scripts/tests/companion-review-service.test.ts`

## 現 branch の主要コミット

実装コミットだけを機能順に読むと追いやすい。

| commit | 内容 |
| --- | --- |
| `c1bc19e` | Companion Mode の初期作成導線 |
| `7e1bb66` | shadow worktree 作成 |
| `ae0f563` | provider 実行 workspace 切り替え |
| `b307eb7` | shadow worktree で provider 実行 |
| `c572fc6` | Review Window で変更一覧表示 |
| `73fa8d0` | selected files merge / discard |
| `77ae505` | merge readiness と blocker |
| `f640911` | sibling overlap warning |
| `bc9d513` | merge / discard 履歴を Home に表示 |
| `47204c8` | selected files summary 履歴表示 |
| `937aba6` | changed files summary 履歴表示 |
| `ceadf2c` | sibling warning 履歴表示 |
| `d4983c8` | merge run 履歴保存 |
| `0692e13` | terminal review を read-only で開く |
| `77ae968` | Review に merge run timeline 表示 |
| `677e38a` | review diff snapshot 保存 |

設計と plan 記録は `docs/design/companion-mode.md` と `docs/plans/archive/2026/04/20260426-companion-*/` にある。

## 残りの実装候補

### MVP 仕上げ

- timeline item ごとの diff 切り替え UI。
- `diff_snapshot_json` のサイズ上限、圧縮、pruning policy。
- Companion checks / command result 連携。
- Review Window の checks summary / stale 表示。
- recovery-required の具体的な復旧 UI。
- orphan branch / ref / worktree maintenance。
- startup reconciliation。
- close / quit 時の Companion operation lock。

### Future 扱い

- hunk 単位 merge。
- full merge conflict editor。
- sibling CompanionSession の自動修正。
- `Sync Target` / `Rebase From Target`。
- `New Companion From History`。
- Project Memory candidate 生成。
- Character Reflection / MemoryGeneration 連携。

## `origin/master` との差分状況

`origin/master` at `432c4ed` との dry-run merge では content conflict が出る。

content conflict が出た file:

- `docs/design/database-schema.md`
- `scripts/tests/codex-adapter.test.ts`
- `scripts/tests/main-ipc-registration.test.ts`
- `scripts/tests/preload-api.test.ts`
- `src-electron/main-ipc-deps.ts`
- `src-electron/main-ipc-registration.ts`
- `src-electron/main.ts`
- `src-electron/persistent-store-lifecycle-service.ts`
- `src-electron/preload-api.ts`
- `src/home-components.tsx`

merge-base 以降、両方の branch が触っている file:

- `docs/design/database-schema.md`
- `scripts/tests/codex-adapter.test.ts`
- `scripts/tests/main-ipc-deps.test.ts`
- `scripts/tests/main-ipc-registration.test.ts`
- `scripts/tests/persistent-store-lifecycle-service.test.ts`
- `scripts/tests/preload-api.test.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/main-ipc-deps.ts`
- `src-electron/main-ipc-registration.ts`
- `src-electron/main.ts`
- `src-electron/persistent-store-lifecycle-service.ts`
- `src-electron/preload-api.ts`
- `src-electron/provider-prompt.ts`
- `src-electron/window-entry-loader.ts`
- `src/HomeApp.tsx`
- `src/home-components.tsx`
- `src/styles.css`
- `src/withmate-ipc-channels.ts`
- `src/withmate-window-api.ts`

`origin/master` 側の大きい変更:

- DB v2 / data loading optimization。
- audit log / session storage v2。
- message list / audit log virtualization。
- runtime reset guard。
- `main.ts` 周辺の bootstrap / IPC / persistence facade 変更。
- `HomeApp` / `home-components` / `styles.css` の UI 構造変更。

注意:

- `src-electron/companion-*` や `src/companion-*` は `origin/master` から見ると削除扱いに見えるが、これは master に Companion Mode がないためで、直接 merge では基本的にこちらの追加 file として残る。
- ただし、Companion の接続先である `main.ts`、IPC、preload、Home UI は master 側で変わっているため、そのまま持ち込むと設計不整合が起きやすい。

## 新規 branch へ移植する推奨順序

最新 `origin/master` から新規 branch を切って、以下の順で移植する。

1. 設計書だけを移植する。
   - `docs/design/companion-mode.md`
   - `docs/design/database-schema.md` の Companion section
2. 純粋 model / state を移植する。
   - `src/companion-state.ts`
   - `src/companion-review-state.ts`
3. Git / shadow worktree service を移植する。
   - `src-electron/companion-git.ts`
   - `src-electron/companion-session-service.ts`
   - 対応テスト
4. provider cwd 切り替えを master の runtime adapter に合わせて移植する。
   - `src-electron/codex-adapter.ts`
   - `src-electron/copilot-adapter.ts`
   - `src-electron/provider-runtime.ts`
5. Companion storage を master の DB v2 / persistence lifecycle に合わせて再設計する。
   - 旧 `CompanionStorage` をそのまま使うか、V2 schema に統合するかを先に決める。
   - master の `session-storage-v2` / `audit-log-storage-v2` の導入方針と衝突しないようにする。
6. Review service と Review Window を移植する。
   - `src-electron/companion-review-service.ts`
   - `src/CompanionReviewApp.tsx`
   - `src/companion-review-main.tsx`
   - `review.html`
   - `vite.config.ts`
7. IPC / preload / window API を master の current shape に合わせて接続する。
   - `src/withmate-ipc-channels.ts`
   - `src/withmate-window-api.ts`
   - `src-electron/preload-api.ts`
   - `src-electron/main-ipc-deps.ts`
   - `src-electron/main-ipc-registration.ts`
8. Home UI へ Companion entry / history card を移植する。
   - `src/HomeApp.tsx`
   - `src/home-components.tsx`
   - `src/styles.css`
9. `main.ts` で service wiring を接続する。
10. validation を走らせる。
    - `npx tsc -p tsconfig.electron.json --noEmit`
    - Companion 関連テスト
    - `npm run build`
    - `npm test`

## 移植時に先に決めるべきこと

### Companion storage をどこへ置くか

現 branch は `src-electron/companion-storage.ts` で Companion 専用 SQLite table を直接扱う。

最新 master は DB v2 / summary-first / page API の方向へ進んでいるため、移植時は次を決める。

- Companion tables を v1 側に残すか。
- DB v2 schema に Companion tables を追加するか。
- migration path を初回リリース前前提で reset 寄りにするか。
- `CompanionSessionSummary` を Home の summary loading にどう乗せるか。

### Review Window を独立 entry として残すか

現 branch は `review.html` / `CompanionReviewApp` を追加している。

master 側の Vite entry / window loader が変わっているため、移植時は `review.html` の追加と `vite.config.ts` の entry 設定を master の current shape に合わせる。

### Home UI の組み込み位置

現 branch の Home UI 変更は、master の message list / audit log virtualization とは直接関係しないが、`HomeApp` / `home-components` / `styles.css` が大きく変わっている。

移植時は既存 component の差し込みではなく、master 側 Home の current layout に合わせて Companion section を新規に組み直す方が安全。

## 最低限の移植完了条件

- Home から CompanionSession を作成できる。
- shadow worktree が作成される。
- provider が shadow worktree を cwd として実行される。
- Review Window が active CompanionSession の changed files / diff rows を表示する。
- selected files merge / discard が動く。
- merge readiness blocker が効く。
- merge / discard 後に history card が表示される。
- read-only Review Window で latest merge run の diff snapshot を表示できる。
- `npm run build` と `npm test` が通る。

