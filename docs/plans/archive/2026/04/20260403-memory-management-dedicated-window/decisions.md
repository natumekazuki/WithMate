# Decisions

## Decision 1

- status: confirmed
- decision: `Memory 管理` は新しい renderer entry を増やさず、`HomeApp` の `mode=memory` を dedicated window として再利用する
- rationale:
  - Main / preload / IPC の window 配線だけ追加すれば済み、既存の `SettingsMemoryManagementSection` をそのまま活用できる
  - `Settings Window` からは概要と起動導線だけを残し、一覧 / filter / delete の操作責務を `Memory Management Window` へ集約できる
  - `Home` 右ペインにも導線を足すことで、Settings を経由しなくても直接 Memory 管理へ入れる
