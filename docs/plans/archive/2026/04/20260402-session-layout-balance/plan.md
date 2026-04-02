# Plan

- 状態: 完了
- 目的: Session Window の右 pane を下まで伸ばし、Action Dock の幅を chat UI と揃えつつ、1400px 付近でも right pane へ到達できるレイアウトへ調整する

## チェックポイント

1. 現行レイアウトと review `#7` の問題点を整理し、wide / narrow 両方の配置方針を決める
2. Session の DOM / CSS を更新して right pane と Action Dock の配置を改善する
3. design / manual test / backlog を同期し、build で検証する
