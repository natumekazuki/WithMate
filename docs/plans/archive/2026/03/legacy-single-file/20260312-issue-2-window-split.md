# Issue 2 Window Split Plan

- 作成日: 2026-03-12
- 対象 Issue: `#2 Homeとセッションは別ウインドウにする`
- 参照: `https://github.com/natumekazuki/WithMate/issues/2`

## Goal

Issue #2 を現在の単一ウインドウ前提の UI 方針から切り替え、
`Home Window` と `Session Window` を別責務で設計し直す。
特に、Home をセッションとキャラクター管理に絞り、実作業面は別 window に分離する構成を定義する。

## Current Findings

- 現在の React モックは `Session Drawer + Work Chat + Character Stream` を 1 画面に持つ前提で設計されている
- Issue #2 は `Home はセッションとキャラクターの管理に絞る / セッションを開いたら別ウインドウとして新規作成` を求めている
- つまり `resume picker` と `coding agent 実行面` を同じ window に置く前提を見直す必要がある
- `Character Stream` は session 側の価値なので、Home ではなく Session Window に属する

## Task List

- [x] Home Window と Session Window の責務を分離して定義する
- [x] 既存 docs の単一ウインドウ前提と衝突する箇所を洗い出す
- [x] `Recent Sessions` を Home 側へ移す場合の役割を再定義する
- [x] `New Session Launch` の配置と起動後の window 遷移を整理する
- [x] Session Window に残す UI 要素を確定する
- [x] 新しい window 分離方針を docs に反映する

## Affected Files

- `docs/design/product-direction.md`
- `docs/design/recent-sessions-ui.md`
- `docs/design/session-launch-ui.md`
- `docs/design/ui-react-mock.md`
- `docs/design/window-architecture.md` (new)
- `docs/plans/20260312-issue-2-window-split.md`

## Design Check

- 新しい Design Doc が必要
- 理由: window 単位の責務、起動フロー、Home / Session 間のデータ受け渡しを固定する必要があるため
- 追加対象: `docs/design/window-architecture.md`

## Risks

- 現在の UI docs は単一 window 前提なので、修正範囲が広い
- Home と Session の責務を曖昧にすると、結局情報を二重表示するだけになりやすい
- Electron 実装では multi-window lifecycle と state synchronization が追加で必要になる
- Session を別 window にすると、resume / launch / close 時の UX を明確にしないと迷いやすい

## Proposed Direction

- `Home Window`
  - session 一覧
  - character 一覧 / 管理
  - 新規 session launch
- `Session Window`
  - Work Chat
  - Artifact Summary
  - Character Stream
  - Diff Viewer
- セッション開始または再開時に Session Window を新規作成する
- Home は管理面、Session は作業面として明確に分離する

## Notes / Logs

- Issue #2 は UI の見た目だけでなく、Electron の window lifecycle 設計にも影響する
- 現在の `Recent Sessions = resume picker` という考え方自体は維持できるが、配置先は Home に移る
- `Character Stream` は Home には置かず、Session Window 側に残すのが自然
- `docs/design/window-architecture.md` を新規追加し、Home / Session の責務、launch / resume flow、window lifecycle を固定した
- `product-direction`, `recent-sessions-ui`, `session-launch-ui`, `ui-react-mock` を 2-window 前提へ更新した
- 現在の React 実装はまだ単一 window mock のため、実装と設計の差分が残っていることを `ui-react-mock.md` に明記した
