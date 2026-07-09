# Decisions

## Decision 1: query cache は件数上限つき recent cache にする

- **status**: confirmed
- **decision**: `workspaceQueryCache` は workspace ごとに件数上限つき recent cache とし、古い query エントリーを確実に排出する
- **options**:
  - A. 上限超過時に全削除
  - B. FIFO 的な単純件数上限
  - C. `Map` の順序を利用した LRU 近似
- **rationale**:
  - review 指摘は「recent cache」としての前提に対し件数上限がない点にある
  - `Map` の delete + set で最近参照した key を末尾へ移せるため、追加コストなしで LRU 近似を実装できる
  - typeahead の prefix narrowing 効果を残しつつ、メモリ使用量の上限を持てる
  - 実装では `DEFAULT_WORKSPACE_QUERY_CACHE_MAX_ENTRIES = 200` を採用した

## Decision 2: ignore ファイル状態は `loaded` / `unreadable` / `race` を明示的に分ける

- **status**: confirmed
- **decision**: `ignoreFiles` の表現を単なる mtime 値から、明示的な状態を持つ型へ見直す
- **options**:
  - A. sentinel mtime を維持しつつ `readFile()` エラー分類だけ直す
  - B. ignore ファイル状態を `loaded` / `unreadable` / `race` に分け、`checkStructureUnchanged()` も状態ごとに扱う
- **rationale**:
  - sentinel `-1` は「真の race で次回 TTL 時に再走査すべき」という意味では有効だが、安定 unreadable とは意味が異なる
  - 状態を明示すれば `race` の強制 invalidation と `unreadable` の bounded retry を分離できる
  - review 指摘が続いているため、値のトリックより状態の意味を型で表した方が保守しやすい

## Decision 3: stable unreadable は bounded retry で再評価する

- **status**: confirmed
- **decision**: ACL / 共有ロック等の安定 unreadable は毎 TTL では再走査せず、別の retry 間隔で再評価する
- **options**:
  - A. mtime が変わるまで再評価しない
  - B. 毎 TTL で再評価する
  - C. `scannedAt` 基準の bounded retry で再評価する
- **rationale**:
  - A は共有ロック解除後に stale が長く残りうる
  - B は今回の review 指摘どおり恒常的な高コストループになる
  - C なら永久ループを避けつつ、時間経過で回復も試せる
  - 実装では `DEFAULT_UNREADABLE_IGNORE_RETRY_INTERVAL_MS = DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS * 10` を採用した

## Decision 4: docs 更新不要

- **status**: confirmed
- **decision**: `docs/design/`・`.ai_context/`・`README.md` は更新しない
- **rationale**:
  - query cache 上限追加と ignore 読み取り失敗分類の見直しは、いずれも内部実装の安定性向上であり公開仕様の変更ではないため
