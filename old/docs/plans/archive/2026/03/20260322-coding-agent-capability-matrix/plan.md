# Plan

## Goal

- wrapper 観点で coding agent capability を一覧化する正本 doc を作る
- `Codex` と `GitHub Copilot CLI` の native support と、WithMate current 実装を同じ表で追えるようにする
- 今後の実装 task がこの doc を更新起点にできる状態にする

## Scope

- current provider / approval / slash / skill docs の整理
- cross-provider capability matrix doc の新規作成
- 関連 doc からの参照追加

## Out Of Scope

- provider 実装変更
- runtime 検証
- manual test

## Task List

- [x] Plan を作成する
- [x] cross-provider matrix に必要な capability 行を定義する
- [x] `docs/design/coding-agent-capability-matrix.md` を作成する
- [x] 関連 docs から参照を追加する
- [x] 更新ルールを doc に明記する
- [x] plan 記録を更新する

## Affected Files

- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/codex-capability-matrix.md`
- `docs/design/provider-adapter.md`
- `README.md`

## Risks

- provider native support と wrapper 実装状況を混ぜると表の意味が崩れる
- Copilot 側は未確認項目がまだ多く、無理に埋めると誤記になる

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/provider-adapter.md`
- メモ: Codex 固有棚卸しの上に cross-provider の正本表を追加する
