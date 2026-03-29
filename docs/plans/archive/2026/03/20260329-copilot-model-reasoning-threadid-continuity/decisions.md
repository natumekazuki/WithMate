# Decisions

## 2026-03-29

### same-plan 追補判定: Codex continuity 取り込みは `same-plan`

- 判定: `same-plan`
- 理由:
  - 今回の追補は `model` / `reasoningEffort` 変更時の continuity rule を Copilot 専用から Codex + Copilot に揃えるだけで、同じ metadata helper と adapter resume 経路の検証軸に載るため
  - `src/session-state.ts` と `src-electron/codex-adapter.ts`、および対応テストの局所変更で完結し、UI や永続化仕様の再設計を要求しないため
  - Codex には既存の `resumeThread(threadId, options)` 経路があるため、runtime を変えず helper export とテスト固定だけで完了条件を満たせるため

### same-plan / new-plan 判定: `new-plan`

- 前回の related task は `docs/plans/archive/2026/03/20260329-copilot-agent-switch-session-reset/` として archive 済みである
- 今回は custom agent 切り替えではなく、`model` / `reasoningEffort` 変更時の continuity を対象にしており、目的・変更経路・検証観点が独立している
- そのため archived task を reopen せず、新しい repo plan として分離する

### 採用案: Copilot の `model` / `reasoningEffort` 変更も continuity 優先で扱う

- `src/App.tsx` では Copilot session の `model` / `reasoningEffort` 更新時に `threadId` を reset しない方針を採用する
- `src-electron/copilot-adapter.ts` 側は既存の `resumeSession(threadId, config)` 前提を維持し、変更後 config が反映された状態で resume できることをテストで固定する
- 理由:
  - ユーザー要求が「model / reasoningEffort 変更も agent 切替と同じにしたい」で明確である
  - adapter には settingsKey 差分があっても `threadId` があれば resume できる構造がすでにある
  - custom agent task と揃った continuity rule の方が UI / 実装意図の一貫性が高い
  - same-plan 追補として Codex も同じ continuity rule に含めた方が、provider 差分を helper と adapter test に局所化できる

### same-plan 拡張判定: Codex continuity 修正は同一 plan に含める

- 判定: `same-plan`
- 理由:
  - `src/session-state.ts` の `model` / `reasoningEffort` 更新 helper がすでに今回 plan の変更経路にあり、Codex も同じ helper から `threadId` reset/keep が決まるため
  - `src-electron/codex-adapter.ts` でも `threadId` が `resumeThread(threadId, options)` の source of truth になっており、`buildThreadSettings()` の `settingsKey` に `model` / `reasoningEffort` が入るので、Copilot と同じ continuity break が発生するため
  - 修正目的が「設定変更後も thread continuity を保つ」で一致し、変更対象・検証軸も `settingsKey` 更新と resume 経路確認で共通だから
- 想定影響範囲:
  - `src/session-state.ts`
  - `src-electron/codex-adapter.ts`
  - `scripts/tests/session-state.test.ts`
  - `scripts/tests/codex-adapter.test.ts`
- 検証観点:
  - Copilot / Codex の両方で `model` / `reasoningEffort` 更新後も `threadId` を維持すること
  - Codex settings helper が変更後 options と `settingsKey` を生成すること
  - Codex が `threadId` 存在時に `startThread()` ではなく `resumeThread(threadId, options)` を使うこと

### 局所リファクタ判定: `src/session-state.ts` helper 追加は `same-plan`

- 判定: `same-plan`
- 理由:
  - `src/App.tsx` の更新ロジック重複を避けつつ、Copilot continuity の完了条件を満たすための前提作業だから
  - 変更対象が session metadata 更新 helper に限定され、目的・変更範囲・検証軸が今回 task と一致するから
- 想定影響範囲:
  - `src/App.tsx`
  - `src/session-state.ts`
  - `scripts/tests/session-state.test.ts`
- 検証観点:
  - `threadId` が維持されること
  - `model` / `reasoningEffort` の正規化後値が期待どおり保存されること
  - custom agent 用既存 helper の責務を壊さないこと

### 非採用案: 全 provider 共通で `model` / `reasoningEffort` 変更時の reset ルールを見直す

- 判定: `new-plan`
- 理由:
  - Copilot / Codex の continuity 修正から独立した横断リファクタになるため
  - 他 provider の reset semantics や UI expectation を追加で整理する必要があるため
- 想定影響範囲:
  - `src/App.tsx`
  - provider ごとの session resume / restart 方針
  - Session UI の説明責務
- 検証観点:
  - provider 間で一貫した reset ルールになっているか
  - model 変更後の会話継続性が各 provider で期待どおりか
  - restart を前提にしていた既存動線が壊れないか

### 保留事項

- provider 実機における model 切替 semantics の完全保証は今回 task の完了条件に含めない
- manual smoke を超える provider 依存挙動の調査が必要になった場合は follow-up として分離する
