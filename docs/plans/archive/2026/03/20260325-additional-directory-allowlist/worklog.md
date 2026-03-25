# Worklog

- 2026-03-25: plan 作成。session storage、composer 添付解決、snapshot 監視、Session UI の現状を確認した。
- 2026-03-25: `Session.allowedAdditionalDirectories` と `sessions.allowed_additional_directories_json` を追加し、workspace 外 path は許可済み追加ディレクトリ配下だけを添付可能にした。
- 2026-03-25: Codex の `additionalDirectories` を添付自動導出から session metadata 基準へ切り替え、snapshot 監視を `workspacePath + allowedAdditionalDirectories` の複数 root 対応にした。
- 2026-03-25: Session Window `More` drawer に `Additional Directories` 管理 UI を追加し、Codex のときだけ `Remove` を出す形にした。
- 2026-03-25: `node --import tsx scripts/tests/additional-directories.test.ts`、`node --import tsx scripts/tests/session-storage.test.ts`、`node --import tsx scripts/tests/copilot-adapter.test.ts`、`npm run build` で検証した。
- 2026-03-25: `da89b88` `feat(session): add additional directory allowlist`
