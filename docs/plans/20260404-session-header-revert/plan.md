# 20260404 session-header-revert

## 目的

- 途中まで試した Session header の再構成を取りやめ、安定していた `Top Bar + right pane utility action` 構成へ戻す
- ただし header とは別件の `Generate Memory` の表示制御は維持する

## 対応

- `git revert` 中の競合を、旧 header 構成を正本にして解消する
- `docs/design/desktop-ui.md` と `docs/manual-test-checklist.md` を現実装に合わせて同期する
- revert 完了後に build で崩れがないことを確認する
