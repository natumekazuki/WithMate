# 実行結果: i-v2-r1

- スライス: `V2 runtime read-path`
- TDDフェーズ: `red`
- 目的: `resolveAppDatabasePath` の振る舞いを表現する失敗テストの追加

## 変更点

- 追加: `scripts/tests/app-database-path.test.ts`
  - V2 優先、V1 fallback、同時存在時優先順位、初回起動時の fallback 挙動を検証
  - 初回起動時に migration 相当の副作用（DB 生成）が発生していないことを確認するテストを追加

## 期待される赤状態

- 事前状態では `src-electron/app-database-path.ts` が未作成のため、テスト実行は失敗する。
- 代表的な失敗:
  - コマンド: `npx tsx --test scripts/tests/app-database-path.test.ts`
  - エラー: `Cannot find module '../../src-electron/app-database-path.js'`
