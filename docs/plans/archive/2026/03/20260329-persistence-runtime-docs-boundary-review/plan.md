# 20260329 Persistence Runtime Docs Boundary Review

## 目的

- `database-schema.md`、`electron-session-store.md`、`session-run-lifecycle.md`、`electron-window-runtime.md` の current / supporting 境界を latest 実装に合わせて整理する
- 保存構造、runtime orchestration、window runtime detail の責務重複を減らす
- current 実装とずれる段階メモを取り除く

## スコープ

- `docs/design/database-schema.md`
- `docs/design/electron-session-store.md`
- `docs/design/session-run-lifecycle.md`
- `docs/design/electron-window-runtime.md`
- 必要なら `docs/design/documentation-map.md`

## 非スコープ

- 実装コードの変更
- 新しい persistence/runtime 機能仕様の追加

## 完了条件

1. 各文書の責務境界が current 実装に対して明確になっている
2. outdated な段階メモや slice 前提の記述が current wording に置き換わっている
3. `documentation-map.md` が必要なら最新の役割に追従している
