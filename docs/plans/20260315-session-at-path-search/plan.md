# Plan

- タスク: Session composer の @path 入力中に workspace 内ファイル候補を探索表示する
- 目的: picker を開かずに、テキスト入力中に @ からファイル参照を選べるようにする

## 進め方

1. 既存の attachment / @path 解決ロジックを確認する
2. workspace 内ファイル候補を返す Main Process API を追加する
3. renderer で @ 入力中の query を検出し、候補一覧を表示する
4. 候補クリックで textarea に path を挿入できるようにする
5. docs/design と実機テスト項目を更新する
6. 	ypecheck / uild を通す
