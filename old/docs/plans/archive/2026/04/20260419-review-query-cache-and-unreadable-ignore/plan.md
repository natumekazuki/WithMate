# Plan

## Goal

`review-20260419-0553.md` の 2 件の指摘を解消する。

- **P2**: `workspaceQueryCache` に件数上限がなく、長時間セッションで query cache が無制限に増加する
- **P3**: 安定した ignore ファイル読み取り不能まで `kind: "race"` に畳み込まれており、TTL ごとに全走査ループへ入りうる

前回の sentinel 設計を `race` 専用に限定し、stable unreadable を別状態として扱うよう再設計する。

## Scope

- `src-electron/workspace-file-search.ts`
  - query cache を件数上限つき recent cache として扱う
  - query cache の参照・更新・排出を helper 化する
  - ignore ファイル状態の新設計に合わせて `checkStructureUnchanged()` を更新する
- `src-electron/snapshot-ignore.ts`
  - `CreateIgnoreMatcherResult` と scan 結果の ignore 状態表現を再設計する
  - `readFile()` 失敗を `race` / `unreadable` に分類する
  - `applyIgnoreFileResult()` を新設計へ追随させる
- `scripts/tests/workspace-file-search.test.ts`
  - query cache の上限 / recent cache 回帰テストを追加する
  - `race` と `unreadable` の分離、および bounded retry の回帰テストを追加する

## Out Of Scope

- `docs/design/`・`.ai_context/`・`README.md` の更新
- UI 変更
- `@path` 検索アルゴリズム自体の変更
- ignore 解決順序や `.gitignore` 仕様の見直し

## Task List

- [x] repo plan を作成する
- [x] query cache の recent cache 方針（上限値・排出方法）を decisions.md に確定する
- [x] ignore ファイル状態の再設計（`loaded` / `unreadable` / `race`）を decisions.md に確定する
- [x] `workspace-file-search.ts` に query cache 上限と排出処理を実装する
- [x] `snapshot-ignore.ts` の `readFile()` 失敗分類を見直し、安定 unreadable を `race` と分離する
- [x] `workspace-file-search.ts` の ignore 状態再検証を新設計へ更新する
- [x] 回帰テストを追加・更新する（query cache / unreadable / race）
- [x] 検証を実行する（関連テスト・build・typecheck）

## Affected Files

- `src-electron/workspace-file-search.ts`
- `src-electron/snapshot-ignore.ts`
- `scripts/tests/workspace-file-search.test.ts`
- `docs/plans/20260419-review-query-cache-and-unreadable-ignore/`

## Risks

- `unreadable` を再走査しない設計に寄せすぎると、共有ロック解除後に stale が残る
- `race` を広く取りすぎると、今回と同じ全走査ループが再発する
- query cache の上限が小さすぎると typeahead の prefix narrowing 効果が薄れる

## Validation

- `node --import tsx scripts/tests/workspace-file-search.test.ts` が成功すること
- `npm run build` が成功すること
- `npm run typecheck` の結果を確認し、今回差分起因か既知問題かを切り分けること

## Docs Sync

- `docs/design/`: 更新不要見込み。query cache の上限追加と ignore 読み取り失敗分類の見直しはいずれも内部実装の整合修正であり、公開仕様の変更ではないため
- `.ai_context/`: 更新不要見込み。運用ルールや repo 前提に変更がないため
- `README.md`: 更新不要見込み。ユーザー向けの利用方法は変わらないため
