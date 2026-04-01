# Plan

## Goal

- `#27 Memory生成頻度高すぎ` に対して、default の memory extraction threshold を実運用向けへ引き上げる
- Settings / normalize / docs / tests を current 方針へ同期する

## Scope

- memory extraction threshold の default / normalize 上限見直し
- 関連 unit test 更新
- design / backlog / plan artefact 更新

## Out Of Scope

- trigger 条件を outputTokens 以外へ拡張すること
- `#16` の close / app close trigger 見直し
- `#25` の monologue trigger policy

## Task List

- [x] repo plan を作成する
- [x] current threshold と関連 docs / tests を棚卸しする
- [x] default / clamp 方針を決める
- [x] 実装とテストを更新する
- [x] docs を同期する
- [x] 必要な検証を実行する

## Affected Files

- `src/provider-settings-state.ts`
- `scripts/tests/home-settings-view-model.test.ts`
- `scripts/tests/home-settings-draft.test.ts`
- `scripts/tests/session-memory-extraction.test.ts`
- `docs/design/memory-architecture.md`
- `docs/design/database-schema.md`
- `docs/task-backlog.md`

## Risks

- default を上げすぎると memory extraction がほぼ走らず、Session Memory の鮮度が落ちる
- clamp を広げる場合、Settings で極端な値を入れた時の説明責務が残る

## Validation

- `node --import tsx scripts/tests/provider-settings-state.test.ts`: 成功
- `node --import tsx scripts/tests/home-settings-view-model.test.ts`: 成功
- `node --import tsx scripts/tests/home-settings-draft.test.ts`: 成功
- `node --import tsx scripts/tests/session-memory-extraction.test.ts`: 成功
- `npm run build`: 成功

## Docs Sync

- `docs/design/memory-architecture.md`: 更新した。理由: current default threshold を current 実装へ同期するため
- `docs/design/database-schema.md`: 更新した。理由: `memory_extraction_provider_settings_json` の example を current default へ合わせるため
- `docs/task-backlog.md`: 更新した。理由: `#27` の current 状態と残論点を同期するため
- `.ai_context/`: 更新不要。理由: 設定 default と test/doc 同期に留まり、workspace 運用ルールの追加がないため
- `README.md`: 更新不要。理由: ユーザー向け機能入口や操作手順の説明変更ではないため
