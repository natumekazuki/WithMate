# Plan

## Goal

- Session 実行の監査目的で使える永続ログを追加する
- 送信プロンプト、Codex のレスポンス、実行中に発生した操作内容を後から精査できるようにする
- Session Window から監査ログを閲覧できるようにする

## Scope

- SQLite backed の audit log storage 追加
- Codex 実行経路での監査ログ記録
- Session Window の audit log overlay 追加
- 関連 Design Doc / README / 実機テスト項目表の更新

## Task List

- [x] 監査ログの保存モデルを設計する
- [x] SQLite storage と Main Process API を実装する
- [x] Codex 実行結果から監査ログを生成する
- [x] Session Window に audit log viewer を追加する
- [x] docs を同期して検証する

## Affected Files

- `src/app-state.ts`
- `src/App.tsx`
- `src/styles.css`
- `src/withmate-window.ts`
- `src-electron/main.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/session-storage.ts`
- `src-electron/audit-log-storage.ts`
- `docs/design/provider-adapter.md`
- `docs/design/electron-session-store.md`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
- `README.md`

## Risks

- 監査ログに必要な情報が足りないと、後から精査に使えない
- raw items の保存が雑だと、SQLite サイズや UI 可読性の両方で問題になる
- Session 実行失敗時に started log だけ残って completed / failed log が欠けると監査ログとして不整合になる

## Design Doc Check

- 状態: 確認済み
- 対象候補:
  - `docs/design/provider-adapter.md`
  - `docs/design/electron-session-store.md`
  - `docs/design/desktop-ui.md`
  - `docs/design/session-persistence.md`
  - `docs/design/window-architecture.md`
- メモ:
  - provider 実行境界と SQLite store の両方に監査ログ責務を追記する
