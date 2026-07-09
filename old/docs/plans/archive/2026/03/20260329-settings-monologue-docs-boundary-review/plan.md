# 20260329 Settings Monologue Docs Boundary Review

## 目的

- `settings-ui.md`、`model-catalog.md`、`monologue-provider-policy.md` の役割境界を latest 実装に対して再点検する
- current 正本と supporting の重複を減らし、参照順を明確にする
- `documentation-map.md` を current 状態に合わせて更新する

## スコープ

- `docs/design/settings-ui.md`
- `docs/design/model-catalog.md`
- `docs/design/monologue-provider-policy.md`
- 必要なら `docs/design/documentation-map.md`
- 必要なら関連する current 正本文書への参照整理

## 非スコープ

- provider 実装や settings 実装のコード変更
- 新機能仕様の追加

## 完了条件

1. 3 文書の正本 / supporting の境界が明確になっている
2. current 実装とずれる記述が修正または archive 判断されている
3. `documentation-map.md` の分類が latest 状態に一致している
