# Plan

## Goal

- `#22 右ペインのMemoryGenerationに詳細追加` として、更新された Memory 内容を right pane の `MemoryGeneration` から確認できるようにする
- Session / Character 両方の background activity details を current 実装に合わせて整理する

## Scope

- memory generation 完了時の activity details を強化する
- related tests を追加または更新する
- design / backlog / plan artefact を同期する

## Out Of Scope

- Memory 一覧 UI や delete UI の追加
- `#16` `#25` の trigger policy 見直し
- Audit Log の表示構成変更

## Task List

- [x] repo plan を作成する
- [x] current `MemoryGeneration` 表示と background activity payload を確認する
- [x] updated memory content をどの detail へ載せるか決める
- [x] 実装とテストを更新する
- [x] docs を同期する
- [x] 必要な検証を実行する

## Affected Files

- `src-electron/memory-orchestration-service.ts`
- `scripts/tests/memory-orchestration-service.test.ts`
- `docs/design/session-live-activity-monitor.md`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
- `docs/task-backlog.md`

## Risks

- details に更新内容を詰め込みすぎると right pane の可読性が落ちる
- session / character memory で detail 形式がぶれると理解コストが上がる

## Validation

- `node --import tsx scripts/tests/memory-orchestration-service.test.ts`: 成功
- `npm run build`: 成功

## Docs Sync

- `docs/design/session-live-activity-monitor.md`: 更新した。理由: `MemoryGeneration` details に updated memory content を含める current 仕様へ同期するため
- `docs/design/desktop-ui.md`: 更新した。理由: Session Window 右ペインの current details 内容を同期するため
- `docs/manual-test-checklist.md`: 更新した。理由: `MemoryGeneration` details で更新内容を確認する実機観点を追加するため
- `docs/task-backlog.md`: 更新した。理由: `#21` `#22` と推奨順を current 状態へ同期するため
- `.ai_context/`: 更新不要。理由: UI / activity details の slice に留まり、workspace rule や coding rule は変わらないため
- `README.md`: 更新不要。理由: 利用入口や操作手順の大枠は変わらないため
