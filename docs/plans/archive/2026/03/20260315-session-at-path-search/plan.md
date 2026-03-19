# Plan

- タスク: Session composer の `@path` 入力中に workspace 内ファイル候補を探索表示し、picker で選んだ path も textarea に統一する
- 目的: picker を開かずに、テキスト入力中に `@` からファイル参照を選べるようにし、添付解決の正本を textarea の `@path` に揃える

## 進め方

1. 既存の attachment / `@path` 解決ロジックを確認する
2. workspace 内ファイル候補を返す Main Process API を追加する
3. renderer で `@` 入力中の query を検出し、候補一覧を表示する
4. 候補クリックで textarea に path を挿入できるようにする
5. picker で選んだ file / folder / image も textarea に path を挿入する
6. 実行直前の添付解決を textarea の `@path` のみに統一する
7. docs/design と実機テスト項目を更新する
8. `typecheck` / `build` を通す
