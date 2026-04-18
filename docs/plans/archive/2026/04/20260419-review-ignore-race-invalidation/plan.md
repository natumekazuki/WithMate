# Plan

## Goal

`review-20260419-0444.md` の指摘（P2）を解消する。

- **P2**: `createIgnoreMatcher()` が `kind: "race"` を返した場合、`loadInitialIgnoreMatchers()` および `walkWorkspace()` 内で無視されているため、競合中に読めなかった ignore ファイルが index に記録されず、競合解消後の TTL 再検証でも `checkStructureUnchanged()` が失効できない。

あわせて、`loaded / absent / race` の結果処理を helper に寄せる same-plan 局所リファクタを実施する。

## Scope

- `src-electron/snapshot-ignore.ts`
  - sentinel mtime 定数 `IGNORE_FILE_RACE_SENTINEL_MTIME = -1` を追加する
  - `applyIgnoreFileResult()` helper を追加し、`loaded` / `race` の `ignoreFiles` / `loadedDirectories` 更新を統一する
  - `loadInitialIgnoreMatchers()` の gitignore ループ・exclude ブロックを helper 経由に書き換えて `race` 対応を追加する
  - `walkWorkspace()` 内 `walk()` の gitignore 読み込みブロックを helper 経由に書き換えて `race` 対応を追加する
- `src-electron/workspace-file-search.ts`
  - `checkStructureUnchanged()` に sentinel mtime の意図を説明するコメントを追加する（ロジック自体は変更不要）
- `scripts/tests/workspace-file-search.test.ts`
  - レビュー指摘そのものを再現する回帰テストを少なくとも 1 件追加する
  - initial load / walk load の両方で race → TTL 後再走査を確認するテストを追加する

## Out Of Scope

- `docs/design/`・`.ai_context/`・`README.md` の更新
- TTL・キャッシュ戦略の全面見直し
- `createIgnoreMatcher()` 自体の変更（前 plan で完了済み）

## Task List

- [x] plan.md / decisions.md / questions.md / worklog.md / result.md を作成する
- [x] sentinel 定数と `applyIgnoreFileResult()` helper を追加する
- [x] `loadInitialIgnoreMatchers()` を helper 経由に書き換えて `race` 対応を追加する
- [x] `walkWorkspace()` を helper 経由に書き換えて `race` 対応を追加する
- [x] `workspace-file-search.ts` の `checkStructureUnchanged()` にコメントを追加する
- [x] 回帰テストを 2 件追加する（initial load race / walk load race）
- [x] 検証を実行する（テスト・ビルド）

## Affected Files

- `src-electron/snapshot-ignore.ts`
- `src-electron/workspace-file-search.ts`
- `scripts/tests/workspace-file-search.test.ts`
- `docs/plans/20260419-review-ignore-race-invalidation/` (本ディレクトリ)

## Risks

- sentinel mtime `-1` と実際の mtime が一致する可能性：実際の mtime は Unix エポック (ms) 基準で 0 以上の値が返るため、`-1` が衝突する現実的なリスクはない
- `applyIgnoreFileResult()` で exclude パスを `directory: null` で呼び出す際に `loadedDirectories` が更新されないことを意図的に選択する。exclude は per-directory ではないため `loadedDirectories` を変更すると `walkWorkspace()` の二重ロード抑止に干渉する

## Validation

- `node --import tsx scripts/tests/workspace-file-search.test.ts` が成功すること
- `npm run build` が成功すること
