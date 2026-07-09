# provider-binary-packaging

## 目的

- installer 環境で provider binary を `node_modules` 解決に依存せず起動できるようにする
- `Codex` と `Copilot` の runtime binary path を `resources/provider-binaries/` 配下へ寄せる

## スコープ

- build 時に provider native package を stage する仕組みを追加する
- runtime 側の binary path 解決を共通 helper へ寄せる
- packaging 設計書と配布確認手順を current 実装へ同期する

## 進め方

1. provider binary の stage 先と解決規約を決める
2. build script / packaging 設定を追加する
3. `Codex` / `Copilot` adapter の path 解決を helper 経由へ切り替える
4. build / dist で確認する
