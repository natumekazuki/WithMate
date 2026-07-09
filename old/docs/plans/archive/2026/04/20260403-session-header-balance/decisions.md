# Decisions

## Decision 1

- status: confirmed
- decision: `Audit Log` と `Terminal` は Session Top Bar から外し、right pane の utility action へ寄せる
- rationale:
  - `Rename / Delete` はすでに `More` 配下で、header から外せる常設操作は `Audit Log / Terminal` が中心だった
  - `Generate Memory` は元から right pane 側の操作なので、同じ列に `Audit Log / Terminal` を集約すると役割が揃う
  - 左ペイン側では `title / More / Close` だけを残した方が、chat と `Action Dock` に視線を寄せやすい
