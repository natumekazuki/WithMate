# Result

## 状態

- 完了

## サマリ

- Copilot session に `Agent` picker を追加し、workspace `.github/agents` と `~/.copilot/agents` の custom agent を選択して session metadata に保存できるようにした
- `CopilotAdapter` で選択値を `customAgents` / `agent` に変換し、provider-native session config へ反映するようにした
- session persistence に `customAgentName` を追加し、再起動後も選択状態を復元できるようにした
- custom agent 探索テスト、session storage テスト、Copilot adapter テスト、build を通した

## コミット

- `3956e99` `feat(copilot): add custom agent selection`

## 次アクション

- archive へ移動し、親 rollout plan へ commit を記録する
