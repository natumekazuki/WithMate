# Plan

## Goal

- SessionWindow で `GitHub Copilot` 利用中に custom agent を切り替えても、既存 conversation の `threadId` を不必要に失わず、adapter が `resumeSession()` を通じて会話継続性を保てる実装を完了する
- 今回 task の変更範囲・採用方針・検証方針を「custom agent 切り替え時の `threadId` 維持 + adapter resume 挙動 + 自動テスト」に固定し、pending / follow-up を明確に分離したまま結果を残す

## Scope

- `src/App.tsx` における Copilot custom agent 切り替え時の session metadata 更新を修正し、`customAgentName` 更新時に `threadId` を維持する
- `src-electron/copilot-adapter.ts` における session config 構築、cache 切り替え、`resumeSession()` / `createSession()` 分岐を確認し、custom agent 切り替え後も `threadId` があれば `resumeSession(threadId, config)` を使える前提を維持する
- custom agent 切り替え後の `threadId` 維持と adapter resume 挙動を検証する自動テストを追加 / 更新し、手動テスト手順はユーザー実施前提で残す

## Out Of Scope

- model / reasoningEffort 変更時の `threadId` reset 見直し
- Session UI 文言変更や restart UX 実装
- 実機での手動テスト実施そのもの
- custom agent 切り替え以外の session continuity 問題の横展開調査

## Affected Files

- `src/App.tsx`
- `src-electron/copilot-adapter.ts`
- 必要に応じて Copilot adapter / session 周辺の既存 test file
- 必要に応じて build / typecheck に影響する設定ファイル

## Findings

- `src/App.tsx:2209-2228` の `handleSelectCustomAgent()` は `provider === "copilot"` の時、`customAgentName` を更新しつつ `threadId: ""` を保存している
- `src-electron/copilot-adapter.ts:1313-1327` は `customAgentName` を `SessionConfig.agent` / `customAgents` に反映する
- `src-electron/copilot-adapter.ts:1352-1373` は `threadId` があれば `resumeSession(threadId, config)`、空なら `createSession(config)` を使う
- `src-electron/provider-prompt.ts:47-89` は過去の `session.messages` を provider へ再送していないため、`threadId` を空にすると provider 側 conversation context は再作成される
- `src/App.tsx:2319-2353` の model / reasoningEffort 変更も `threadId: ""` を保存しているが、これは今回 task に混ぜず pending / follow-up に維持する

## Implementation Approach

1. custom agent 切り替え時の session state 更新を第一候補に合わせて固定する
   - Copilot custom agent 切り替え時は `customAgentName` 更新と `threadId` 維持を両立する前提で設計する
   - 不要な `threadId` reset を止めても永続 state と UI state が矛盾しないことを確認対象に含める
2. adapter の resume 前提を明文化する
   - `src-electron/copilot-adapter.ts` で `settingsKey` 差分による cache 切り替えと `resumeSession(threadId, config)` の組み合わせを今回の主対象とする
   - custom agent 切り替え後も config 差分が adapter / SDK 側で扱えることを unit レベルで確認できる形へ寄せる
3. 検証を task に含める
   - 自動テストは unit test、typecheck、build を task 完了条件へ含める
   - 手動テストは plan に手順を残すが、実施はユーザー担当として扱う
4. pending / follow-up を固定する
   - model / reasoningEffort 変更時の `threadId` reset は今回 task に混ぜず、別判断が必要な pending / follow-up として維持する

## Risks

- Copilot SDK が custom agent 切り替え後の `resumeSession(threadId, config)` を安全に扱えず、実装上は `threadId` を維持しても provider 側で期待どおり継続しない可能性がある
- `settingsKey` と cached session の組み合わせによって、agent 切り替え前後の session 参照先が不整合になる可能性がある
- `threadId` reset を止めても、他の設定変更経路が同じ前提を共有していない場合は partial fix になる可能性がある
- model / reasoningEffort 問題を今回 scope 外へ分離するため、同系統の reset 問題が残存する前提を result / follow-up へ明記する必要がある

## Validation

### 自動テスト

- `npm test`
- `npm run build`
- `npm exec tsc -p tsconfig.electron.json --noEmit --pretty false`

### 手動テスト手順（ユーザー実施）

1. SessionWindow で provider として `GitHub Copilot` を選択する
2. custom agent を A に設定して会話を開始し、session に `threadId` が付与された状態を作る
3. 同一 session 上で custom agent を B へ切り替える
4. 切り替え後の次メッセージ送信で会話が restart せず、既存 conversation を引き継ぐ挙動になっているか確認する
5. 可能であればログまたは開発者向け表示で `createSession()` ではなく `resumeSession()` 系の経路が使われていることを確認する
6. 切り替え前後で session metadata に不整合がないこと、アプリ再起動後も session 継続に破綻がないことを確認する

## Done Criteria

- Copilot custom agent 切り替え時に `threadId` を維持する実装が `src/App.tsx` に反映されている
- custom agent 切り替え後も `src-electron/copilot-adapter.ts` が新しい agent config を反映しつつ `resumeSession(threadId, config)` を使えることが自動テストで担保されている
- model / reasoningEffort の `threadId` reset が Out Of Scope / pending として明記されている
- 自動テストと手動テスト手順が分離され、手動テストはユーザー実施であることが明記されている

## Status

- 状態: 完了
- 手動テスト: ユーザー実施により完了。会話冒頭で特定フレーズを指示した後に custom agent を切り替えても、切り替え後応答の先頭で同フレーズが維持され、会話継続性に問題がないことを確認済み
- Remaining: なし（`model / reasoningEffort` の reset 問題は今回 scope 外の follow-up 候補として維持）
- Archive: `docs/plans/archive/2026/03/20260329-copilot-agent-switch-session-reset/` へ移動済み
- 実装コミット: `efd8ceae2494a19bcc08909b42b243b5bb70cd92` `fix(copilot): custom agent切替でthreadIdを維持`
