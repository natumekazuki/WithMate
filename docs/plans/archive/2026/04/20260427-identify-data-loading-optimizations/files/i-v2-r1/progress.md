# 進捗: i-v2-r1 / phase 1 (Red)

- スライス: `V2 runtime read-path`
- TDDフェーズ: `red`
- 変更方針: `src-electron/app-database-path.ts` の実装を触らず、テストのみ追加
- 追加テスト: `scripts/tests/app-database-path.test.ts`
- 追加した検証観点
  - `withmate-v2.db` があるときはそれを選択する
  - `withmate-v2.db` がない場合に `withmate.db` を選択する
  - 両方存在時は `withmate-v2.db` を優先する
  - どちらもない場合は `withmate.db` を返して起動時 migration を走らせない
- 未実施: 実装本体 (`src-electron/app-database-path.ts`) の追加
