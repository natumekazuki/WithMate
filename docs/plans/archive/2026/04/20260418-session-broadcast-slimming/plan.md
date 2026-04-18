# Plan

- task: Session broadcast slimming 最適化の実施計画を整理する
- date: 2026-04-18
- owner: Codex
- plan tier: repo plan

## Goal

- session 更新時の broadcast 契約を用途別に整理し、Home 系 window には session summary payload を寄せ、Session window には軽量な invalidation / changed 通知を配信する実装を完了させる

## Problem / Approach

- 現状は session summary 相当の全量 payload broadcast が全 window に流れやすく、`src/HomeApp.tsx` と `src/App.tsx` の用途差に対して payload fan-out が過剰になっている
- 本 task では summary payload を Home 系 window に寄せ、Session window は軽量通知を受けて detail を再取得する方向へ契約を整理する
- summary/detail hydration 方針と矛盾しないよう、main 側の配信責務と renderer 側の購読責務を分離する

## Scope

- session broadcast のイベント契約整理
- main 側 broadcast 分離
- renderer 側購読分離
- 関連テスト更新
- `docs/design/` 更新要否の判断

## Non-Scope

- renderer 全体の状態管理再設計
- イベント基盤の全面刷新
- `docs/plans/` 配下以外の repo ドキュメント更新そのもの

## Affected Files

- `src-electron/window-broadcast-service.ts`
- `src-electron/aux-window-service.ts`
- `src-electron/main-broadcast-facade.ts`
- `src-electron/main-query-service.ts`
- `src/HomeApp.tsx`
- `src/App.tsx`
- `src/session-state.ts`
- `src/withmate-ipc-channels.ts`
- `src/withmate-window-types.ts`
- 関連テスト
- 更新要否を確認する design docs 候補
  - `docs/design/window-architecture.md`
  - `docs/design/electron-window-runtime.md`
  - `docs/design/desktop-ui.md`

## Constraints

- 実装コードはまだ変更しない
- `docs/plans/` 配下以外の repo ドキュメントはまだ更新しない
- plan 成果物内のパスは repo 相対パスで記載する

## Checkpoints

- [x] イベント契約整理
- [x] main 側 broadcast 分離
- [x] renderer 側購読分離
- [x] 関連テスト更新
- [x] `docs/design/` 更新要否判断
- [x] 最終レビュー

## Refactor Handling

### same-plan

- `WindowBroadcastService` / `AuxWindowService` 周辺の window 種別整理
- payload 型と subscription helper の整理
- 理由: broadcast slimming の完了条件を満たすための前提作業であり、目的・変更範囲・検証軸が本 task と一致するため

### new-plan

- renderer 全体の状態管理再設計
- イベント基盤の全面刷新
- 理由: 目的と影響範囲が独立し、複数段階の設計判断を伴うため本 task に混在させない
- 想定影響範囲: `src/` 全体の state / subscription 構造、main-renderer 間イベント基盤
- 検証観点: state 遷移整合、購読解除漏れ、window 間同期契約、回帰テスト範囲の再設計

## Risks

- Home 系 / Session 系 window 判定の責務が曖昧なまま進めると、配信漏れまたは過配信が残る
- invalidation 通知へ寄せた際に detail 再取得タイミングが不整合だと、Session window の表示更新が遅延または欠落する
- 既存テストが full payload 前提だと、契約変更後の期待値更新漏れが起きやすい
- design doc 更新要否を見落とすと、summary/detail 契約の認識差が残る

## Validation

- main 側で Home 系 window と Session window の broadcast 内容が用途別に分離されていることを確認済み
- renderer 側で Home は summary 更新、Session は軽量通知後の detail 再取得に整理されていることを確認済み
- 既存関連テストの期待値を更新し、`npm test` が 339 テスト全件パスで成功することを確認済み
- task-local な型エラーは targeted typecheck で解消済みであり、`scripts/tests/main-broadcast-facade.test.ts`、`scripts/tests/session-persistence-service.test.ts`、`src/HomeApp.tsx` は clean を確認済み
- design doc 更新対象として `docs/design/electron-session-store.md` を更新済み

## Completion Criteria

- summary broadcast を Home 系 window に限定し、Session window には `sessionId[]` invalidation broadcast を配信する契約への更新が完了している
- `src/App.tsx` が invalidation 受信時の再 hydrate に移行し、局所リファクタと follow-up の境界が明示されている
- design doc 更新判断と検証結果が result / worklog に反映され、archive へ移せる状態になっている
