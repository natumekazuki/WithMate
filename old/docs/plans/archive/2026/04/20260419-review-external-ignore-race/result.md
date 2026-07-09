# Result

- status: done

## Summary

### P2: 外部 ignore ファイルの新規作成によるキャッシュ失効

- `SnapshotScanResult` と `WorkspaceFileIndex` に `absentIgnoreCandidates: string[]` を追加した
- `loadInitialIgnoreMatchers()` で `.git/info/exclude`、workspace 外部の `.gitignore`、immediate parent の `.gitignore` が存在しない場合にそのパスを不在候補として収集する
- `checkStructureUnchanged()` が不在候補ファイルの新規出現を `stat()` で検知し、出現時は false を返してキャッシュを失効させる

### P3: createIgnoreMatcher の race 対策（最終形）

- `createIgnoreMatcher()` を `stat → readFile → hook → stat` の逐次実行 + 最大 3 回試行（= 2 回再試行）に書き換えた
- before/after の `mtimeMs` と `size` が両方一致した試行だけを `"loaded"` として返す
- 1 回目に競合しても 2・3 回目で安定すれば `"loaded"` を返す
- 全試行で競合した場合のみ `"race"` を返す
- テスト専用フック `_setAfterIgnoreFileReadHookForTesting` を追加・export した

### 追加したテスト（3 件）

| テスト名 | 観点 |
|---|---|
| `.git/info/exclude が後から作成されたら TTL 超過時にキャッシュが失効する（P2 回帰: exclude 新規作成）` | fake git repo で exclude 不在 → 作成 → TTL 超過後に再走査・除外を確認 |
| `workspace 外の親 .gitignore が後から作成されたら TTL 超過時にキャッシュが失効する（P2 回帰: 親 .gitignore 新規作成）` | 親ディレクトリ控えの workspace で親 .gitignore 不在 → 作成 → TTL 超過後に再走査・除外を確認 |
| `ignore ファイルが read と stat の間で更新されても retry 後の整合した最新版が採用される（P3 回帰: retry）` | hook で 1 回だけ `.gitignore` を書き換え、retry 後に新ルールが採用されて `[]` を返すことを確認 |

### 検証

- `node --import tsx scripts/tests/workspace-file-search.test.ts`: 15/15 PASS
- `npm run build`: exit 0（エラーなし）

