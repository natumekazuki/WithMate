# Plan: review cache invalidation 対応

- 作成日: 2026-04-19
- ステータス: 完了

## 目的

`docs/reviews/review-20260419-0237.md` の 2 件の指摘を解消する。

1. ignore ルール変更時にも `@path` 検索インデックスのキャッシュを失効させる
2. `validatedAt` を走査・検証完了時刻で記録する

## 対象ファイル

- `src-electron/workspace-file-search.ts`
- `src-electron/snapshot-ignore.ts`
- `scripts/tests/workspace-file-search.test.ts`

## 実装方針

1. `src-electron/snapshot-ignore.ts` で、走査時に参照した ignore 関連ファイルの状態を `SnapshotScanResult` に含める
2. `src-electron/workspace-file-search.ts` で、ディレクトリ構造に加えて ignore 関連ファイルの状態もキャッシュ検証対象に含める
3. `validatedAt` は TTL 延命時・再走査時ともに処理完了直後の時刻で更新する
4. `.gitignore` 変更と `validatedAt` の扱いを検証するテストを追加する

## Todo

- `track-ignore-file-state`: ignore 関連ファイル状態の収集と検証を追加
- `fix-validated-at-timing`: `validatedAt` / `scannedAt` の記録タイミングを修正
- `add-review-regression-tests`: review 指摘を再現する回帰テストを追加

## メモ

- 今回の変更では `docs/design/`、`.ai_context/`、`README.md` の更新は不要
- 完了後は `docs/plans/archive/2026/04/20260419-review-cache-invalidation/` へ archive する

## 実施結果

- `src-electron/snapshot-ignore.ts` に ignore 関連ファイル状態の収集を追加
- `src-electron/workspace-file-search.ts` で ignore 関連ファイル変更も cache 失効条件に追加
- `validatedAt` / `scannedAt` を処理完了時刻基準へ修正
- `scripts/tests/workspace-file-search.test.ts` に P1 / P2 回帰テストを追加
- `npm test`: pass
- `npm run build`: pass
- `npm run typecheck`: 既存の unrelated エラーにより fail（今回差分起因ではない）
