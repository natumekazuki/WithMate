# Memory retrieval indexing plan

- 作成日: 2026-04-24
- Plan tier: repo plan
- 対象: `src-electron/project-memory-retrieval.ts`, `src-electron/character-memory-retrieval.ts`

## 目的

`docs/optimization-roadmap.md` の `Memory retrieval indexing` を実装し、memory retrieval のたびに全 entry へ正規化・token 照合・scoring を行うコストを下げる。

## 方針

- 公開 API は同期関数のまま維持する。
- entry 側の正規化済み haystack、fingerprint、feature index を retrieval 呼び出し内で構築し、query 時の candidate 絞り込みに使う。
- user query に直接一致する candidate を優先し、session context / reflection context は ranking 補助として使う。
- candidate が無い場合は現行仕様に合わせて `Project Memory` は空配列、`Character Memory` は recent fallback を返す。
- schema / DB 契約は変更せず、storage migration は行わない。

## チェックポイント

1. [x] 現状の retrieval ロジックと既存テストを確認する。
2. [x] `Project Memory` retrieval に entry index と candidate 絞り込みを導入する。
3. [x] `Character Memory` retrieval に entry index と candidate 絞り込みを導入する。
4. [x] 既存 ranking / threshold / dedupe / fallback の挙動をテストで維持する。
5. [x] `docs/design/memory-architecture.md` に retrieval indexing の現行仕様を追記する。
6. [x] 関連テスト、必要なら typecheck を実行する。

## 検証

- `npm test -- --test-name-pattern "Project|Character Memory retrieval"` は sandbox の `spawn EPERM` で実行不可。
- `npx tsx --test scripts/tests/project-memory-retrieval.test.ts` / `npx tsx --test scripts/tests/character-memory-retrieval.test.ts` も同じ `spawn EPERM` で実行不可。
- `npx tsc -p tsconfig.electron.json --noEmit --pretty false` は成功。
- `npm run typecheck` は既存の tests / renderer 側 type error で失敗。

## 完了条件

- `Project Memory` と `Character Memory` の retrieval が candidate 絞り込み型になっている。
- 既存の retrieval 結果が壊れていない。
- 設計ドキュメントに runtime index の責務と非ゴールが反映されている。
