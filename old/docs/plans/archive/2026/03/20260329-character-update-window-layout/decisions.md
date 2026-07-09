# Decisions

- Character Update Window は update session 自体を内包せず、直近の character update session を linked session として参照する
- 右ペインは `LatestCommand / MemoryExtract` の 2 面にする
- `LatestCommand` は linked session の live run を優先し、なければ直近の update session audit から補助表示する
- `MemoryExtract` は従来どおり手動 refresh / copy 前提の貼り付け用テキストとする
