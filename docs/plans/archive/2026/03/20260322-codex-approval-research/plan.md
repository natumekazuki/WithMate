# Plan

## Goal

- 次候補タスクを backlog として文書化する
- Codex SDK における `Approval` の挙動を、公式ドキュメントを主軸にユーザー記事も補助しながら調査する
- GitHub Copilot SDK / CLI における承認挙動も調査し、Codex と同じ UI に寄せるための比較観点を整理する
- WithMate に必要な判断軸として、`on-request` なのに実行されるように見える理由と、`/` コマンド対応論点を整理する

## Scope

- 次タスク候補の backlog 追加
- Codex SDK / Codex CLI の approval 関連仕様調査
- GitHub Copilot SDK / Copilot CLI の approval 関連仕様調査
- `Approval` と slash command (`/`) の論点整理
- 調査結果の docs 化

## Out of Scope

- 実装修正
- provider adapter のコード変更
- Copilot CLI SDK 自体の詳細調査

## Task List

- [x] Plan を作成する
- [x] backlog を残す文書の置き場所を決めて更新する
- [x] 公式ドキュメントから approval 仕様を調査する
- [x] Qiita / Zenn などのユーザー記事から実運用上の解釈を補足する
- [x] WithMate 観点の論点として `on-request` 挙動と `/` コマンド対応を整理する
- [x] 調査メモを docs として保存する
- [x] GitHub Copilot SDK / CLI の approval 挙動を追記する
- [x] Codex と Copilot の UI 共通化方針を追記する

## Affected Files

- `docs/design/product-direction.md`
- `docs/design/provider-adapter.md`
- `docs/design/codex-approval-research.md`

## Risks

- CLI と SDK の仕様差を混同すると誤解が残る
- ユーザー記事は鮮度や正確性が揺れるため、必ず公式を主根拠にする必要がある
- `Approval` は runtime / tool call / shell 実行のどこに適用されるかを分けて書かないと曖昧になる

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/product-direction.md`, `docs/design/provider-adapter.md`
- メモ: backlog と SDK 調査結果は設計判断の前提として docs に残す
