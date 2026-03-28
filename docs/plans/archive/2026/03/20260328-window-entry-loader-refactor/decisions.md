# Decisions

- `WindowEntryLoader` は `BrowserWindow` の読み込みだけを担当し、window 生成や registry は持たない
- `mode=create` や query string の組み立ても service 側へ寄せる
