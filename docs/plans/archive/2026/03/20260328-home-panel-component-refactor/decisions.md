# Decisions

## D-001 Home 用 component は `src/home-components.tsx` に継続集約する

- 現段階では file 分割よりも component 境界の固定を優先する
- `Recent Sessions` と `Home right pane` も既存の `home-components.tsx` に追加する

## D-002 HomeMonitorContent はそのまま再利用する

- `Home right pane` の `Monitor` tab と `Session Monitor Window` で同じ描画を使っている
- 今回は `HomeMonitorContent` を内包する panel component を追加し、既存再利用を崩さない
