# Worklog

## Timeline

### 0001

- 日時: 2026-03-22
- チェックポイント: Design 作成
- 実施内容:
  - pending bubble と live run step の競合点を整理した
  - Session Window に `Activity Monitor` を dock する構成を設計した
  - `desktop-ui` へ責務分離の方針を同期した
- 検証: 文書設計のみのため未実施
- メモ:
  - live data source は既存 `liveRun.assistantText / liveRun.steps` を維持する
  - 実装時は Renderer 側の責務変更で済ませる前提
- 関連コミット: なし

## Open Items

- 実装時に `Activity Monitor` の初期高さと resize 要否を確定する
- `failed / canceled` 終了後の monitor close timing を実装で再確認する
