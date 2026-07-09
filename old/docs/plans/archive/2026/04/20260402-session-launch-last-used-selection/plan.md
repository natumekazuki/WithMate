# session-launch-last-used-selection plan

## 目的

- `New Session` 作成時に、model / reasoning depth / custom agent を「最後に使った選択」から引き継げるようにする
- 既存 session は現在どおり session metadata に保存された選択をそのまま使う

## 現状

- 既存 session の `model / reasoningEffort / customAgentName` は session metadata に保存され、再オープン時も保持される
- `New Session` dialog は `provider / character / workspace / title` だけを持ち、model / depth / custom agent は session 作成時に provider default で初期化される

## 継承ルール

1. 既存 session を開く時は、保存済み session metadata をそのまま使う
2. `New Session` は、選択中 provider と同じ provider を使っている直近 session があれば、その `model / reasoningEffort / customAgentName` を継承する
3. 該当 provider の直近 session が無ければ、従来どおり provider default を使う
4. `customAgentName` は provider が対応していない場合でも空文字として安全に保存できる

## 対象

- `src/home-launch-state.ts`
- `src/HomeApp.tsx`
- 必要なら `src/session-state.ts` または `src-electron/session-persistence-service.ts`
- `scripts/tests/home-launch-state.test.ts`
- `scripts/tests/session-persistence-service.test.ts`
- `docs/design/session-launch-ui.md`
- `docs/design/desktop-ui.md`

## 検証

- `npm run build`
- `node --import tsx scripts/tests/home-launch-state.test.ts`
- `node --import tsx scripts/tests/session-persistence-service.test.ts`

## 完了条件

- `New Session` で作成した session が、選択中 provider の直近 session から model / depth / custom agent を引き継ぐ
- 既存 session を開いた時の current behavior は変わらない
