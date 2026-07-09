# Decisions

## Decision 1: P2 — 不在 ignore 候補の追跡方法

- **status**: confirmed
- **decision**: `SnapshotScanResult` と `WorkspaceFileIndex` に `absentIgnoreCandidates: string[]`（絶対パス列）を追加し、`checkStructureUnchanged()` でこれらが新規出現していないかを確認する
- **rationale**:
  - `ignoreFiles` は「存在したファイルの mtime」しか保持しないため、存在しなかったファイルの出現を検知できない。不在候補を別フィールドで管理することで、既存の `ignoreFiles` の構造を変えずに最小差分で対応できる
  - 候補パスの列挙は `loadInitialIgnoreMatchers()` がすでに試みているパスから機械的に導出するため、走査経路との乖離が起きにくい
  - `WorkspaceFileIndex` への追加フィールドは型変更のみで、query cache や contentVersion の仕組みには影響しない

## Decision 2: P3 — createIgnoreMatcher() の race 解消方法

- **status**: confirmed（逐次化 + 前後一致確認 + retry に更新）
- **decision**: `Promise.all([readFile(), stat()])` を廃止し、`stat → readFile → hook → stat` の逐次実行を最大 3 回（= 2 回再試行）行う。各試行で before/after の `mtimeMs` と `size` が両方一致した場合のみ "loaded" として採用する。全試行で不一致なら "race" を返す。ファイルが存在しない場合は最初の stat が失敗するため即座に "absent" を返す。
- **rationale**:
  - 読み取り前後で `mtimeMs` と `size` の両方が一致していれば、取得した内容が整合した同一版であることを保証できる
  - 1 回の競合で落ちないよう 2 回再試行することで、走査中の一時的な書き込みによる誤 null を抑制できる。scan 自体は短命であり、3 回の試行で安定しない場合は "race" を返して安全に劣化させる
  - テスト専用 hook (`_setAfterIgnoreFileReadHookForTesting`) を readFile 直後に割り込ませることで、race シナリオを決定論的に再現できる。フック方式は実際にファイルを書き換えることで OS レベルの mtime/size 変化を利用し、テストと本番コードの整合を強制する

## Decision 3: P2 — no-gitRoot 時の外部親 .gitignore 不在候補追跡範囲

- **status**: confirmed（immediate parent 限定 → 全祖先走査に更新）
- **decision**: no-gitRoot 時は `path.dirname(workspaceDirectory)` から始めてファイルシステムのルートまで祖先ディレクトリを順番に辿り、各レベルの `.gitignore` を不在候補として追跡する。すでに `ignoreFiles` に loaded されている `.gitignore` または実際に存在する `.gitignore` に到達した時点で停止する（`collectIgnoreSourceDirectories` の停止条件と対称）。
- **rationale**:
  - immediate parent 1 件のみを追跡した旧実装では、workspace から 2 段以上上位の祖先に `.gitignore` が後から作成されても TTL 超過時に検知できなかった
  - `collectIgnoreSourceDirectories` は no-gitRoot 時に最初の外部親 `.gitignore` で停止するため、不在候補の追跡範囲もその停止条件と一致させることで、再走査後の挙動と整合させられる
  - 候補数は workspace の深さに比例するが stat コストは低く、TTL チェックのたびに数十件を stat するコストは許容範囲内である

## Decision 4: ドキュメント更新不要の判断

- **status**: confirmed
- **decision**: `docs/design/`・`.ai_context/`・`README.md` は今回の対応で更新しない
- **rationale**:
  - 今回の変更は外部仕様（キャッシュの TTL 動作・検索 API・設定項目）を変えない内部実装の整合修正である
  - `docs/design/` に記述されたキャッシュ戦略の文書は「TTL 超過後に構造変更を検知して再走査する」という契約を記述しており、今回の修正はその契約をより正確に実現するものであって契約自体の変更ではない
  - 再考が必要になる条件: `absentIgnoreCandidates` フィールドを公開 API や型定義として外部に露出させる場合

