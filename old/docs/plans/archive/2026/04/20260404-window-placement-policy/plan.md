# 20260404-window-placement-policy

## 目的

- 新規 window を固定座標ではなく、カーソル位置起点で自然に開くようにする
- Home / Session / Diff / Memory などの補助 window で placement policy を揃える

## スコープ

- `src-electron/` の window 生成と placement
- `docs/design/window-architecture.md`
- `docs/task-backlog.md`

## 方針

- current の window 生成箇所と座標決定ロジックを確認する
- カーソル位置を起点にしつつ、画面外へはみ出さない clamp policy を入れる
- 親 window 起点とカーソル起点が競合する箇所は優先順位を決める

## 検証

- 関連 test
- `npm run build`
