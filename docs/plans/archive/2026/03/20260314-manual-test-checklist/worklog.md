# Worklog

## Timeline

### 0001

- 日時: 2026-03-14
- チェックポイント: 現行仕様の棚卸し
- 実施内容:
  - `docs/design/desktop-ui.md`
  - `docs/design/window-architecture.md`
  - `docs/design/settings-ui.md`
  - `docs/design/model-catalog.md`
  - `docs/design/session-persistence.md`
  - `docs/design/session-run-lifecycle.md`
  - `src/HomeApp.tsx`
  - `src/App.tsx`
  - `src/CharacterEditorApp.tsx`
  - `src/DiffViewer.tsx`
  を確認し、実装済み機能を洗い出した
- 検証: 文書と renderer 実装の対応が取れていることを確認
- メモ: browser fallback は撤去済みで、実機テスト対象は Electron 実行のみ
- 関連コミット:

### 0002

- 日時: 2026-03-14
- チェックポイント: 実機テスト項目表と更新ポリシーの追加
- 実施内容:
  - `docs/manual-test-checklist.md` を新規作成
  - `docs/design/manual-test-checklist.md` を新規作成
  - `docs/adr/001-manual-test-checklist-policy.md` を新規作成
  - `README.md`、`desktop-ui.md`、`window-architecture.md` に導線を追加
- 検証:
  - 文書リンクが成立すること
  - 実装済み機能がチェックリストに反映されていること
- メモ: コード変更はなく、docs 更新のみ
- 関連コミット:

## Open Items

- なし
