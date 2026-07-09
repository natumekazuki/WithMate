# Plan — Session persistence summary/detail hydration

## Goal

- `Session persistence summary/detail hydration` を TDD で完了し、初期表示と常時購読で full session hydration が走る経路を解消する。
- Home / Session 初期表示では summary payload を使い、detail payload は session window 表示時だけ hydrate する。

## Scope

- session persistence 読み出しを summary/detail 単位へ分割する
- main query / IPC / preload / renderer API で summary と detail の取得境界を明示する
- `HomeApp` と `App` の初期 load / subscription を summary-first に寄せる
- 回帰 test と build/typecheck を追加して完了条件まで確認する

## Out of Scope

- window 種別ごとの差分 broadcast や fan-out 最適化全般
- session 以外の state/query 最適化
- `docs/design/` / `.ai_context/` / `README.md` の更新（現時点判断では不要）

## Recommended Approach

- 推奨案: `SessionSummary` と `SessionDetail` を明示し、一覧・購読は summary、個別表示は detail に分離する。
- 採用理由: `getSession()` の full detail は維持しつつ、起動直後の全件 JSON parse / clone / renderer hydration を最小変更で削減できるため。

## Task List

- [ ] summary/detail の型境界、IPC surface、read path を決める
- [ ] failing test を追加して現状の過剰 hydration を再現する
- [ ] `src-electron/session-storage.ts` と `src-electron/main-query-service.ts` を summary/detail read path に分割する
- [ ] preload / IPC / renderer API を更新し、`HomeApp` と `App` の初期表示を summary-first に切り替える
- [ ] 必要な same-plan refactor を実施する
- [ ] targeted test → `npm test` → `npm run typecheck` → `npm run build` を通す

## Affected Files

- `src/session-state.ts`
- `src/app-state.ts`
- `src/withmate-window-api.ts`
- `src-electron/session-storage.ts`
- `src-electron/main-query-service.ts`
- `src-electron/preload-api.ts`
- `src-electron/main-ipc-registration.ts`
- `src-electron/window-broadcast-service.ts`
- `src-electron/main-broadcast-facade.ts`
- `src/App.tsx`
- `src/HomeApp.tsx`
- `scripts/tests/session-storage.test.ts`
- `scripts/tests/main-query-service.test.ts`
- `scripts/tests/preload-api.test.ts`
- `scripts/tests/main-ipc-registration.test.ts`
- `scripts/tests/window-broadcast-service.test.ts`
- renderer 関連 test（必要に応じて `scripts/tests/session-app-render.test.ts` など）

## Refactor Assessment

### same-plan

- session clone / normalize / row parse helper を summary/detail 向けに分割する局所 refactor
- 理由: 本件の完了条件である read-path 分離の前提作業だから
- 想定影響範囲: `src/session-state.ts`, `src-electron/session-storage.ts`, query / IPC 呼び出し部
- 検証観点: summary read が `messages` / `stream` を要求しないこと、detail read だけが full payload を返すこと

### new-plan

- window 種別ごとの差分 broadcast・payload slimming 全般
- 理由: 目的と検証軸が「起動時 hydration 削減」ではなく「更新 fan-out 最適化」に広がるため
- 想定影響範囲: `src-electron/window-broadcast-service.ts`, `src-electron/main-broadcast-facade.ts`, renderer subscription 全般
- 検証観点: window 別 payload、差分 event、不要再描画の削減

## Risks

- summary/detail 型を曖昧にすると renderer 側で detail 前提アクセスが残り、runtime error になる
- subscription payload を summary 化した場合、session window 側の live update が detail 再取得なしで欠落する可能性がある
- storage read path の SQL projection 変更で legacy row / corrupted JSON の扱いが崩れる可能性がある

## Validation

- Red: summary API / subscription / storage projection の failing test を追加
- Green: 追加 test を含む targeted test を通す
- Regression:
  - `npm test`
  - `npm run typecheck`
  - `npm run build`

## Docs Sync

- `docs/design/`: 更新不要予定。理由: 今回は app 内部の session query/broadcast 境界整理が中心で、現時点では別 design doc の新設条件に達していないため
- `.ai_context/`: 更新不要予定。理由: repository 運用ルールや恒久メモの追加ではないため
- `README.md`: 更新不要予定。理由: ユーザー向け手順変更ではないため

## Review Focus

- summary/detail 境界が UI 利用実態と一致しているか
- Home / Session 初期表示で full payload を取得しないことが test で担保されているか
- follow-up に分けるべき broadcast slimming を混在させていないか

## Completion Criteria

- Home 初期表示と session list subscription が summary payload のみで成立する
- Session window は表示対象 session の detail を明示的に hydrate する
- storage/query/read-path の summary/detail 分離が test で固定される
- `npm test` / `npm run typecheck` / `npm run build` が成功する

## Archive Check

- plan 成果物は repo 相対パスのみを記載する
- `result.md` と `worklog.md` は完了時に closing entry を入れられる状態を維持する
- 未解決事項は `questions.md` または `result.md` に残せるよう分離して管理する
