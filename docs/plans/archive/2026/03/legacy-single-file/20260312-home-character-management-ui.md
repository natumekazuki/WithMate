# 20260312 Home Character Management UI

- 作成日: 2026-03-12
- 対象: `Home Window` にキャラクター追加・編集・削除導線を組み込む再設計

## Goal

`Home Window` を `resume picker` だけの面ではなく、
`session resume` と `character management` の両方を担う管理面として再設計する。
ただし、ラベルや説明文を増やすのではなく、必要な操作だけで成立する最小 UI を維持する。

## Design Check

- `docs/design/product-direction.md`
  - `Home Window` の責務を `resume + character management` に更新する必要がある
- `docs/design/ui-react-mock.md`
  - Home 側の target layout と interaction notes を更新する必要がある
- `docs/design/recent-sessions-ui.md`
  - `Recent Sessions` の役割自体は維持しつつ、Home の他要素との並びを再整理する
- 新規 design doc が必要
  - `docs/design/character-management-ui.md`
  - `Character Editor Window` 前提で追加 / 編集 / 削除導線を定義する

## Task List

- [x] `Home Window` の責務を `resume` と `character management` の二系統で整理する
- [x] `docs/design/character-management-ui.md` を新規作成する
- [x] Home の面構成案を決める
- [x] `Recent Sessions` と `Character Management` の優先順位と配置を決める
- [x] `character` 一覧に必要な操作 (`add / edit / delete`) の最小導線を決める
- [x] `New Session` と `character management` の関係を整理する
- [x] React モックへ反映する
- [x] 関連 design docs を更新する
- [x] `npm run typecheck` と `npm run build` で確認する

## Affected Files

- `src/HomeApp.tsx`
- `src/styles.css`
- `docs/design/product-direction.md`
- `docs/design/ui-react-mock.md`
- `docs/design/recent-sessions-ui.md`
- `docs/design/character-management-ui.md`
- `docs/plans/20260312-home-character-management-ui.md`

## Risks

- `Recent Sessions` と `character management` を同じ面に置くと、再び情報過多になる可能性がある
- `add / edit / delete` を常設しすぎると、Home の主目的がぼやける可能性がある
- `character` 一覧を常設に戻すと、Session 側と同じく冗長になりやすい
- `character` 編集導線の粒度を誤ると、モックの段階で過剰な管理 UI になる可能性がある

## Notes / Logs

- 現状の Home は `Recent Sessions` と `New Session` に絞りすぎていて、character 管理導線が存在しない
- 一方で、以前の `Character Catalog` 常設は情報過多だった
- 次は `character 管理は必要だが、常設情報は最小限` という折衷案を作る必要がある
