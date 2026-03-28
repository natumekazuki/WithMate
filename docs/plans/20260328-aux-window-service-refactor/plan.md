# Plan

- 目的: `main.ts` に残っている non-session window の生成 / 再利用 / registry を service に分離する
- 完了条件:
  - `Home / Monitor / Settings / CharacterEditor / Diff` の window 管理が service 化される
  - diff preview store と reset 時 close が service 側へ移る
  - `npm run build` と関連 unit test が通る
- スコープ外:
  - `Session Window` 自体の registry 変更
