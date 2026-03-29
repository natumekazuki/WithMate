# Plan

## Goal

- Copilot / Codex session で `model` / `reasoningEffort` を変更しても `threadId` を reset せず、既存 thread を source of truth とした会話継続性を維持できる状態にする
- `src/App.tsx` の設定変更経路、`src/session-state.ts` の helper、`src-electron/copilot-adapter.ts` / `src-electron/codex-adapter.ts` の resume 前提、および自動テストの完了条件をこの task に固定する

## Scope

- `src/App.tsx` の `model` / `reasoningEffort` 変更時に `threadId` を維持する
- `src/session-state.ts` の共通 helper で Copilot / Codex の continuity rule を揃える
- `src-electron/copilot-adapter.ts` / `src-electron/codex-adapter.ts` の helper が `model` / `reasoningEffort` 変更後の config/options で `resumeSession()` / `resumeThread()` できることをテストで担保する

## Out Of Scope

- custom agent 切り替え
- Session UI 文言変更
- provider 実機での model 切り替え semantics の保証 beyond manual smoke

## Affected Files

- `src/App.tsx`
- `src/session-state.ts`
- `src-electron/copilot-adapter.ts`
- `src-electron/codex-adapter.ts`
- `scripts/tests/session-state.test.ts`
- `scripts/tests/copilot-adapter.test.ts`
- `scripts/tests/codex-adapter.test.ts`

## Findings

- `src/App.tsx` の `handleChangeModel()` / `handleChangeReasoningEffort()` は現在 `threadId: ""` を保存している
- `src-electron/copilot-adapter.ts` は settingsKey 差分があっても、`threadId` があれば `resumeSession(threadId, config)` を使える構造を持っている
- `buildCopilotSessionSettings()` は `model` / `reasoningEffort` / custom agent を `SessionConfig` と `settingsKey` に反映しているため、設定変更後 config のテスト追加が可能である
- `src-electron/codex-adapter.ts` も `buildCodexThreadSettings()` に `model` / `reasoningEffort` を含む `settingsKey` と、`threadId` がある場合の `resumeThread(threadId, options)` 経路を持つ
- `src/session-state.ts` には custom agent 切り替え時の `threadId` 維持 helper がすでにあり、Copilot / Codex continuity 更新 helper を揃える余地がある

## Implementation Approach

1. `src/App.tsx` の更新方針を Copilot / Codex continuity に合わせる
   - Copilot / Codex session に対しては `model` / `reasoningEffort` 変更時に `threadId` を空へ戻さない
   - `resolveModelSelection()` による正規化後の値を保存しつつ、会話継続性に必要な `threadId` を維持する
   - Copilot / Codex 以外の provider まで挙動を広げるかは今回の scope に含めず、必要最小限の変更に留める
2. 必要なら session helper へ前提作業を入れる
   - `src/App.tsx` の重複更新ロジックが増える場合は、Copilot / Codex の設定変更時に `threadId` を維持する helper を `src/session-state.ts` へ追加する
   - この helper 追加は task 完了条件に直結する局所リファクタとして同一 plan 内で扱う
3. adapter 側は resume 前提をテストで固定する
   - `buildCopilotSessionSettings()` / `buildCodexThreadSettings()` が新しい `model` / `reasoningEffort` を config/options に反映し、settingsKey が変わることを確認する
   - `resolveCopilotSessionForSettings()` / `resolveCodexThreadForSettings()` が `threadId` を持つ session では `createSession()` / `startThread()` ではなく `resumeSession(threadId, config)` / `resumeThread(threadId, options)` を使うことを確認する
4. 検証を task 完了条件に含める
   - 自動検証は `npm test` / `npm run build` / `npm exec tsc -p tsconfig.electron.json --noEmit --pretty false` を必須とする
   - `npm run typecheck` は baseline 観測として結果を記録する
   - 手動テストは手順のみ残し、実施はユーザー担当とする

## Risks

- Copilot SDK / provider 側が model や reasoning の変更を伴う `resumeSession()` を常に期待どおり扱えるとは限らない
- Codex SDK / provider 側が model や reasoning の変更を伴う `resumeThread()` を常に期待どおり扱えるとは限らない
- `src/App.tsx` の変更を provider 非依存で広げると、他 provider の既存 reset ルールまで意図せず変わる可能性がある
- `resolveModelSelection()` の正規化結果により、ユーザー選択値と保存値が変わるケースでは continuity helper の期待値を慎重に定義する必要がある
- cached session / thread の settingsKey 差し替え時に、disconnect / resume の順序に依存する回帰が入り得る

## Validation

### 自動

- `npm test`
- `npm run build`
- `npm exec tsc -p tsconfig.electron.json --noEmit --pretty false`
- `npm exec -- tsc -p tsconfig.electron.json --noEmit --pretty false`（npm CLI の引数解釈差分が出る場合の同等確認）
- `npm run typecheck`（baseline 観測として記録）

### 手動テスト手順（ユーザー実施）

1. `GitHub Copilot` provider の session を開始し、最初のメッセージ送信で `threadId` が付与された状態を作る
2. `model` を変更し、次のメッセージ送信で会話が restart せず継続していることを確認する
3. 続けて `reasoningEffort` を変更し、再度会話継続性が保たれることを確認する
4. `Codex` provider の session でも同様に `threadId` 付き状態を作り、`model` / `reasoningEffort` 変更後に restart せず継続していることを確認する
5. 可能なら開発者向けログやテスト観点に沿って、変更後 config / options を伴う `resumeSession()` / `resumeThread()` 経路が使われていることを確認する
6. manual smoke の範囲で、セッション保存後や再表示後に metadata が破綻していないことを確認する

### 手動テスト結果

- ユーザー確認: 2026-03-29 に manual smoke 実施済み
- 結果: 「OKよさそう」
- 判定: Copilot / Codex とも implementation commit 前の完了条件を満たしたとみなす

## Done Criteria

- Copilot / Codex session の `model` / `reasoningEffort` 変更時に `threadId` を維持する方針が `src/App.tsx` に反映される
- 必要な helper 追加を行った場合、その責務が `threadId` 維持に限定されている
- `src-electron/copilot-adapter.ts` / `src-electron/codex-adapter.ts` の helper テストで、設定変更後 config/options と resume 経路が担保される
- `npm test` / `npm run build` / `npm exec tsc -p tsconfig.electron.json --noEmit --pretty false` の結果を記録する
- `npm run typecheck` の baseline 観測結果を記録する
- 手動テスト手順が plan に残っており、実施主体がユーザーであることが明記されている

## Status

- 状態: 完了
- 実装: 完了（commit: `5021984` `fix(session): model変更時のthread continuityを維持`）
- 手動テスト: ユーザー確認済み（「OKよさそう」）
- archive: `docs/plans/archive/2026/03/20260329-copilot-model-reasoning-threadid-continuity/` へ移動済み
- docs-sync: plan / worklog / result 更新のみで維持
