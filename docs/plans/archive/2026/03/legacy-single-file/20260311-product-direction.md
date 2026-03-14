# WithMate プロダクト方針整理計画

- 作成日: 2026-03-11
- 対象: `TUI parity` と `VTuber キャラクター前提 UI` の方針整理

## Goal

WithMate が何を再現し、どこを独自価値として拡張するのかを明文化する。  
`Codex CLI / GitHub Copilot CLI` 相当の開発体験を前提にしつつ、安定したキャラクターロールプレイと独り言システムをどう重ねるかを整理する。

## Task List

- [x] プロダクトの主従関係を言語化する
- [x] `CLI parity` と `WithMate 固有拡張` を分離して整理する
- [x] `VTuber キャラ前提 UI` の設計原則を明文化する
- [x] 既存 UI モック設計との接続点を整理する

## Affected Files

- `docs/plans/20260311-product-direction.md`
- `docs/design/product-direction.md`
- `docs/design/ui-react-mock.md`

## Design Check

プロダクト全体の主従関係を決める変更なので、`docs/design/product-direction.md` を先に作成する。  
ここでは以下を明文化する。

- ベース体験として守るべき `CLI parity`
- WithMate 固有価値として追加するもの
- VTuber キャラクター前提 UI の方向性
- UI で削ってよいものと残すべきもの

## Risks

- キャラ性を前面に出しすぎると、本来の coding agent 体験を損ねる
- CLI parity を優先しすぎると、WithMate 固有価値が薄くなる
- UI の見た目だけ VTuber らしくしても、体験の一貫性が伴わない可能性がある

## Notes / Logs

- 2026-03-11: ユーザー方針として、WithMate の本質は `TUI の coding agent 体験 + 安定したキャラクターロールプレイ + Character Stream` の三層構造であると整理した。
