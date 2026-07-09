# Worklog: Workspace file search index 最適化

- 記録日: 2026-04-18（review 指摘対応で 2026-04-18 更新）

## 実装内容

### src-electron/snapshot-ignore.ts

**追加・変更点**（当初スコープ外だったが、全階層 mtime 取得のために変更を採用）

1. **`SnapshotScanResult` 型に `visitedDirectories` フィールド追加**
   - `Map<string, number>` — workspace root 相対ディレクトリパス（root = `""`）→ mtimeMs
   - 構造変更検知に使用
2. **`walkWorkspace` 内でディレクトリ訪問時に mtime を記録**
   - 各ディレクトリ入場時に `stat(directory)` → `visitedDirectories.set(relDir, mtimeMs)`
   - stat 失敗時は記録をスキップ（エラー耐性）
3. **`walkWorkspace` の戻り値に `visitedDirectories` を追加**
   - `return { includedFiles, ignoredFiles, visitedDirectories }`

### src-electron/workspace-file-search.ts

**追加・変更点**

1. `import` 削除: `stat` のみを `node:fs/promises` からインポート（`readdir` 不要）
2. **時刻オーバーライド注入**
   - `_nowFn` を内部変数として管理（デフォルト: `null`、`null` 時は `Date.now()` 使用）
   - `_setNowOverrideForTesting(fn)` を export — テストが実時間 sleep を使わずに TTL を制御できる
   - `getNow()` でラップし、`_nowFn !== null ? _nowFn() : Date.now()` を返す
3. **`WorkspaceFileIndex` 型**
   - フィールド: `workspacePath`, `entries: FileEntry[]`, `visitedDirectories: Map<string, number>`, `scannedAt`, `validatedAt`
   - `validatedAt` — TTL の基点。構造変化なしで延命された場合も更新される
4. **`checkStructureUnchanged(index)` を追加**
   - `visitedDirectories` の各エントリーを現在のファイルシステムと照合
   - 全エントリーの mtime が一致すれば `true`（変化なし）、1 つでも異なれば `false`
5. **`getWorkspaceFileIndex` のロジック変更**
   - TTL 内（`now - validatedAt < TTL`）→ キャッシュ返却
   - TTL 超過 + 構造変化なし → `validatedAt` だけ更新してキャッシュ延命（再走査スキップ）
   - TTL 超過 + 構造変化あり → `workspaceQueryCache` を破棄してから再走査
   - 新規走査時: `scanWorkspacePaths` を呼び出し、返った `visitedDirectories` をそのまま格納
6. **`searchWorkspaceFilePaths` にクエリキャッシュを追加**
   - `workspaceQueryCache: Map<workspacePath, Map<normalizedQuery, number[]>>` で保持
   - キャッシュキー: `normalizedQuery`（limit は含めない — `sortAndSliceResults` でスライス）
   - exact match ヒット時は cached indices を `sortAndSliceResults` に渡して返却
   - miss 時は `findBestCachedBase` で最長プレフィックスキャッシュを起点に絞り込み（prefix narrowing）
   - 検索ロジック自体は変更なし（substring 挙動を保持）
7. **`findBestCachedBase(wqCache, query)` を追加**
   - クエリの `len-1` から `1` まで短くしながらキャッシュを検索
   - 最長プレフィックスのマッチ済みインデックス配列を返す（prefix narrowing の起点）
8. **`clearWorkspaceFileIndex` の拡張**
   - 引数なし: `workspaceFileIndexCache.clear()` + `workspaceQueryCache.clear()`
   - 引数あり: 対象 workspacePath の両キャッシュを `delete`

### scripts/tests/workspace-file-search.test.ts

**変更点**

- `_setNowOverrideForTesting` を import に追加
- 旧テスト "TTL を過ぎた cache は自動再走査される" を改名・改修
  - `_setNowOverrideForTesting` で時刻を制御し、実時間 sleep を廃止
