# Progress

- 調査対象: `main` の DB 起動/OPEN パス、session/audit 読み取り API、renderer 期待値、既存テスト影響点を確認。
- 結論: 次スライスは「V2 DB 選択 + session/audit read-path の差し替え」に限定し、write/update や再設計は次スライスへ分離。
- 変更対象（調査対象）: `src-electron/main.ts`, `src-electron/main-query-service.ts`, `src-electron/session-storage.ts`, `src-electron/audit-log-storage.ts`, `src-electron/main-ipc-registration.ts`, `src-electron/preload-api.ts`, `src/withmate-window-api.ts`, `src/withmate-ipc-channels.ts`, `src/HomeApp.tsx`, `src/App.tsx`, 関連テスト群。
