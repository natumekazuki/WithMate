# Decisions

## Decision 1: race 時の ignoreFiles への sentinel 記録

- **status**: confirmed
- **decision**: `kind: "race"` が返った ignore ファイルを `ignoreFiles` に `mtime = -1` の sentinel で記録する
- **rationale**:
  - `checkStructureUnchanged()` は `ignoreFiles` に記録された mtime と実際の stat mtime を比較する。実際の mtime は Unix エポック ms 基準で ≥ 0 のため、sentinel `-1` との不一致は必ず検出される。これにより race 解消後の最初の TTL 超過で確実に re-scan に導ける
  - 新フィールドを追加しないため型変更・伝播コストが最小である
  - `absentIgnoreCandidates` は「存在しないファイルの新規出現」を検知するためのフィールドであり、「存在するが読めなかった」race とは意味が異なるため流用しない

## Decision 2: applyIgnoreFileResult() helper の設計

- **status**: confirmed
- **decision**: `loaded` / `race` の `ignoreFiles` / `loadedDirectories` 更新を共通 helper `applyIgnoreFileResult()` に集約する。`absent` は呼び出し側で扱う（call site ごとに処理が異なるため）
- **rationale**:
  - `loadInitialIgnoreMatchers()` と `walkWorkspace()` はどちらも `loaded` のときに同じ操作（`loadedDirectories.add()` / `ignoreFiles.set()`）を行っており重複している
  - `absent` は `loadInitialIgnoreMatchers()` では外部ディレクトリ判定後に `absentIgnoreCandidates` へ追加するが、`walkWorkspace()` 内では追加しない（workspace 内のディレクトリは mtime 変化で検知できる）ため、helper に含めると分岐が複雑になる

## Decision 3: exclude パスへの applyIgnoreFileResult() 適用

- **status**: confirmed
- **decision**: `directory: null` で `applyIgnoreFileResult()` を呼び出し、`loadedDirectories` の更新を抑制する
- **rationale**:
  - `.git/info/exclude` は特定ディレクトリの `.gitignore` ではなく、`loadedDirectories` に追加しても `walkWorkspace()` の gitignore 二重ロード抑止には寄与しない
  - `gitRoot` を `directory` に渡すと、`gitRoot` の `.gitignore` を `walkWorkspace()` 内で再ロードしない副作用が出る可能性がある。null にすることで既存の `loadedDirectories` 管理を乱さない

## Decision 4: ドキュメント更新不要

- **status**: confirmed
- **decision**: `docs/design/`・`.ai_context/`・`README.md` は今回の対応で更新しない
- **rationale**: 外部仕様（TTL キャッシュ動作・検索 API）は変わらない内部実装バグ修正のため
