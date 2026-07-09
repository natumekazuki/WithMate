# Plan

## Goal

- Skill picker の最小実装方針を WithMate に追加する
- provider ごとの skill root と workspace 配下の skill を一覧化できるようにする
- 選択した skill を provider ごとの形式で composer 先頭へ挿入する

## Scope

- Settings に provider ごとの skill root path を持たせる設計
- workspace skill と provider skill の一覧化
- Session composer の `Skill` dropdown 起動
- skill 選択後の composer 挿入形式

## Out of Scope

- `/skills` 管理 UI の完全再現
- skill 実行可否の検証
- 複数 skill の高度な管理
- `/agent` の実装

## Task List

- [x] Plan を作成する
- [x] skill 探索元の設計を確定する
- [x] Skill picker の最小フローを設計する
- [x] provider ごとの injection 形式を確定する
- [x] 実装対象 docs を更新する

## Affected Files

- `docs/design/skill-command-design.md`
- `docs/design/slash-command-integration.md`
- `docs/design/provider-adapter.md`

## Risks

- skill root の優先順位を曖昧にすると同名 skill で混乱する
- provider ごとの injection 差を隠しすぎると挙動期待がずれる
- 設定保存先を急いで決めると後で migration が必要になる

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/skill-command-design.md`, `docs/design/slash-command-integration.md`, `docs/design/provider-adapter.md`
- メモ: Skill picker 最小実装の探索元と挿入形式を docs に固定する
