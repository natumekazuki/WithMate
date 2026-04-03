# Decisions

## Decision 1

- status: confirmed
- decision: packaging tool は `electron-builder` を採用し、Windows は `nsis`、macOS は `dmg` を current target とする
- rationale:
  - current repo に installer 基盤は無く、`electron-builder` が最短で Windows / macOS の両 target を同じ設定面で扱えるため
  - 2026-04-04 時点の公式 docs でも Windows installer と macOS dmg が標準 target として案内されているため

## Decision 2

- status: confirmed
- decision: current task では未署名ビルドを正本にし、macOS 実ビルドは macOS machine または macOS CI runner 前提とする
- rationale:
  - Windows 環境では macOS artifact の local 検証ができない
  - まずは packaging 接続と配布手順の再現性を先に固め、署名や notarization は別 task に切り出す方が安全なため
