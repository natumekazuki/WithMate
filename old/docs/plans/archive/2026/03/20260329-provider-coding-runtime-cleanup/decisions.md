# 20260329 Provider Coding Runtime Cleanup Decisions

## 初期判断

- first slice は `SessionRuntimeService` の依存整理に限定する
- `ProviderTurnAdapter` 自体は adapter 実装の合成型として残す
- facade / helper の public surface は、runtime から必要な coding/background 入口だけを露出する
