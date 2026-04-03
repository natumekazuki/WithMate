# Decisions

## Decision 1

- status: confirmed
- decision: Session header は session 全幅ではなく right pane 上部へ移し、`More` を廃止して操作を常設する
- rationale:
  - user の要求は「左ペインの chat 面を最上端から使う」「header は right pane だけ」「`More` は不要」というものだった
  - 前回の `Audit Log / Terminal` を utility action へ逃がすだけの整理では、global header 自体が残っており意図とずれていた
  - header を right pane 側へ寄せれば、title と操作は残しつつ left 側の message list / Action Dock を最上端から使える
