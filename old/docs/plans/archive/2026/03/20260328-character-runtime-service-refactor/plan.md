# Plan

- 目的: `main.ts` に残っている character CRUD / lookup helper を service に分離する
- 完了条件:
  - `create/update/delete/get/refresh/resolveSessionCharacter` が service 化される
  - session 側への character 反映と editor close も service に寄る
  - `npm run build` と関連 unit test が通る
- スコープ外:
  - Character Editor UI の仕様変更
