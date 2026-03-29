# 目的

- `Character Editor` から参照できる `UpdateSession` 一覧の仕様を整理する
- `character-update session` の履歴をどこで、どう見せるかを current UI / session 保存仕様に合わせて決める

# スコープ

- `Character Editor` における `UpdateSession` 一覧の表示位置
- 一覧対象の session 条件
- 表示項目
- 並び順
- click 時の遷移
- `Recent Sessions` / `Session Monitor` から隠している update 専用 session とどう住み分けるか

# 非スコープ

- 一覧 UI の実装
- `Character Memory` の Editor 表示
- `Character Update Session` の作成導線変更
- session データ構造の追加変更

# 論点

1. どこに表示するか
   - `Profile` 内の section
   - 別 tab
   - modal / drawer
2. 何件見せるか
   - 全件
   - 件数制限 + `Show More`
3. 何を表示するか
   - `taskTitle`
   - `updatedAt`
   - `provider`
   - `runState`
4. どう開くか
   - row click で session を開く
   - 新 window を作るか既存 session window を再利用するか
5. `character-update` 以外との境界
   - `sessionKind === "character-update"` のみを対象にするか
   - character directory が同じ通常 session を含める余地を残すか

# 進め方

1. current の `character-update session` 保存仕様と Home 非表示仕様を整理する
2. `Character Editor` の existing tabs / header / footer と競合しない表示位置を決める
3. 一覧 row に必要な情報と操作を決める
4. `docs/design/character-management-ui.md` と `docs/design/desktop-ui.md` に反映する方針を固める

# 完了条件

- `UpdateSession` 一覧の表示位置、対象、row 情報、開き方が言語化されている
- 実装 task に分解できる状態になっている
