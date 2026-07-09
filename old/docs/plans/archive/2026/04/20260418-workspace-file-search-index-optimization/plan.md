# Plan: Workspace file search index 最適化

- 作成日: 2026-04-18（review 指摘対応で 2026-04-18 更新）
- ブランチ: opt/workspace-file-search-index
- ステータス: 実装完了

## repo plan 判定理由

本タスクを repo plan として管理する理由は以下の通り。

1. **複数段階の変更を含む** — invalidation ロジック変更・クエリキャッシュ導入・テスト更新・version bump が連動しており、1 commit で完結しない粒度がある。
2. **最適化 + テスト + version bump の複合** — src-electron の実装変更、test スイート拡充、package.json/package-lock.json の version 更新が同一 task に含まれる。
3. **handoff 価値あり** — 後続の `opt/discovery-cache` や `opt/workspace-snapshot-diff-pipeline` が同系統の cache 方針を踏襲できるよう、設計判断を decisions.md へ記録する。

## 目的

`docs/optimization-roadmap.md` の "Workspace file search index" 候補を実装する。

- `@path` 検索の scan 頻度を抑える
- 同一 query の再計算コストを下げる
- 入力体感改善の補強 (Session input responsiveness の後続)

## 対象ファイル

| ファイル | 変更種別 |
| --- | --- |
| `src-electron/workspace-file-search.ts` | 改修 (invalidation + query cache) |
| `src-electron/snapshot-ignore.ts` | 改修 (`visitedDirectories` 追加) |
| `scripts/tests/workspace-file-search.test.ts` | 更新 (新テスト追加 + 時刻 mock 化) |
| `package.json` | version 1.0.9 → 1.0.10 |
| `package-lock.json` | version 1.0.9 → 1.0.10 |

## 実装スコープ

### 1. TTL + workspace 構造変化検出による invalidation

- TTL は `DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS = 30_000` ms（当初 5,000ms から変更 → D-07 参照）
- `snapshot-ignore.ts` の `walkWorkspace` でディレクトリ訪問時に mtime を記録（`visitedDirectories`）
- TTL 超過時、`visitedDirectories` で全走査ディレクトリの mtime を照合（`checkStructureUnchanged()`）
  - 変化あり → 再走査
  - 変化なし → `validatedAt` だけ更新してキャッシュ延命（scan スキップ）
- `visitedDirectories` により 2 段以上深い変化も検出可能（`src/components/` レベルまでカバー）

### 2. クエリキャッシュ (recent query cache + prefix narrowing)

- `workspaceQueryCache: Map<workspacePath, Map<normalizedQuery, number[]>>` で保持
- キャッシュキー = `normalizedQuery`（limit 除外 → D-04 参照）
- インデックス更新時（再走査 or clear 時）にクエリキャッシュも破棄
- `findBestCachedBase` で最長プレフィックスキャッシュを起点に絞り込み（prefix narrowing）

### 3. テスト用時刻オーバーライド

- `_setNowOverrideForTesting(fn)` をアンダースコア付きで export し、テストで時刻を進める
- 長い実時間待機を廃止
- `null` 渡しで `Date.now()` に戻る

### 4. clearWorkspaceFileIndex() の保証

- 既存: `workspaceFileIndexCache` を clear/delete
- 追加: `workspaceQueryCache` も同様に clear/delete

## スコープ外

- UI 側の debounce 調整 (`opt/session-input-responsiveness` で扱う)
- prefix index / trie (初回最適化では recent query cache + prefix narrowing で十分)
