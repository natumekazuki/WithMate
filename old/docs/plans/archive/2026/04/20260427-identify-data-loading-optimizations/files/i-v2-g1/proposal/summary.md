# 実装サマリ (i-v2-g1)

- 追加: `src-electron/app-database-path.ts`
  - `resolveAppDatabasePath(userDataPath: string): string` を追加
  - 判定順:
    1. `<userData>/withmate-v2.db` の存在を確認し、存在すればそれを返却
    2. それ以外は `<userData>/withmate.db` を返却
  - いずれの場合も新規作成/移行処理を行わない
- 更新: `src-electron/main.ts`
  - `APP_DATABASE_V1_FILENAME` の直接 join 参照を排除
  - `dbPath = resolveAppDatabasePath(app.getPath("userData"))` に変更
- IPC/Preload/Renderer 契約は変更していない
