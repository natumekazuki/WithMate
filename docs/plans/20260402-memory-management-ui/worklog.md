# 20260402-memory-management-ui Worklog

## 2026-04-02

- repo plan を作成
- Settings Window 統合方針と snapshot 取得方針を確定
- `Session / Project / Character Memory` の snapshot を返す `MemoryManagementService` を追加
- storage に list / delete API を追加し、`Project / Character Memory` は最後の entry 削除時に空 scope も掃除するよう更新
- preload / IPC / window API に Memory 管理用 channel を追加
- `Settings Window` に `Memory 管理` セクションを追加し、一覧・reload・delete を実装
- `docs/design/desktop-ui.md` `docs/design/memory-architecture.md` `docs/manual-test-checklist.md` `docs/task-backlog.md` を同期
- `.ai_context/` と `README.md` は今回の変更では更新不要と判断
