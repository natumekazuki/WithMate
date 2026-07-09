# 20260404-session-density-tuning

## 目的

- Full HD で Session UI が大きく見える要因を密度調整で抑える
- 文字サイズそのものより、gap / padding / chip / button 縦寸を中心に詰める
- user chat が左端まで使えるようにレイアウトを見直す

## スコープ

- `src/session-components.tsx`
- `src/styles.css`
- 必要なら `docs/design/desktop-ui.md` と `docs/task-backlog.md`

## 方針

- Session 専用の spacing を先に詰め、Home や他 window へ波及させない
- 文字サイズは原則維持し、padding / gap / radius / line-height の見直しで密度を上げる
- user bubble の left gutter は avatar 不在時に縮める

## 検証

- `npm run build`
- 関連 render test
