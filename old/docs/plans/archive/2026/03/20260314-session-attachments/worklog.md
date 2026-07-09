# Worklog

## Timeline

### 0001

- 日時: 2026-03-14 23:35
- チェックポイント: Plan 初期化
- 実施内容: `docs/plans/20260314-session-attachments/` を作成し、goal/scope/task を整理した
- 検証: なし
- メモ: SDK 仕様上、画像と通常ファイルを分けて扱う必要がある
- 関連コミット: 

### 0002

- 日時: 2026-03-14 23:55
- チェックポイント: 添付実装
- 実施内容: Session composer に picker / `@path` の添付導線を追加し、Main Process で file/folder/image を正規化する実装を入れた
- 検証: `npm run typecheck`, `npm run build`
- メモ: 画像は structured input、通常ファイルとフォルダは prompt 参照 + `additionalDirectories` に分けた
- 関連コミット: 

## Open Items

- `@path` の入力補助 UI はまだ最小構成
- 添付だけで送信する挙動は未対応
