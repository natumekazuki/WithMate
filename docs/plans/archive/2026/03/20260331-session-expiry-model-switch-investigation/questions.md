# Questions

## Status

- 質問なし

## 理由

- 未確認事項は残るが、`#24` と `#32` を同一クラスタとして整理し、先に対応方針を決める材料は揃っている
- 今回は research task として、追加ヒアリング待ちにせず follow-up 実装の入口を固める方が価値が高い

## Optional Follow-Up Questions

- `#24` の再現 provider は `codex` / `copilot` のどちらか、または両方か
- `#24` は model switch 直後だけか、一定 idle 後の switch でも起きるか
- `#24` / `#32` の raw error text に `not found` 以外の `invalid thread` / `model incompatible` 系情報が含まれていたか
- `#32` の idle 時間は「約 1 時間」で安定再現か、provider / model ごとに閾値差があるか
