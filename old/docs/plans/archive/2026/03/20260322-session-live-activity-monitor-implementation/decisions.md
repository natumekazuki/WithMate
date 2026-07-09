# Decisions

## Summary

- `live run step` は pending bubble から分離し、Session Window 下部の `Activity Monitor` として実装する

## Decision Log

### 0001

- 日時: 2026-03-22
- 論点: `Activity Monitor` の配置をどこに置くか
- 判断: follow banner の下、composer の上に置く
- 理由: message list と常に同時に見え、かつ composer 操作の直前で command 実況を確認しやすいため
- 影響範囲: `src/App.tsx`, `src/styles.css`

### 0002

- 日時: 2026-03-22
- 論点: message list follow と `Activity Monitor` follow をどう分離するか
- 判断: message list は `assistantText` / pending bubble 更新だけに追従し、step 更新は `Activity Monitor` 側の独立 follow で扱う
- 理由: command が多い turn でも会話本文の可読域を守りつつ、実況の realtime 可視性も維持できるため
- 影響範囲: `src/App.tsx`, `docs/design/desktop-ui.md`, `docs/design/session-live-activity-monitor.md`, `docs/manual-test-checklist.md`
