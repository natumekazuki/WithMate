# Recent Sessions UI 再検討計画

- 作成日: 2026-03-11
- 対象: `Recent Sessions` の役割整理と UI 再設計

## Goal

`Recent Sessions` を、見た目の飾りではなく実際の再開導線として成立させる。  
横スクロールのようなレイアウト破綻を直すだけでなく、実ユースケースから「一覧で何を見せるべきか」を定義し直す。

## Task List

- [x] `Recent Sessions` の利用ユースケースを整理する
- [x] 一覧項目に必要な情報と不要な情報を決める
- [x] Drawer 内のセッションカード構造を再設計する
- [x] 横スクロールを起こさないレイアウト方針を決める
- [x] React モックへ反映する
- [x] `npm run typecheck` と `npm run build` を実行する

## Affected Files

- `docs/plans/20260311-recent-sessions-ui.md`
- `docs/design/recent-sessions-ui.md`
- `docs/design/ui-react-mock.md`
- `src/App.tsx`
- `src/styles.css`

## Design Check

新しい一覧責務を追加するため、先に `docs/design/recent-sessions-ui.md` を作成する。  
少なくとも以下を整理する。

- `Recent Sessions` のユーザー行動
- セッションカードに必要な情報優先度
- モバイル/狭幅時の縮退方針

## Risks

- 一覧情報を減らしすぎると、どのセッションか区別しにくくなる
- 一覧情報を増やしすぎると、再び横スクロールや視認性低下が起きる
- 要件にある将来の `Characters` / `Settings` 導線との整合を後で取り直す必要がある

## Notes / Logs

- 2026-03-11: 現在の `Recent Sessions` はタイトルと補足文に依存しすぎており、再開判断に必要な情報の優先度が整理されていない。
- 2026-03-11: `PowerShell -> cd -> codex/resume` の実フローと照らし合わせ、Drawer は `codex resume` 前の判断材料を UI 化したものとして整理した。
- 2026-03-11: `docs/design/recent-sessions-ui.md` に TUI 手順との対応表を追記し、`Session Drawer / Header / Work Chat / Character Stream` の役割分担を明文化した。
- 2026-03-11: React モックで `taskTitle / workspace / updatedAt / status / character / threadLabel` を中心としたカードへ置き換え、横スクロールの起点になっていた長文 subtitle を廃止した。
