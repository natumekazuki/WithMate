# Result: Workspace file search index 最適化

- 記録日: 2026-04-18（review 指摘対応で 2026-04-18 更新）
- ステータス: 完了

## 達成した完了条件

- [x] 単純 TTL だけでなく、workspace 構造変更を見て cache 再利用可否を判断できる
  - `scanWorkspacePaths` が返す `visitedDirectories`（全走査ディレクトリ → mtimeMs）を `checkStructureUnchanged` で照合
  - 2 段以上深い階層の変化も `visitedDirectories` に含まれるため検出可能
- [x] 検索用の前処理済み cache を持ち、同一 query / 連続入力時の再計算を減らす
  - `workspaceQueryCache` でクエリキャッシュ実装、キー = `normalizedQuery`（limit 除外）
  - `findBestCachedBase` による prefix narrowing で前クエリ結果を起点に絞り込み
- [x] 既存の substring 検索挙動は壊さない
  - 検索ロジック自体は無変更、テストで網羅
- [x] `clearWorkspaceFileIndex()` で関連 cache も含めて破棄される
  - `workspaceQueryCache.clear()` / `.delete()` を追加
- [x] テストが不必要に長時間待たない
  - 旧 TTL テストの実時間 sleep を廃止、`_setNowOverrideForTesting` で時刻制御
- [x] バージョン 1.0.10 に更新
- [x] docs/design / .ai_context / README 更新要否を判断し理由を decisions.md に記録（更新不要と判断）
- [x] 2 段以上深い階層の変化検出テストを追加（review 指摘 4 対応）

## 変更ファイル一覧

| ファイル | 変更種別 |
| --- | --- |
| `src-electron/workspace-file-search.ts` | 改修 |
| `src-electron/snapshot-ignore.ts` | 改修（`visitedDirectories` 追加） |
| `scripts/tests/workspace-file-search.test.ts` | 更新 |
| `package.json` | version bump |
| `package-lock.json` | version bump |
| `docs/plans/archive/2026/04/20260418-workspace-file-search-index-optimization/plan.md` | 新規 |
| `docs/plans/archive/2026/04/20260418-workspace-file-search-index-optimization/decisions.md` | 新規 |
| `docs/plans/archive/2026/04/20260418-workspace-file-search-index-optimization/worklog.md` | 新規 |
| `docs/plans/archive/2026/04/20260418-workspace-file-search-index-optimization/result.md` | 新規 |
| `docs/plans/archive/2026/04/20260418-workspace-file-search-index-optimization/questions.md` | 新規 |

## 未実施事項（follow-up 候補）

| 事項 | 理由 |
| --- | --- |
| クエリキャッシュのサイズ上限 / LRU eviction | 現状は Map サイズ unbounded（インデックス更新時に全削除）。長寿命プロセスで query 種類が爆発するケースがあれば上限を設ける。独立した最適化として新規 plan で扱う。 |
| prefix trie / bounded prefix seed index | substring 検索への恩恵が限定的なため据え置き。利用パターン計測後に判断。 |
| UI 側 debounce 調整 | `opt/session-input-responsiveness` の担当範囲。 |

## テスト結果

```
pass 349 / fail 0
workspace-file-search テスト 9 件すべて通過
```

---

## same-plan 修正追記（2026-04-18）

### 修正内容

query cache エントリーが自己検証できない設計を改善。

- `WorkspaceFileIndex` に `contentVersion: number` フィールドを追加（再走査時のみ更新）
- `QueryCacheEntry` 型を導入し `{ matchedIndices, contentVersion }` で保存
- 照合時に `cached.contentVersion === index.contentVersion` を確認
- `_getContentVersionForTesting` テストヘルパーを追加

これにより TTL 更新のみでは `contentVersion` が不変 → query cache エントリーが有効のまま維持される。

### 追加完了条件

- [x] TTL のみの延命では `contentVersion` が変わらない（テスト「contentVersion 不変を検証」で確認）
- [x] 再走査後は `contentVersion` が更新される（テスト「再走査後は contentVersion が更新され...」で確認）
- [x] `npm test` pass 346 / fail 0