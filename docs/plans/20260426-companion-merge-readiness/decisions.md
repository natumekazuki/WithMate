# Companion Merge Readiness 実装 Decisions

## 2026-04-26

- target branch drift は `targetBranch` の HEAD と base snapshot commit の parent を比較して判定する。
- target workspace dirty は repo root の working tree を base snapshot commit と比較して判定する。
- merge simulation は selected files を一時 index 上に反映し、tree を作れるか確認する初期実装とする。
- target workspace dirty は selected path 以外も blocker として扱う。
