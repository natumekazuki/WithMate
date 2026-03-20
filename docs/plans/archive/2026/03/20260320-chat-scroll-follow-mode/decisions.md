# Decisions

## Summary

- 新着時のスクロールは「常に末尾」でも「常に維持」でもなく、user intent ベースで切り替える
- 末尾付近の判定、step 更新の範囲、新着あり導線、session 切替時の reset 方針を明文化する

## Decision Log

### 0001

- 日時: 2026-03-20
- 論点: Session の新着レスポンス時に、常に末尾追従するか現在位置を維持するか
- 判断: 末尾付近なら自動追従し、読み返し中は現在位置を維持する条件付き follow mode を採用する
- 理由: coding agent のリアルタイム性を保ちつつ、過去の command や reasoning を読み返す UX を壊さないため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`

### 0002

- 日時: 2026-03-20
- 論点: `末尾付近` をどう定義し、follow / off をいつ切り替えるか
- 判断: bottom gap が `80px` 以下を `末尾付近` とし、上方向スクロールで `80px` を超えたら follow を `OFF` にする。末尾へ戻る、または `selectedSession.id` 切替時は follow を `ON` に戻す
- 理由: 末尾近辺の微小な揺れで state が頻繁に切り替わるのを避けつつ、読み返し中の位置維持を優先できるため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/manual-test-checklist.md`

### 0003

- 日時: 2026-03-20
- 論点: `liveRun.steps` のどの変化を scroll トリガーとして扱うか
- 判断: length だけでなく、各 step の `status / summary / details` 変化も表示内容の更新として扱う
- 理由: 現行 baseline では length 変化しか拾っておらず、step の状態更新が見逃されると follow 中の実況性が落ちるため
- 影響範囲: `src/App.tsx`, `docs/manual-test-checklist.md`

### 0004

- 日時: 2026-03-20
- 論点: 追従停止中の `新着あり` 導線を設けるか
- 判断: 導線を設ける。最小構成は「新着あり / 末尾へ移動」の単一アクションとする
- 理由: follow `OFF` 中に新着が来ても、ユーザーが自分の読み位置を失わずに復帰できるようにするため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0005

- 日時: 2026-03-20
- 論点: `selectedSession.id` 切替時の follow state をどう扱うか
- 判断: session 切替時は follow state をリセットし、初期状態は follow `ON` とする
- 理由: 前 session の読み返し状態を持ち越すと、別 session の初期実況を取り逃がす可能性があるため
- 影響範囲: `src/App.tsx`, `docs/manual-test-checklist.md`
