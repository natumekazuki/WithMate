# 20260312-session-minimal-ui-pass

## Goal

`Session Window` 全体を `必要な情報だけ残す` という原則で再整理する。
冗長な見出し、要素名ラベル、重複する状態表示を削り、
`Work Chat` `Character Stream` `Diff Viewer` の価値が直接見える構成へ寄せる。

## Design Check

- [x] `docs/design/product-direction.md` を更新する
- [x] `docs/design/ui-react-mock.md` を更新する
- [x] `docs/design/character-chat-ui.md` への影響有無を確認する

## Task List

- [x] `Session Window` 内の表示要素を「必須 / 補助 / 不要」に棚卸しする
- [x] `session-window-bar` のタイトルとラベルを最小化する
- [x] `Current Session Header` をさらに圧縮し、残す情報を再定義する
- [x] `Work Chat` の見出し、status chip、composer 補助文の要否を見直す
- [x] `Character Stream` の残存ラベルを削り、発話面としてさらに単純化する
- [x] `Artifact Summary` まわりの見出しや補助文も同じ原則で点検する
- [x] CSS を整理して、削除後の余白と密度を詰める
- [x] `npm run typecheck` と `npm run build` で確認する

## Affected Files

- `docs/design/product-direction.md`
- `docs/design/ui-react-mock.md`
- `docs/design/character-chat-ui.md`
- `docs/plans/20260312-session-minimal-ui-pass.md`
- `src/App.tsx`
- `src/styles.css`

## Risks

- 削りすぎると `run state` や `approval` の確認導線まで消える
- `Artifact Summary` の説明不足で、何を開閉しているか分かりにくくなる
- 情報密度を下げた結果、逆に空白が増えて間延びする可能性がある

## Notes / Logs

- 現時点でユーザー判断として、要素名ラベルの表示自体が不要寄り
- `Character Stream` だけでなく、`Work Chat` など他の面も同じ思想で見直す
- 原則として、ラベルはすべて削除候補とし、`操作に必須` または `直近の判断に必須` な情報だけ残す
- `Current Session Header` はこのパスで完全に削除した
- `Work Chat` / `Character Stream` / `Artifact Summary` の見出し系ラベルも大半を削除した
- `npm run typecheck` と `npm run build` は通過済み
