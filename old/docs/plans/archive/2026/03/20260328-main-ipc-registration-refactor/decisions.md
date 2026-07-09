# Decisions

- register helper は `ipcMain` 本体を注入して使う
- handler 実装は `main.ts` の composition root で組み立て、helper には delegate として渡す
