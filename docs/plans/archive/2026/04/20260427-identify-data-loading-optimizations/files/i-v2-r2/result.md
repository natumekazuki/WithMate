# 実行結果: i-v2-r2

- スライス: `V2 runtime read-path`
- TDDフェーズ: red
- 実装対象: `scripts/tests/session-storage-v2-read.test.ts`

## 期待される赤状態

- `src-electron/session-storage-v2-read.ts` が未作成のため、テスト実行は失敗する。
- 代表的な失敗:
  - コマンド: `npx tsx --test scripts/tests/session-storage-v2-read.test.ts`
  - 想定エラー: `Cannot find module '../../src-electron/session-storage-v2-read.js'`
