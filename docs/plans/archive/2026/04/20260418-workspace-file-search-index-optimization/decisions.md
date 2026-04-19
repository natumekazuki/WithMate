# Decisions: Workspace file search index 最適化

- 作成日: 2026-04-18（review 指摘対応で 2026-04-18 更新）

## D-01: snapshot-ignore.ts の変更を採用した理由

**決定**: `snapshot-ignore.ts` の `SnapshotScanResult` に `visitedDirectories: Map<string, number>` を追加し、`walkWorkspace` 内で各ディレクトリ訪問時に `stat()` で mtime を記録するよう変更する。

**当初の判断（変更なし）を覆した理由**:
- 当初は `captureTopLevelMtimes()` を `workspace-file-search.ts` 内にローカル実装することで snapshot-ignore.ts を変更しない方針だった。
- しかし、ローカル実装では `workspace root の直下エントリーのみ`を対象にするため、2 段以上深いディレクトリ（例: `src/components/`）への変化を検出できないという制限があった。
- `walkWorkspace` は scan 時にすべてのディレクトリを走査するため、そのタイミングで各ディレクトリの mtime を記録するのが最も効率的かつ正確であると判断した。
- 結果として、`captureTopLevelMtimes()` という独立関数は不要になり、stat 呼び出し回数は「scan 1 回で全ディレクトリをカバー」という形に集約された。

**トレードオフ（採用時のコスト）**:
- `walkWorkspace` の各ディレクトリで `stat()` を 1 回追加で呼ぶため、大規模プロジェクト（数千ディレクトリ）では scan コストが増加する。
- `SnapshotScanResult` に invalidation 用データが混在し、snapshot capture 専用の型でなくなる。
- `captureWorkspaceSnapshot` 側では `visitedDirectories` は不使用（`onFile` コールバックで処理）だが、型として保持されることになる。

**許容範囲と判断した理由**:
- `stat()` の追加呼び出しは scan 対象ディレクトリ数に線形比例する。`readdir` + 各エントリーの `stat` が既に発生している scan ループに 1 回の `stat` を追加するだけであり、オーバーヘッドは小さい。
- 2 段以上深い変化の検出は、実際の `@path` 検索ユースケース（コンポーネントディレクトリへの追加等）では頻繁に発生するため、検出精度の向上はユーザー体感の改善に直結する。
- `SnapshotScanResult` の構造変化は、`captureWorkspaceSnapshot` の呼び出し側に影響しない（`visitedDirectories` を無視すればよいだけ）。

## D-02: prefix trie ではなく recent query cache + prefix narrowing を採用

**決定**: 初回最適化は recent query cache (Map) で実装し、さらに prefix narrowing (`findBestCachedBase`) を追加。prefix trie は採用しない。

**理由**:
- `@path` 検索は substring 検索（任意位置の部分一致）であり、prefix trie の恩恵を受けにくい。
- 実際の利用パターンは「同一クエリの連続呼び出し」「デバウンス後の再送」「1 文字ずつ増える連続入力」が主であり、exact-match cache + prefix narrowing で十分なコスト削減が見込める。
- trie 管理のコードが増え、substring 検索の正しさを維持するための変換が複雑になる。
- `findBestCachedBase` はクエリ長に線形な単純ループで実装でき、正確性を損なわない。

## D-03: TTL 超過 + 構造変化なし → scan スキップ

**決定**: TTL が切れても `visitedDirectories` の mtime に変化がなければ再走査せず `validatedAt` だけ更新する。

**理由**:
- `scanWorkspacePaths()` は全ファイルツリーを走査するため、変化がないのに TTL ごとに走査するのは無駄。
- `visitedDirectories` は走査した全ディレクトリの mtime を記録しているため、根の変化から深い階層の変化まで検出可能。
- ファイル追加・削除がない限り検索結果は変わらないため、cache 継続は安全。
- `validatedAt` を TTL の基点とすることで、structure check 成功時もキャッシュを延命できる。

## D-04: クエリキャッシュキーに limit を含めない

**決定**: クエリキャッシュキーは `normalizedQuery` のみとする（limit を含めない）。

**理由**:
- キャッシュには「全マッチエントリーのインデックス配列」を格納し、limit による切り詰めは `sortAndSliceResults` でキャッシュ後に適用する。
- これにより、同一クエリで異なる limit の呼び出しでもキャッシュヒットし、再検索コストをゼロにできる。
- limit ごとに別キャッシュエントリーを作る必要がなく、メモリ効率が良い。
- 実運用では `DEFAULT_SEARCH_LIMIT = 20` で呼ばれるケースが大半だが、将来的に limit を変えるコードが追加された場合も正しく動作する。

