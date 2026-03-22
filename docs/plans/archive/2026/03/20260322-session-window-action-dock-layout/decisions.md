# Decisions

## Summary

- SessionWindow の body は `main split + action dock` の 2 段構成にする
- 右 pane は `Activity Monitor` / `Turn Inspector` の分割をやめ、`Latest Command` 1 件だけを表示する
- `Latest Command` は実行中なら live step、待機中なら直近 terminal Audit Log から復元する
- `Character Stream` は本 task では未実装とし、right pane の idle placeholder host に留める
- `docs/design/desktop-ui.md`、`docs/design/session-live-activity-monitor.md`、`docs/design/session-window-layout-redesign.md`、`docs/manual-test-checklist.md` を同期対象にする
- `.ai_context/` と `README.md` は更新しない。理由は provider / storage / 公開仕様ではなく SessionWindow の表示面再配置に留まるため
