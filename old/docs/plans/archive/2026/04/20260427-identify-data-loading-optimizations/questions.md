# Questions

- Status: 確認済み

## Round 1

### Q1. AI エージェント prompt への Memory 注入

AI エージェントのトークン効率を優先し、coding plane prompt への Memory 注入をどう扱いますか。

- 回答: A: `Session Memory` と `Project Memory` の prompt 注入を両方止める。

選択肢:

- A: `Session Memory` と `Project Memory` の prompt 注入を両方止める。
- B: `Session Memory` の常設注入を止め、`Project Memory` は明確な retrieval hit がある時だけ残す。
- C: prompt 注入は残し、生成や検索の質を改善する。

### Q2. MemoryGeneration の扱い

MemoryGeneration は prompt 有用性が低い前提で、今回どこまで削りますか。

- 回答: A: 完全削除する。自動抽出、手動実行、Settings、右ペイン表示、関連 background activity を削除する。

選択肢:

- A: 完全削除する。自動抽出、手動実行、Settings、右ペイン表示、関連 background activity を削除する。
- B: 自動実行と prompt 注入だけ止める。既存 Memory 管理 UI と手動編集・閲覧は残す。
- C: 今回は削除しない。prompt 注入条件の見直しだけ行う。

### Q3. 独り言機能の扱い

独り言機能は今回どこまで削りますか。

- 回答: A: 完全削除する。生成、右ペイン表示、stream 追記、関連 background activity を削除する。

選択肢:

- A: 完全削除する。生成、右ペイン表示、stream 追記、関連 background activity を削除する。
- B: 自動生成だけ止める。既存 stream の表示または履歴互換は残す。
- C: 今回は削除しない。

### Q4. 既存 DB データの扱い

削除または縮退する場合、既存 DB の Memory / monologue / background audit log はどう扱いますか。

- 回答: A: DB からは削除しない。新 UI / 新処理から参照しないだけにする。

選択肢:

- A: DB からは削除しない。新 UI / 新処理から参照しないだけにする。
- B: アプリ内の初期化・cleanup 導線で削除できるようにするが、自動削除はしない。
- C: migration で不要データを削除する。

### Q5. 実装優先順位

今回の最初の実装 slice はどれを優先しますか。

- 回答: A: prompt 注入停止 / MemoryGeneration / 独り言の削除・縮退を先に行う。

選択肢:

- A: prompt 注入停止 / MemoryGeneration / 独り言の削除・縮退を先に行う。
- B: session / audit log の軽量化を先に行う。
- C: Memory Management の分割 API を先に行う。
