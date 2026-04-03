# 20260404 Settings Save And Memory Delete

## 目的

- `Settings Window` で `Save Settings` が見えなくなったレイアウト崩れを直す
- `Memory 管理` で削除した `Session Memory` が再起動後に復活しないようにする

## 対応方針

1. settings 専用 shell の grid 行構成を `本文 / footer` に合わせる
2. 起動時の session dependency 同期で、削除済み `Session Memory` を再生成しないようにする
3. 既存 test と build で回帰確認する

## 予定ファイル

- `src/styles.css`
- `src-electron/main.ts`
- `src-electron/session-memory-support-service.ts`
- `scripts/tests/session-memory-support-service.test.ts`
