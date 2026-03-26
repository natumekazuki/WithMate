# Worklog

- 2026-03-26: plan 作成。実 DB の `app_settings` を確認し、保存値自体は残っているため、Settings Window の初期描画を優先修正する。
- 2026-03-26: `HomeApp` の settings mode に `appSettingsLoaded` / `modelCatalogLoaded` を追加し、両方そろうまでは loading state を表示するようにした。
- 2026-03-26: `npm run build` を通し、初期描画の default flash を避ける方針を manual test に反映した。
- 2026-03-26: Memory Extraction 設定の一時的な chip UI を外し、Session と同じ native dropdown に戻した。Settings 側にも `select` の共通スタイルを追加した。
- 2026-03-26: `npm run build` を再実行し、Settings Window の loading 修正と dropdown 差し戻しが両立することを確認した。
