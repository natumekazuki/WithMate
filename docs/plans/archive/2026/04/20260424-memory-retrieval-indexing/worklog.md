# Worklog

## 2026-04-24

- `docs/optimization-roadmap.md` の `Memory retrieval indexing` を確認した。
- `src-electron/project-memory-retrieval.ts` と `src-electron/character-memory-retrieval.ts` の現行 retrieval が query ごとに全 entry を scoring していることを確認した。
- 既存テスト `scripts/tests/project-memory-retrieval.test.ts` と `scripts/tests/character-memory-retrieval.test.ts` を確認した。
- repo plan を作成した。
- `Project Memory` retrieval に entry 前処理 cache、runtime inverted index、candidate 絞り込みを導入した。
- `Character Memory` retrieval に entry 前処理 cache、runtime inverted index、candidate 絞り込みを導入した。
- `docs/design/memory-architecture.md`、`docs/design/project-memory-storage.md`、`docs/design/character-memory-storage.md` に runtime index の現行仕様を追記した。
- `npm ci --offline --ignore-scripts` でローカル cache から依存を復元した。
- `npx tsc -p tsconfig.electron.json --noEmit --pretty false` が成功した。
- `npm test -- --test-name-pattern "Project|Character Memory retrieval"` と対象 test file の直接実行は sandbox の `spawn EPERM` で失敗した。
- `npm run typecheck` は既存 tests / renderer 側 type error で失敗した。

## Commit tracking

- 未コミット。
