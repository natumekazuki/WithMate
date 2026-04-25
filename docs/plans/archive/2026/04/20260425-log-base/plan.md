# ログ基盤整備 plan

## 目的

Electron アプリのクラッシュ、Renderer/Main Process の例外、IPC 失敗、ロード失敗を JSONL ログとクラッシュダンプで追跡できる基盤を整備する。

## スコープ

- `docs/log-base.md` を精査し、初期実装に必要なログへ整理する。
- ログ基盤の現行仕様を `docs/design/` にまとめる。
- Main Process 集約の JSONL ロガー、Renderer/Preload からのログ送信、Electron ライフサイクル監視を実装する。
- ログフォルダとクラッシュダンプフォルダを開く導線を既存 IPC/API に追加する。
- 既存テストまたは新規テストで主要なロガー動作を検証する。

## 対象外

- 外部サーバーへのクラッシュダンプアップロード。
- API request/response body や IPC payload の詳細記録。
- すべてのドメイン処理への詳細ログ埋め込み。

## チェックポイント

- [x] 現行コードと `docs/log-base.md` の精査
- [x] ログ設計の確定
- [x] Main/Preload/Renderer のログ基盤実装
- [x] 設定 UI または既存導線へのログフォルダ操作追加
- [ ] テストと型検査
- [x] Plan 記録と archive

## Archive Note

`node_modules` が無く `tsc` / `tsx` を実行できないため、テストと型検査は未完了のまま archive する。
