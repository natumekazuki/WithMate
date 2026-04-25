# ログ基盤整備 decisions

## 決定

- 初期実装ではクラッシュ調査に直結する `app.*`、`main.*`、`renderer.process-gone`、`child-process.gone`、`webcontents.*`、`renderer.error`、`renderer.unhandled-rejection`、`renderer.did-fail-load`、`ipc.error` に絞る。
- `ipc.request` / `ipc.response`、画面ロード成功、API request / response、外部プロセス標準エラー、config/file 詳細ログは、機密情報とノイズを避けるため初期実装から外す。
- ログ書き込みは Main Process の `AppLogService` に集約し、Renderer 例外は Preload から `withmate:renderer-log` で Main に送る。
- ログフォルダとクラッシュダンプフォルダを Settings から開く導線を追加する。
- `docs/design/app-log-base.md` をログ基盤の current design とする。