- 新テスト追加（計 9 テスト）:
  1. `cache clear 後は新規 file が再検索結果へ反映される`
  2. `TTL を過ぎた cache は自動再走査される（構造変化あり）`
  3. `TTL を過ぎても構造変化がなければ再走査されず同じ結果を返す`
  4. `サブディレクトリ内のファイル追加は TTL 超過後に検出される`（1 段目変化）
  5. `連続 query / クエリキャッシュを使っても substring 検索結果が壊れない`
  6. `clearWorkspaceFileIndex でクエリキャッシュも破棄される`
  7. `TTL 更新後も query cache が再利用可能なままである（同一結果を返す）`
  8. `2 段以上深いディレクトリへのファイル追加は TTL 超過後に検出される`（deep hierarchy テスト）
  9. `再走査後は新規ファイルが検索結果に反映される`

### package.json / package-lock.json

- `version`: `1.0.9` → `1.0.10` (patch bump)
- `package-lock.json` のルートおよび `packages[""]` 両方を更新

## 検証結果

```
npm test 実行結果:
  pass 349
  fail 0

workspace-file-search テスト（9件）すべて通過
```

---

## same-plan 修正: query cache contentVersion 導入（2026-04-18）

### 背景

TTL 超過 + 構造変化なしのケースでは `validatedAt` だけ更新して再走査をスキップする。
この場合 `workspaceQueryCache` の既存エントリーは「delete しない限り有効」という暗黙依存だった。
構造変化時に `workspaceQueryCache.delete()` を呼んでいるため正確には機能していたが、
将来の変更で delete を忘れた場合に古い query cache が残る可能性があった。
また query cache エントリーが自身の有効性を自己検証できない設計だった。

### 変更内容

#### src-electron/workspace-file-search.ts

1. **内部カウンター `_contentVersionCounter` を追加**
   - モジュールスコープで `let _contentVersionCounter = 0`
   - 実際の再走査（entries 更新）時のみ `++_contentVersionCounter` でインクリメント
2. **`WorkspaceFileIndex` 型に `contentVersion: number` フィールドを追加**
   - 再走査時のみ更新（`contentVersion: ++_contentVersionCounter`）
   - TTL のみの延命（`validatedAt` 更新）では変化しない
3. **`QueryCacheEntry` 型を追加**
   - `{ matchedIndices: number[]; contentVersion: number }`
   - `workspaceQueryCache` の値型を `number[]` から `QueryCacheEntry` に変更
4. **`findBestCachedBase` のシグネチャを変更**
   - 第3引数に `contentVersion: number` を追加
   - `cached.contentVersion === contentVersion` を満たすエントリーのみ返す
5. **`searchWorkspaceFilePaths` のキャッシュ照合ロジックを変更**
   - exact match 時: `exactCached.contentVersion === index.contentVersion` も確認
   - 書き込み時: `{ matchedIndices, contentVersion: index.contentVersion }` で保存
6. **`_getContentVersionForTesting(workspacePath)` を export**
   - テスト専用ヘルパー。指定 workspace の現在の `contentVersion` を返す

#### scripts/tests/workspace-file-search.test.ts

- `_getContentVersionForTesting` を import に追加
- `TTL 更新後も query cache が再利用可能なままである（同一結果を返す）` → `（contentVersion 不変を検証）` に改名し `contentVersion` アサーション追加
- `再走査後は新規ファイルが検索結果に反映される` → `再走査後は contentVersion が更新され query cache が失効する` に改名し `contentVersion` アサーション追加

### 検証結果

```
npm test 実行結果:
  pass 346
  fail 0

workspace-file-search テスト（9件）すべて通過
  ✔ TTL 更新後も query cache が再利用可能なままである（contentVersion 不変を検証）
  ✔ 再走査後は contentVersion が更新され query cache が失効する

npm run typecheck（tsconfig.electron.json）: 成功
npm run build: 成功
```