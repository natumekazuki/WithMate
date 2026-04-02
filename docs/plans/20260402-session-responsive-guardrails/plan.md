# session-responsive-guardrails plan

## 目的

- `docs/reviews/review-20260329-1438.md` の `#8 ウィンドウ最小サイズが大きすぎる` と `#9 Composer 添付ファイルのオーバーフロー` を解消する
- `Session Window` と `Diff Window` が狭い画面や分割表示でも破綻しない下限を整える
- `Action Dock` の添付 chip が多い時も送信導線を押し流さない guardrail を入れる

## 対象

- `src-electron/window-defaults.ts`
- `src-electron/main.ts`
- `src-electron/aux-window-service.ts`
- `src/styles.css`
- 必要なら `src/DiffViewer.tsx` または `src/session-components.tsx`
- `docs/design/desktop-ui.md`
- `docs/design/window-architecture.md`
- `docs/manual-test-checklist.md`
- `docs/task-backlog.md`

## 変更方針

1. `Home Window` / `Session Window` / `Diff Window` の最小サイズを current layout が耐えられる範囲まで下げる
2. `Session Window` の狭幅時に `Action Dock` と right pane の両方へ到達できるよう、高さと overflow を制御する
3. composer の attachment list に高さ上限と scroll を入れ、多数添付時も textarea / `Send` が押し出されないようにする
4. `Diff Window` は狭幅で pane 自体を縦 stack に倒し、必要な横 scroll は pane 内に閉じる

## 検証

- `npm run build`
- 狭幅時の Session / Diff / attachment list を manual test 観点で確認できる状態まで docs を同期する

## 完了条件

- review `#8 #9` に対する current 実装の対処内容が code / docs / checklist に反映されている
- `docs/task-backlog.md` の `session-responsive-guardrails` が完了状態になる
