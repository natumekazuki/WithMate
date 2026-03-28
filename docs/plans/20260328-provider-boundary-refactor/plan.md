# 20260328 Provider Boundary Refactor

## 目的

- coding plane と background plane の provider 実行境界を整理する
- adapter ごとの責務を `turn / session-memory / character-reflection` の実行面で読みやすくする
- `provider-runtime.ts` の interface と adapter 実装の対応関係を明確にする

## スコープ

- `src-electron/provider-runtime.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/copilot-adapter.ts`
- `src-electron/memory-orchestration-service.ts`
- 関連 test と `docs/design/refactor-roadmap.md`

## 非スコープ

- prompt 内容の仕様変更
- model / reasoning 設定 UI の変更
- provider 追加

## 完了条件

1. provider 実行の責務境界が first slice で 1 段整理されている
2. adapter 実装と runtime interface の対応が現在より読みやすくなっている
3. 関連 test と build が通る
