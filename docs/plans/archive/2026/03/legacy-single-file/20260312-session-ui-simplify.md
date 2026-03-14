# 20260312-session-ui-simplify

## Goal

`Session Window` の UI を情報価値ベースで整理し直す。
`Current Session` は最小限の確認情報だけに縮小し、
`Character Stream` はキャラクターの発話そのものだけを価値として見せる面へ再構成する。

## Design Check

- [x] `docs/design/ui-react-mock.md` を更新する
- [x] `docs/design/product-direction.md` と矛盾しないことを確認する
- [x] `docs/design/character-chat-ui.md` に影響があるか確認する

## Task List

- [x] `Session Window` の情報優先度を整理して設計へ反映する
- [x] `Current Session` ヘッダーを縮小し、確認情報を最小限にする
- [x] `Character Stream` からメタ情報カードを外し、発話中心の面へ再構成する
- [x] `Work Chat` と `Character Stream` の面積配分を再調整する
- [x] 必要なら CSS を整理して、視線の主従を再構成する
- [x] `npm run typecheck` と `npm run build` で確認する

## Notes / Logs

- `Current Session` は大きい情報カードをやめて、task title + 最小限の条件だけを出す帯へ縮小した
- `Character Stream` は pinned card / roleplay card / mood badge を外して、発話だけを読む面へ整理した
- `npm run typecheck` と `npm run build` は通過済み

## Affected Files

- `docs/design/ui-react-mock.md`
- `docs/design/product-direction.md`
- `docs/design/character-chat-ui.md`
- `docs/plans/20260312-session-ui-simplify.md`
- `src/App.tsx`
- `src/styles.css`

## Risks

- `Current Session` を削りすぎると workspace / approval の確認導線が消える
- `Character Stream` の情報を落としすぎると、セッションとのつながりが弱く見える
- レイアウト比率を動かすので、Diff Viewer や chat の可読性に副作用が出やすい

## Notes / Logs

- ユーザー観点では、`Current Session` の大きい情報塊は価値が薄い
- `Character Stream` は「純粋にキャラがしゃべってること」だけに寄せたい
