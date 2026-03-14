# 20260312 Home Minimal UI Pass

- 作成日: 2026-03-12
- 対象: `Home Window` モックの情報削減と最小 UI 化

## Goal

`Session Window` と同じ基準で `Home Window` を見直し、
ユーザーの操作や直近判断に必須でないラベル、説明文、状態表示を削る。
`Home Window` は `resume picker` と `new session launch` の面として必要最小限に絞る。

## Design Check

- `docs/design/product-direction.md`
  - 既存の「役割が自明ならラベルを出さない」方針と整合することを確認する
- `docs/design/recent-sessions-ui.md`
  - `Recent Sessions` を `codex resume` 代替の判断面として維持する
- `docs/design/ui-react-mock.md`
  - Home 側の現状説明を最小 UI 前提へ更新する

## Task List

- [x] `Home Window` の表示要素を `必須 / 補助 / 不要` に分類する
- [x] 上部ヘッダーから役割説明ラベルと補助文を削り、必要な操作だけ残す
- [x] `Mock Status / Window Routing` カードを削除するか、必須情報だけに縮退する
- [x] `Recent Sessions` の見出しとカード内メタ情報を最小化する
- [x] `Character Catalog` の常設表示を見直し、必要なら非表示または縮退する
- [x] `New Session` ダイアログから冗長な見出し、補助文、要約表示を削る
- [x] `src/styles.css` を最小 UI に合わせて整理する
- [x] 関連 design docs を更新する
- [x] `npm run typecheck` と `npm run build` で確認する

## Affected Files

- `src/HomeApp.tsx`
- `src/styles.css`
- `docs/design/product-direction.md`
- `docs/design/recent-sessions-ui.md`
- `docs/design/ui-react-mock.md`
- `docs/plans/20260312-home-minimal-ui-pass.md`

## Risks

- 削りすぎると `Recent Sessions` の再開判断に必要な情報まで失う可能性がある
- `New Session` ダイアログの説明を落としすぎると、初見で操作順が分かりにくくなる可能性がある
- `Character Catalog` を常設から外す場合、キャラ選択導線を launch dialog 側で補えることを確認する必要がある

## Notes / Logs

- 現状の `Home Window` には `Home Window` / `WithMate Session Manager` / `Mock Status` / `Window Routing` など、
  役割を説明するためだけのラベルが残っていた
- `Recent Sessions` は `codex resume` 相当の判断面なので、削る対象でもカード情報の優先度整理は必要だった
- `Character Catalog` は常設である必然性が弱く、今回の削減対象とした
- `Mock Status / Window Routing` は完全に削除した
- `Character Catalog` は Home 常設から外し、launch dialog 側の character 選択に寄せた
- `Recent Sessions` は見出しを消し、カード内は `taskTitle / status / workspace / updatedAt / taskSummary` へ縮退した
- `New Session` dialog は `Browse` / workspace / character / approval / start のみ残した
