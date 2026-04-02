# Result

- 状態: 完了

## 完了条件

- wide レイアウトで right pane が下まで伸び、Action Dock の幅が会話列と揃っている
- 1400px 付近でも right pane へ到達できる
- design / manual test / backlog が current 実装に同期している
- build が通っている

## 中間結果

- wide レイアウトを `左列 = message list + Action Dock`、`右列 = context pane` に再配置した
- 1400px 以下では `message list + Action Dock` の下に right pane を縦 stack するようにした
- `docs/design/desktop-ui.md`、`docs/manual-test-checklist.md`、`docs/task-backlog.md` を同期した

## 完了結果

- `#20 Session 入力エリア幅調整` を完了扱いに更新した
- wide では right pane を下端まで伸ばし、Action Dock の幅を message list 列へ揃えた
- 1400px 付近では right pane を別段に残し、到達性を維持した
- 実装コミット: `94602b4` `feat(session): rebalance layout around action dock`
