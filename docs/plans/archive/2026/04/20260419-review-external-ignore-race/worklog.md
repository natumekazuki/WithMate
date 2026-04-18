# Worklog

- 2026-04-19: review-20260419-0314.md の 2 件の指摘（P2・P3）を確認し、対象ファイル（`src-electron/workspace-file-search.ts`、`src-electron/snapshot-ignore.ts`、`scripts/tests/workspace-file-search.test.ts`）の該当箇所を読んだ。
- 2026-04-19: plan.md・decisions.md・worklog.md・result.md・questions.md を作成した。修正方針を decisions.md に記録した。
- 2026-04-19: P2・P3 の実装・テスト追加・ビルド検証を完了した（最終形）。

## 実装内容

### P2 (外部 ignore ファイル新規作成の検知)

**`src-electron/snapshot-ignore.ts`**
- `SnapshotScanResult` に `absentIgnoreCandidates: string[]` フィールドを追加
- `CreateIgnoreMatcherResult` 型（`"loaded" | "absent" | "race"` の判別共用体）を追加し、`createIgnoreMatcher()` の戻り値を変更
- `loadInitialIgnoreMatchers()` の戻り型に `absentIgnoreCandidates` を追加。下記の 3 ケースで不在候補を収集する:
  1. `ignoreSourceDirectories` 内の workspace 外部ディレクトリで `.gitignore` が存在しない場合
  2. gitRoot が存在するが `.git/info/exclude` が存在しない場合
  3. gitRoot なしかつ即座の親に `.gitignore` がない場合（immediate parent パスを追加）
- `walkWorkspace()` が `absentIgnoreCandidates` を `SnapshotScanResult` に伝播するよう更新
- `walk()` の `createIgnoreMatcher` 呼び出しを新しい判別共用体の戻り値に対応するよう更新

**`src-electron/workspace-file-search.ts`**
- `WorkspaceFileIndex` に `absentIgnoreCandidates: string[]` フィールドを追加
- `checkStructureUnchanged()` に不在候補の新規出現チェックを追加（`stat()` 成功 = 出現 → false を返す）
- `getWorkspaceFileIndex()` で `scanned.absentIgnoreCandidates` をインデックスに格納するよう更新

### P3 (createIgnoreMatcher の race 対策)

**`src-electron/snapshot-ignore.ts`**
- `createIgnoreMatcher()` の `Promise.all([readFile, stat])` 並列実行を廃止
- `stat → readFile → hook → stat` の逐次実行を最大 3 回試行（= 2 回再試行）する
- 読み取り前後の `mtimeMs` と `size` が両方一致する場合のみ `"loaded"` を返す。全試行で不一致は `"race"` を返してキャッシュしない
- テスト専用フック `_setAfterIgnoreFileReadHookForTesting()` を追加・export（readFile 直後に割り込み、実際にファイルを書き換えることで OS レベルの mtime 変化を利用する決定論的テストを実現）

### テスト追加

**`scripts/tests/workspace-file-search.test.ts`**
- `snapshot-ignore.ts` から `_setAfterIgnoreFileReadHookForTesting` をインポートを追加
- 3 件の回帰テストを追加:
  1. `.git/info/exclude が後から作成されたら TTL 超過時にキャッシュが失効する（P2 回帰: exclude 新規作成）`
  2. `workspace 外の親 .gitignore が後から作成されたら TTL 超過時にキャッシュが失効する（P2 回帰: 親 .gitignore 新規作成）`
  3. `ignore ファイルが read と stat の間で更新されても retry 後の整合した最新版が採用される（P3 回帰: retry）`

## 検証結果

- `node --import tsx scripts/tests/workspace-file-search.test.ts`: 15/15 PASS
- `npm run build`: exit 0（エラーなし）

