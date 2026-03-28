# Decisions

## Decision 1: reset は settings/catalog service に含める

- reset 対象には `app settings` と `model catalog` が含まれる
- session / memory への波及はあるが、起点としては settings 側の操作であるため、service に寄せる

## Decision 2: file dialog は main.ts に残す

- `showOpenDialog` / `showSaveDialog` は window 依存が強い
- export/import の document 読み書きと rollback は service に寄せ、dialog 自体は main に残す
