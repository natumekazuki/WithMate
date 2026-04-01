# Plan

## Goal

- `docs/task-backlog.md` を 2026-04-01 時点の GitHub issue 状態へ同期する
- `#21 実行中もDetailsを更新` に対応し、turn 実行中でも確定済みの detail 情報を Session Window から追えるようにする

## Scope

- `docs/task-backlog.md` の issue backlog 同期
- `Session Window` の running details 表示改善
- 必要な design / test / plan artefact 更新

## Out Of Scope

- Memory trigger policy の見直し
- `#22 MemoryGeneration` 詳細表示
- Audit Log schema の変更

## Task List

- [x] repo plan を作成する
- [x] `docs/task-backlog.md` を最新 issue へ同期する
- [x] `#21` の current UI / data flow を確認する
- [x] running details の表示方針を決める
- [x] 実装とテストを追加する
- [x] docs / plan artefact を同期する
- [x] 必要な検証を実行する

## Affected Files

- `docs/task-backlog.md`
- `docs/design/session-live-activity-monitor.md`
- `docs/design/desktop-ui.md`
- `src/App.tsx`
- `src/session-components.tsx`
- `src/session-ui-projection.ts`
- `src/runtime-state.ts`
- `scripts/tests/session-ui-projection.test.ts`

## Risks

- running state の detail を増やしすぎると、既存の `Latest Command` monitor が full timeline 化して情報過多に戻る
- provider ごとに live step 粒度が違うため、Codex / Copilot 両方で自然な要約に揃える必要がある
- run 中の detail 更新が scroll follow や pending bubble の既存挙動を壊す恐れがある

## Validation

- `node --import tsx scripts/tests/session-ui-projection.test.ts`: 成功
- `npm run build`: 成功

## Docs Sync

- `docs/task-backlog.md`: 更新した。理由: 2026-04-01 時点の `#30-#34` と `#24` / `#21` の優先度・状態を current 実装へ合わせる必要があったため
- `docs/design/session-live-activity-monitor.md`: 更新した。理由: `Latest Command` 面に確定済み running details を数件だけ補助表示する current 仕様を反映するため
- `docs/design/desktop-ui.md`: 更新した。理由: Session Window right pane の current UX を current 実装へ合わせるため
- `.ai_context/`: 更新不要。理由: 実装変更は Session Window の local UI projection と backlog 同期に留まり、workspace 運用ルールの追加がないため
- `README.md`: 更新不要。理由: ユーザー向け導線や機能入口の説明を変える変更ではないため
