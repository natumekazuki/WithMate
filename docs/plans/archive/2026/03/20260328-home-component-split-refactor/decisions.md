# Decisions

## D-001 最初は renderer 専用 component file へ切る

- いきなり folder を細分化せず、まず `src/home-components.tsx` に pure component をまとめる
- props が安定してから file 分割を検討する

## D-002 先に切るのは launch / settings content

- launch dialog と settings content は block が大きく、props 境界も比較的閉じている
- `Recent Sessions` と `Home right pane` は次の slice 候補に回してよい
