# 20260328 Provider Adapter Internal Refactor

## 目的

- `codex-adapter.ts` と `copilot-adapter.ts` の内部で、coding plane と background plane の実装境界を読みやすくする
- `ProviderCodingAdapter` / `ProviderBackgroundAdapter` の型分離に対応する内部 helper を整理する
- 今後 adapter を分割するか判断しやすい構造まで寄せる

## スコープ

- `src-electron/codex-adapter.ts`
- `src-electron/copilot-adapter.ts`
- 関連 test
- `docs/design/refactor-roadmap.md`

## 非スコープ

- provider の外部挙動変更
- prompt 内容の変更
- provider class の別ファイル完全分割

## 完了条件

1. adapter 内で coding plane と background plane の helper 境界が current より読みやすくなっている
2. `runSessionTurn` と background 実行が別 helper 群へ整理されている
3. 関連 test と build が通る
