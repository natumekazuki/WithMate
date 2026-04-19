# Plan

- status: done

## 目的

- 恒常的な subtree 読み取り失敗や ignore 読み取り失敗がある workspace でも、TTL ごとに無限にフル再走査しないようにする

## 完了条件

1. 一時失敗と恒常失敗を区別できる形で再走査判定が更新されている
2. 恒常失敗では毎 TTL 再走査せず、一定間隔でのみ再試行する
3. 一時失敗は従来どおり次回 TTL で速やかに再試行される
4. 回帰テストが追加され、関連テストが成功する
5. 文書更新要否を確認し、必要なら反映する

## 実施項目

1. 既存の `directoriesNeedingRescan` / `ignoreFiles` の表現を見直す
2. `checkStructureUnchanged()` の再走査条件を backoff 付きに調整する
3. 恒常 failure 系の回帰テストを追加する
4. テスト実行と docs 影響確認を行う

## 実施結果

- `src-electron/snapshot-ignore.ts`
  - directory failure を transient / persistent で分類できるようにした
  - `stat` だけ失敗して `readdir` が成功したケースは transient 扱いにして、次回 TTL で監視を復旧するようにした
  - ignore の初回 `stat` access error や `EISDIR` 系を `unreadable` として扱えるようにした
- `src-electron/workspace-file-search.ts`
  - persistent な directory failure は `DEFAULT_PERSISTENT_DIRECTORY_RETRY_INTERVAL_MS` 超過時のみ再試行するようにした
  - `ignoreFiles.kind === "unreadable"` は毎 TTL で `stat()` せず、retry interval 超過時のみ再試行するようにした
- `scripts/tests/workspace-file-search.test.ts`
  - 恒常 `readdir` failure と恒常 `.gitignore stat` failure の回帰テストを追加した
  - 既存の初回 `.gitignore stat` access error テストを backoff 方針へ更新した

## 検証

- `node --import tsx scripts/tests/workspace-file-search.test.ts`: 27/27 PASS
- `npm run build`: PASS

## Docs Sync

- `docs/design/`: 更新不要
  - 今回の変更は `workspace-file-search` / `snapshot-ignore` の内部 invalidation と retry/backoff 方針の調整で、公開仕様や UI 契約は変えていないため
- `README.md`: 更新不要
  - 利用方法やセットアップ手順に変更がないため
- `.ai_context/`: 対象ディレクトリ自体が存在しないため更新なし
