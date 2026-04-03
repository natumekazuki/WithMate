# Plan

- task: Session Window の header 操作を整理する
- date: 2026-04-03
- owner: Codex

## 目的

- `#37 セッションウインドウのヘッダー調整` として、header に載っている操作のうち右ペインや別導線へ逃がせるものを整理する
- 左ペインは chat と `Action Dock` に集中できる見た目へ寄せる

## スコープ

- Session Top Bar の操作責務整理
- right pane への導線移設または集約
- 関連する `desktop-ui` / backlog / manual test の同期

## 進め方

1. current の Top Bar と right pane の責務を確認する
2. 移設候補と残置候補を決める
3. renderer / style を更新する
4. docs / test を同期する

## チェックポイント

- [x] Top Bar と right pane の責務を整理する
- [x] UI 実装を更新する
- [x] docs と test を更新する
- [x] build と関連 test を通す
