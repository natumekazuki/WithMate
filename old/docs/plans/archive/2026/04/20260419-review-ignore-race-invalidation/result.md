# Result

- status: done

## 実装サマリ

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src-electron/snapshot-ignore.ts` | `IGNORE_FILE_RACE_SENTINEL_MTIME = -1` 定数追加、`applyIgnoreFileResult()` helper 追加、`loadInitialIgnoreMatchers()` / `walkWorkspace()` を helper 経由に書き換えて `race` 対応を追加 |
| `src-electron/workspace-file-search.ts` | `checkStructureUnchanged()` の mtime 比較箇所に sentinel 意図を説明するコメントを追加（ロジック変更なし） |
| `scripts/tests/workspace-file-search.test.ts` | review-20260419-0444 回帰テスト 2 件追加 |

### 修正内容

- `kind: "race"` が返った ignore ファイルを `ignoreFiles` に sentinel mtime (`-1`) で記録するようにした
- これにより race 解消後の最初の TTL 超過で `checkStructureUnchanged()` が sentinel 不一致を検出し、確実に re-scan に導けるようになった
- `loaded` / `race` の `ignoreFiles` / `loadedDirectories` 更新を `applyIgnoreFileResult()` に集約し、初期ロードとウォーク中ロードで処理を統一した

## 追加テスト名

- `初期 scan で .gitignore が全 retry 競合 (race) した場合、TTL 超過後に再走査される（review-20260419-0444 regression: initial load）`
- `walkWorkspace 中のサブディレクトリ .gitignore が全 retry 競合 (race) した場合、TTL 超過後に再走査される（review-20260419-0444 regression: walk）`

## 検証

| 検証項目 | 状態 |
|---|---|
| `node --import tsx scripts/tests/workspace-file-search.test.ts` | **17/17 PASS**（既存 15 件 + 新規 2 件） |
| `npm run build` | **exit 0** |

## 残リスク

- sentinel 値 `-1` と実際の mtime が一致する理論的リスクは設計上ないが、システムクロックを過去に変更した場合などの極端な環境では保証外

