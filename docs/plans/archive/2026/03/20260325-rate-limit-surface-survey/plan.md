# 20260325 rate-limit-surface-survey

## Goal

- Issue `#11 レートリミット可視化` に着手できるか判断するため、Codex / Copilot の rate limit 取得 surface を整理する
- SDK / current adapter / 公式 docs のどこまでで残量や上限を取得できるかを切り分ける

## Scope

- local install 済み SDK 型と current adapter 実装の確認
- official docs / reference の補助確認
- UI に出せる最小単位の整理

## Out Of Scope

- 実装
- 推定値ベースの独自 rate limit 算出
- Character / Memory 系の設計

## Steps

1. current adapter と local SDK から rate limit 関連の event / field / RPC を調べる
2. Codex と Copilot それぞれの official docs で補助確認する
3. 可視化できる最小 UI 単位と blockers を整理する
