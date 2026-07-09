# Worklog

## Timeline

### 0001

- 日時: 2026-03-22
- チェックポイント: layout redesign の設計作成
- 実施内容:
  - 現行 Session Window の縦 stack 前提を整理した
  - `1920x1080` フル表示を baseline にした 2 カラム案を設計した
  - `Activity Monitor` と `Turn Inspector` を右 rail へ分離する target layout を定義した
- 検証: 文書設計のみのため未実施
- メモ:
  - 実装時は `src/App.tsx` の DOM 構造と `src/styles.css` の grid 再編が主になる
  - `docs/design/desktop-ui.md` と `docs/manual-test-checklist.md` の本更新は実装時に行う
- 関連コミット: なし

### 0002

- 日時: 2026-03-22
- チェックポイント: `Character Stream` と可変 split の考慮
- 実施内容:
  - 右 rail を `Primary Context Pane + Turn Inspector` の host に修正した
  - run 中は `Activity Monitor`、idle 時は `Character Stream` を主表示する前提を追加した
  - 左右カラム間に draggable splitter を置く要件を設計へ反映した
- 検証: 文書設計のみのため未実施
- メモ:
  - `Character Stream` の具体 UI は別 task で設計する
  - split 比率の保存先は実装時に確定する
- 関連コミット: `d5a75cd` (`docs(session): define wide layout redesign`)

## Open Items

- `Turn Inspector` を最新 assistant turn 固定にするか、message 選択状態を持たせるか
- `message follow` banner を sticky chip に寄せるか
- split 比率の保存先を renderer local storage にするか、window layout 設定へ上げるか
