# Plan

## Goal

review-20260419-0314.md の 2 件の指摘を解消する。

- **P2**: 前回 scan 時に存在しなかった外部 ignore ファイル（`.git/info/exclude`、workspace 外の親 `.gitignore`）が新規作成された場合でも、次回検証時にキャッシュを失効させる
- **P3**: `snapshot-ignore.ts` の `createIgnoreMatcher()` で `readFile()` と `stat()` を並列実行している競合を解消し、整合した内容と mtime のペアだけをキャッシュに採用する

## Scope

- `src-electron/workspace-file-search.ts`
  - `checkStructureUnchanged()` に「存在しなかった外部 ignore 候補が新規出現したかどうか」の確認ロジックを追加する
  - `WorkspaceFileIndex` 型に不在候補を保持するフィールドを追加する
- `src-electron/snapshot-ignore.ts`
  - `createIgnoreMatcher()` の `readFile()` / `stat()` 並列実行を逐次化、または読み取り前後の mtime 比較によって整合性を保証する
  - `SnapshotScanResult` に不在候補リストを返す仕組みを追加する（P2 対応の scan 側）
- `scripts/tests/workspace-file-search.test.ts`
  - P2・P3 の回帰テストを追加する

## Out Of Scope

- `docs/design/`・`.ai_context/`・`README.md` の更新（判断は decisions.md に記載）
- UI 変更
- TTL・キャッシュ戦略の全面見直し
- `snapshot-ignore.ts` 以外のファイル I/O 箇所の race 修正

## Task List

- [x] Plan を作成する
- [x] P2 の修正方針を decisions.md に確定する
- [x] P3 の修正方針を decisions.md に確定する（retry + size 比較 + hook 方式に更新）
- [x] P2: `SnapshotScanResult` に `absentIgnoreCandidates: string[]` を追加し、`loadInitialIgnoreMatchers()` で不在パスを収集して返す
- [x] P2: `WorkspaceFileIndex` に `absentIgnoreCandidates: string[]` を追加し、scan 結果から伝播させる
- [x] P2: `checkStructureUnchanged()` で `absentIgnoreCandidates` の新規出現チェックを追加する
- [x] P3: `createIgnoreMatcher()` を retry 方式（stat → readFile → hook → stat、最大 3 回試行 = 2 回再試行、mtimeMs + size 比較）に書き換える
- [x] P3: `_setMtimeSequenceForTesting` を削除し `_setAfterIgnoreFileReadHookForTesting` を追加する
- [x] 回帰テストを追加・更新する（P2: 不在 ignore 新規出現、P3: retry 後の整合版採用 1 本に統合）
- [x] 検証を実行する（テスト・ビルド）

## Affected Files

- `src-electron/workspace-file-search.ts`
- `src-electron/snapshot-ignore.ts`
- `scripts/tests/workspace-file-search.test.ts`

## Risks

- P2: 不在候補の収集ロジックが `collectIgnoreSourceDirectories()` の探索範囲と乖離すると、検知できないパスが残る。走査と候補収集を同じ経路から導出することで一致を保証する必要がある
- P2: `.git/info/exclude` のパス特定は `findGitRoot()` の結果に依存するため、gitRoot が変化した場合（新規 `git init` 等）は不在候補のパスが陳腐化しうる。これは TTL での自然失効で吸収可能と判断する
- P3: stat → readFile → stat の逐次化でファイルが削除された場合、後半の stat が失敗して null を返す。これは既存の null ガードで正しく処理される

## Validation

- `node --import tsx scripts/tests/workspace-file-search.test.ts` が成功すること
- `npm run build` が成功すること

## Docs Sync

- `docs/design/`: 更新不要。外部 ignore 追従と race 解消はいずれも内部実装の整合修正であり、公開仕様・設計ドキュメントに記述された契約（キャッシュの TTL 動作・検索 API）は変わらないため
- `.ai_context/`: 更新不要。運用ルールや repo 前提への変更はなく、局所バグ修正に留まるため
- `README.md`: 更新不要。ユーザー向け導線・利用手順の変更ではないため
