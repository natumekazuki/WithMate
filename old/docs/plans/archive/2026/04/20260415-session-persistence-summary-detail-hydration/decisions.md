# Decisions — Session persistence summary/detail hydration

## Decision 1: summary/detail contract を追加する

- Status: 採用
- Decision: `Session` をそのまま全経路で使い続けるのではなく、一覧・購読向け summary contract を追加し、個別取得だけ detail を返す。
- Reason:
  - 最も重い `messages` / `stream` の hydration を一覧・初期購読から外せる
  - `getSession()` の detail 用途は維持できる
  - TDD で storage/query/renderer の境界を固定しやすい

## Alternatives

### A. `listSessions()` をそのまま summary へ置換する

- Pros: surface が単純
- Cons: 既存 `Session[]` 前提の呼び出しと test への影響が広い

### B. summary API を追加し、detail API は維持する

- Pros: 移行を段階化しやすく、session window の detail 読み出しを壊しにくい
- Cons: IPC surface が一時的に増える

- Recommended: B

## Refactor Decision

- 判定: `same-plan`
- 対象: summary/detail 専用 clone / normalize / row conversion helper の導入
- 理由: 実装本体の前提であり、単独の価値より本件完了に直接従属するため

## Follow-up Separation

- 判定: `new-plan`
- 対象: diff broadcast、window 種別別 event、差分 payload 配信
- 理由: 本件の受け入れ条件を超える fan-out 最適化で、別検証軸になるため
