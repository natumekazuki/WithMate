# Mate Growth Settings の memoryCandidateMode を runtime に反映する

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P1
- Type: Bug
- Related:
  - `src/settings/SettingsContent.tsx`
  - `src/mate/mate-state.ts`
  - `src-electron/mate-storage.ts`
  - `src-electron/main.ts`
  - `src-electron/mate-memory-generation-service.ts`
  - `src-electron/session-runtime-service.ts`
  - `src-electron/mate-talk-service.ts`
  - `docs/design/mate-growth-engine.md`
  - `./06-growth-model-priority-ui.md`
  - `scripts/tests/home-components.test.tsx`
  - `scripts/tests/mate-storage.test.ts`
  - `scripts/tests/session-runtime-service.test.ts`
  - `scripts/tests/mate-talk-service.test.ts`

## Summary

`Settings > Mate Growth Settings > メモリ候補モード` で `every_turn` / `threshold` / `manual` を選べるが、current runtime では挙動差がない。  
設定値は保存される一方で、自動の Mate Memory generation 実行条件に反映されていないため、ユーザーが選んだ mode が効いているように見えて実際には効かない。

## Current behavior

- UI は `every_turn` / `threshold` / `manual` の 3 択を表示し、更新も保存できる
- `mate_growth_settings.memory_candidate_mode` は DB に保存される
- session completed 後の `scheduleMateMemoryGeneration` は `memoryCandidateMode` を確認せず `MateMemoryGenerationService.runOnce()` を呼ぶ
- MateTalk 側の `scheduleMemoryGeneration` も `memoryCandidateMode` を確認せず `MateMemoryGenerationService.runOnce()` を呼ぶ
- `MateMemoryGenerationService.runOnce()` 自体も `memoryCandidateMode` を見ない
- current UI には「memory candidate 抽出を手動実行する」専用操作が見当たらず、`manual` を選んでも auto-run が止まらない

## Problem

- `threshold` を選んでも current code では `every_turn` と同じように抽出が走る
- `manual` を選んでも auto-run が止まらず、名称と挙動が一致しない
- 設定画面の説明責務と runtime の実挙動がずれており、調整項目として信頼できない
- 将来の Growth trigger 設計 (`pending_count_threshold` / `pending_salience_threshold` / cooldown / manual run) と整合しない

## Expected behavior

少なくとも、user-visible な `memoryCandidateMode` は runtime の抽出条件に反映されるべき。

期待される最低ライン:

- `every_turn`: completed turn 後に自動で Memory Candidate 生成を enqueue する
- `threshold`: threshold 条件を満たす時だけ自動生成する
- `manual`: 自動生成しない。明示的な manual action でだけ生成する

もし `threshold` / `manual` をまだ support しないなら、UI から選べないようにするか、未実装であることを明示して実効値との乖離をなくす。

## Proposed scope

1. `memoryCandidateMode` を session / mate-talk の auto scheduling 条件に組み込む
2. `threshold` の評価条件を current design と整合する形で定義する
3. `manual` 用の明示 trigger を用意する、または未対応なら UI から除外する
4. Settings UI / runtime / tests / docs を同じ挙動に揃える

## Acceptance criteria

- [ ] `every_turn` で completed turn 後に自動抽出される
- [ ] `threshold` で completed turn 後も無条件 auto-run しない
- [ ] `manual` で completed turn 後の auto-run が止まる
- [ ] manual mode を選んだ場合の実行導線がある、または mode 自体が UI に出ない
- [ ] session path と mate-talk path の両方で mode 判定が一致する
- [ ] regression test で mode ごとの差を固定する

## Notes / open questions

- `threshold` の詳細条件は design 上の `pending_count_threshold` / `pending_salience_threshold` / cooldown / manual run と接続して決めたい
- 当面の最小修正としては、未実装 mode を UI から隠す方針もありうる
- ただし current UI が 3 択を露出している以上、少なくとも現状は Bug 扱いが妥当


