# ログ基盤整備 result

## 状態

実装済み、検証未完了のまま archive。

## 結果

- ログ基盤の設計を `docs/design/app-log-base.md` に追加した。
- `docs/log-base.md` を初期実装スコープに合わせて整理した。
- README に `docs/design/app-log-base.md` と Settings `Diagnostics` の導線を追加した。
- Main Process 集約の JSONL ロガーとローテーションを追加した。
- Electron crashReporter、Main/Renderer 例外、Renderer / child process 終了、WebContents unresponsive/responsive、ロード失敗、IPC 失敗を記録する結線を追加した。
- Settings からログフォルダとクラッシュダンプフォルダを開く導線を追加した。

## 検証

- `npm run typecheck`: 未完了。`node_modules` が無く `tsc` が見つからない。
- `npm test -- scripts/tests/app-log-service.test.ts scripts/tests/preload-api.test.ts scripts/tests/main-ipc-registration.test.ts`: 未完了。`node_modules` が無く `tsx` が見つからない。

## コミット

- 未作成。
