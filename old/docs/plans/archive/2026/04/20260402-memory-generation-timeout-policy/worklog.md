# Worklog

## 2026-04-02

- repo plan を作成
- issue #35 と current timeout 実装の調査を開始
- Copilot background plane に `sendAndWait(..., 60_000)` の固定 timeout があること、Codex 側は `Thread.run(..., { signal })` で timeout 注入可能なことを確認
- provider settings に `Memory Extraction timeoutSeconds` と `Character Reflection timeoutSeconds` を追加し、default `180s` / normalize `30..1800s` を実装
- `Home Settings` に provider ごとの `Timeout Seconds` 入力を追加し、storage / draft / view model / app settings persistence を更新
- `MemoryOrchestrationService` から adapter へ `timeoutMs` を渡し、Codex は `AbortSignal.timeout`、Copilot は `sendAndWait(timeout)` に接続
- `provider-settings-state` `session-memory-extraction` `character-reflection` `home-settings-draft` `home-settings-view-model` `settings-ui` `app-settings-storage` `model-catalog-settings` `memory-orchestration-service` の回帰 test と `npm run build` を実行
- `docs/design/settings-ui.md` `docs/design/memory-architecture.md` `docs/design/monologue-provider-policy.md` `docs/design/audit-log.md` `docs/design/database-schema.md` `docs/manual-test-checklist.md` `docs/task-backlog.md` を同期
- `.ai_context/` と `README.md` は今回の設定追加では更新不要と判断
- コミット `c6d327a` `fix(settings): memory generation timeout を設定可能にする`
- コミット `aa05aec` `docs(plan): archive memory generation timeout policy`