## D-05: テスト用時刻オーバーライドの export

**決定**: `_setNowOverrideForTesting(fn)` をアンダースコア付きで export し、テストから時刻を制御可能にする。

**理由**:
- TTL テストが `DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS + 100 ms` (30.1 秒) 実時間で待つのを避けるため。
- `null` を渡すと元の `Date.now()` に戻る設計でクリーンアップが容易。
- アンダースコアプレフィックスで「テスト専用」を慣例的に示す。
- production コードからはこの関数を呼ばない。

## D-06: docs/design / .ai_context / README 更新は不要

**判定**: 今回の変更はすべて `src-electron/workspace-file-search.ts` のキャッシュ内部実装と `src-electron/snapshot-ignore.ts` の型拡張に限定。

- `docs/design/` — IPC 契約変更なし、永続化スキーマ変更なし → 更新不要
- `.ai_context` — 存在しない（本リポジトリには `.ai_context` ディレクトリなし）
- `README.md` — 開発コマンドや構成説明に変化なし → 更新不要
- `docs/optimization-roadmap.md` — 着手済みの記録は plan/result で管理し、roadmap 自体は "次に branch を切る時の判断材料" として維持する設計のため更新不要

## D-07: TTL を 5,000ms から 30,000ms へ変更

**決定**: `DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS = 30_000`（30 秒）を採用する。

**背景**:
- 当初 plan.md では TTL = 5,000ms（5 秒）を維持する設計だった。
- 実装過程で、`checkStructureUnchanged` の仕組み（structure check 成功時は `validatedAt` を更新してキャッシュ延命）により、TTL の意味が「ファイル変化なければ最大 N 秒後まで再 scan なし」に変わることが明確になった。

**変更理由（5s → 30s）**:

| 観点 | 5s の場合 | 30s の場合 |
| --- | --- | --- |
| structure check 頻度 | 最大 6 回/30 秒（変化がなくても） | 最大 1 回/30 秒 |
| ファイル変化検出の最大遅延 | 5 秒 | 30 秒 |
| scan コスト（変化ある場合） | 5s 周期で再走査 | 変化時のみ再走査 |
| ユーザー体感 | ファイル追加後最大 5 秒で反映 | ファイル追加後最大 30 秒で反映 |

- `checkStructureUnchanged` は stat 呼び出しのみで全走査より大幅に軽い。5s ごとに呼ぶことは許容できるが、scan スキップの恩恵を最大化するには TTL を長めに設定するほうが効率的。
- `@path` 検索は「ファイルを作ってすぐ検索する」用途より「作業中のファイルを素早く見つける」用途が主であり、30 秒の遅延は実用上許容範囲と判断。
- UI 側の debounce（`opt/session-input-responsiveness`）と合算しても、30 秒の最大遅延はインタラクティブな使用中に問題になりにくい。
- 後続タスクで遅延が問題になる場合は TTL 値を下げるか、変化検知の仕組みを OS の file watcher に切り替えることで対応できる。

## D-07: query cache エントリーに contentVersion を持たせて自己検証する

**決定**: query cache の各エントリーを `{ matchedIndices: number[]; contentVersion: number }` 型にし、ヒット判定時に `cached.contentVersion === index.contentVersion` を確認する。

**理由**:
- 旧設計は「構造変化時に `workspaceQueryCache.delete()` を呼ぶ」という副作用に依存した invalidation だった。
- delete を呼び忘れた場合や将来のリファクタ時に query cache が古い index を参照し続けるリスクがあった。
- `contentVersion` を各エントリーに持たせることで、delete の有無によらず「このエントリーは現在の index と同一版か」を自己検証できる。
- 結果として TTL のみの延命（`validatedAt` 更新・`contentVersion` 不変）では query cache が有効のまま維持される正確な動作が保証される。

## D-08: `contentVersion` はタイムスタンプでなく単調増加カウンターとする

**決定**: `contentVersion` の値は `_contentVersionCounter` をインクリメントした整数とする。

**理由**:
- タイムスタンプ（`Date.now()`）は同一ミリ秒で複数の走査が起きた場合に衝突するリスクがある。
- カウンターは同一プロセス内で単調増加が保証され、TTL テストで `_nowFn` を制御していても独立して動作する。
- テスト内で `versionAfterFirstScan` と `versionAfterTTLRenewal` の等値/非等値を `assert.equal` / `assert.notEqual` で簡潔に検証できる。