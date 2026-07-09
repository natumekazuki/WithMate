# React モック再構成計画

- 作成日: 2026-03-11
- 対象: `CLI parity` を土台にした `VTuber キャラ前提 UI` への React モック再構成

## Goal

現在の React モックを、`Codex CLI / GitHub Copilot CLI` 相当の coding agent 体験を土台にしながら、
VTuber キャラクターの存在感と `Character Stream` を自然に共存させる方向へ再構成する。

## Task List

- [x] 再構成方針を計画ファイルとして作成する
- [x] `Recent Sessions` を resume picker 前提のカード構造へ作り直す
- [x] `Current Session Header` を TUI parity 前提の情報へ絞り直す
- [x] `Work Chat` を coding agent 本体として読みやすく整理する
- [x] `Character Stream` を VTuber キャラ前提の主面として再構成する
- [x] `styles.css` を新レイアウトと見た目に合わせて整理する
- [x] 関連設計メモを更新する
- [x] `npm run typecheck` と `npm run build` を実行する

## Affected Files

- `docs/plans/20260311-ui-recompose.md`
- `docs/design/ui-react-mock.md`
- `docs/design/recent-sessions-ui.md`
- `docs/design/product-direction.md`
- `src/App.tsx`
- `src/styles.css`

## Design Check

既存の `docs/design/product-direction.md` と `docs/design/ui-react-mock.md` を正本として扱い、
今回の実装ではそれをモックに反映する。

特に以下を満たす。

- `Session Drawer` は `codex resume` picker 相当
- `Work Chat` は作業本体面
- `Character Stream` は WithMate 固有価値
- VTuber キャラ前提の存在感を UI に反映する

## Risks

- キャラ性を前面に出しすぎると作業可読性が落ちる
- TUI parity を意識しすぎると GUI としての魅力が減る
- レイアウトを一度に変えすぎると、どこが効いたか判断しにくくなる

## Notes / Logs

- 2026-03-11: ユーザー方針として、WithMate の本質は `TUI の coding agent 体験 + 安定したキャラクターロールプレイ + Character Stream` と定義した。
- 2026-03-11: UI は `VTuber っぽい装飾` の追加ではなく、`VTuber キャラがそこにいる感じを保ちながら作業しやすいこと` を優先する。
- 2026-03-11: React モックを `Resume Picker / Current Session Header / Work Chat / On-Air Stream` の4面に整理し、一覧・作業面・独り言面の責務を分離した。
- 2026-03-11: `npm run typecheck` と `npm run build` は成功した。
