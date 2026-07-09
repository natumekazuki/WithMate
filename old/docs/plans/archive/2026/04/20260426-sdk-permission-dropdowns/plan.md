# SDK 権限ドロップダウン化計画

## 目的

Approval、Sandbox、Depth の UI を SDK パラメータに近い選択式へ寄せ、Provider ごとに選べる項目を柔軟に切り替えられるようにする。

## スコープ

- Approval UI をラジオボタンからドロップダウンへ変更する
- Codex 用 Sandbox ドロップダウンを追加する
- Codex / Copilot で Approval / Sandbox の候補を分けられる選択肢モデルにする
- Depth は SDK 値の `high` / `xhigh` などをそのまま表示・選択できるようにする
- セッション保存、復元、CodexAdapter への渡し込みを更新する
- 関連テストと必要な Design Doc を更新する

## 完了条件

- 新規セッション作成 UI で Approval / Sandbox / Depth をドロップダウンから選べる
- Provider ごとの候補差分を表現できる
- Codex セッションで選択した sandbox mode が ThreadOptions に反映される
- 既存セッションの読み込みが壊れない
- 関連テストを更新し、実行結果または実行不能理由を記録する

## チェックポイント

1. 既存の設定 UI / セッションモデル / 永続化経路を確認する: 完了
2. 選択肢モデルと型定義を追加・更新する: 完了
3. UI をドロップダウン化し、Codex sandbox を追加する: 完了
4. CodexAdapter と保存処理に反映する: 完了
5. テストと docs/design を更新する: 完了
6. 検証後に archive する: 完了
