# WithMate Rebuild Documentation

WithMate は完全に 0 ベースで作り直す。

現行資源は `old/` に退避済み。新バージョンの設計・実装判断は、この `docs/` 配下を起点に整理する。

## Documents

| Document | Purpose |
| --- | --- |
| `docs/feature-inventory.md` | 現行機能の棚卸しと、新バージョンへ残すかどうかの初期判断 |
| `docs/unresolved-issues.md` | GitHub Issues と Notion Issue DB から拾った未完了項目 |
| `docs/issue-triage.md` | GitHub / Notion Issue を新バージョンへ引き継ぐか捨てるかの判断記録 |

## Current Policy

- 現行コード・既存 docs・設定・生成物・依存関係は `old/` に保存する。
- 新実装は root 直下へ改めて作る。
- 既存機能は無条件に移植せず、`feature-inventory.md` の判断を見直してから採用する。
- Issue は `unresolved-issues.md` を起点に、新バージョンの backlog へ再分類する。
