# 20260329 Provider Docs Final Review

## 目的

- provider / capability / telemetry 系の current docs を latest 実装に対して再点検する
- `provider-adapter.md`、capability matrix、telemetry doc の役割重複を減らす
- current 正本と supporting doc の境界を `documentation-map.md` に反映できる状態にする

## スコープ

- `docs/design/provider-adapter.md`
- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/codex-capability-matrix.md`
- `docs/design/provider-usage-telemetry.md`
- 必要なら `docs/design/documentation-map.md`

## 非スコープ

- provider 実装のコード変更
- 新しい capability の追加設計

## 完了条件

1. provider 系 docs の current 正本と supporting の境界が明確になっている
2. current 実装とずれている説明が修正または archive 判断されている
3. `documentation-map.md` の provider 系分類が latest 状態に一致している
