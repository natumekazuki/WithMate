# Decisions

## 2026-03-28

- artifact block の内訳まで無理に細分化せず、まずは message column 全体を 1 component として切り出す
- `App.tsx` に残すのは state / derived value / callback の準備に限定する
