# message-list-virtualization 実装計画

## Plan Tier

- 判定: repo plan
- 理由: `App.tsx`、`src/session-components.tsx`、`src/styles.css`、テスト群にまたがる複数段階の UI 挙動変更であり、設計判断と handoff 価値があるため。

## Goal

`SessionMessageColumn` の `messages.map` 全件描画を、既存 `src/virtual-list.ts` の `calculateVirtualListWindow` を使った message-list windowing に置き換える。既存の追従、未読バナー、artifact 展開、pending/live approval/elicitation、diff 起動の挙動は維持する。

## Non-Goals

- DB/schema 変更はしない。
- `Message` への安定 id 追加はしない。
- `artifactKey` は現行 `${sessionId}-${index}` を維持し、append-only 前提で扱う。
- 可変高実測 virtualizer は導入しない。固定推定高 + overscan で先行する。
- DOM client test harness は導入しない。follow-up とする。

## Scope

### 実装対象

- `src/App.tsx`
- `src/session-components.tsx`
- `src/styles.css`
- `src/virtual-list.ts`
- `scripts/tests/virtual-list.test.ts`
- `scripts/tests/session-app-render.test.ts`
- 必要に応じて `scripts/tests/session-audit-log-modal.test.ts` と同等の static render テスト追加または拡張

### Docs as Code

- design gate: workspace-only
- 理由: 既存 `src/virtual-list.ts` と監査ログ仮想化パターンの再利用であり、公開仕様、DB/schema、主要アーキテクチャ境界は変更しないため。
- 実装中に `Message` id 追加、可変高測定、永続化仕様変更へ広がる場合は repo-sync-required に格上げする。

## Task List

1. `calculateVirtualListWindow` の message-list 用境界ケースを Red で固定する。
2. `SessionMessageColumn` に viewport props と virtual window 計算を導入する。
3. `App.tsx` の `messageListRef` ベースの追従、未読、scroll signature 同期を windowing と整合させる。
4. message-list 用ラッパと spacer の CSS を追加し、既存 Markdown 内 `message-list` class への副作用を避ける。
5. `renderToStaticMarkup` と pure function test で windowing、未読バナー、pending/live UI、artifact 展開の最小保証を追加する。
6. build/test と手動確認項目で回帰確認する。

## Slices

### Slice Red-1: 仮想 window の境界を固定する

- 目的: message-list で使う固定推定高、overscan、末尾 clamp の期待値をテストで固定する。
- 依存: なし。
- 対象: `src/virtual-list.ts`, `scripts/tests/virtual-list.test.ts`
- TDD mode: Red
- 受け入れ条件:
  - `scrollTop` が先頭、中央、末尾付近のとき、`startIndex`、`endIndex`、`paddingTop`、`paddingBottom` が負値にならない。
  - `totalCount` が少ない場合は全件表示に近い安全な window になる。
  - `viewportHeight` が 0 または未初期化相当でも例外にならない。
- targeted tests:
  - `node --test scripts/tests/virtual-list.test.ts`

### Slice Green-1: `SessionMessageColumn` の描画を windowing へ切り替える

- 目的: `messages.map` 全件描画を `calculateVirtualListWindow` 結果に基づく `renderedMessages` 描画へ置き換える。
- 依存: Slice Red-1
- 対象: `src/session-components.tsx`
- TDD mode: Green
- 受け入れ条件:
  - `messages` が大量でも DOM に描画される `message-row` は window 範囲だけになる。
  - `artifactKey` は window 内 index ではなく元配列 index に基づく `${sessionId}-${index}` を維持する。
  - role、pending、live approval/elicitation、diff ボタン、artifact toggle の props 伝播が維持される。
- targeted tests:
  - static render で 100 件以上の message を渡し、全件未満の `message-row` だけが出ることを確認する。
  - static render で artifact toggle 対象の key と表示断片を確認する。

### Slice Green-2: 追従、未読、末尾移動を windowing と整合させる

- 目的: `App.tsx` が持つ `messageListRef`、`isMessageListFollowing`、`hasMessageListUnread`、`messageListScrollSignature`、`handleMessageListScroll` を仮想化後も同じ意味で動かす。
- 依存: Slice Green-1
- 対象: `src/App.tsx`, `src/session-components.tsx`
- TDD mode: Green
- 受け入れ条件:
  - 追従中に `messageListScrollSignature` が変わると末尾へスクロールする。
  - 未追従中に新着が来ると `hasMessageListUnread` が true になり、未読バナーが表示される。
  - `onJumpToBottom` で末尾へ復帰し、未読状態が解除される。
  - viewport state は `scrollTop` と `clientHeight` を保持し、window 計算へ渡される。
- targeted tests:
  - `scripts/tests/session-app-render.test.ts` の static render 健全性。
  - pure function 化できる scroll 判定があれば単体テストを追加する。
  - DOM 実スクロールは手動確認項目で担保する。

### Slice Green-3: スタイルとレイアウト副作用を抑える

- 目的: message-list 仮想化用の wrapper、spacer、items の CSS を追加し、既存 Markdown リストの `.message-list` と衝突しないようにする。
- 依存: Slice Green-1, Slice Green-2
- 対象: `src/styles.css`
- TDD mode: Green
- 受け入れ条件:
  - `.message-list-window`、`.message-list-spacer`、`.message-list-window-items` など message column 専用 class を使う。
  - `message-follow-banner` の sticky 表示が仮想化 wrapper 内でも維持される。
  - Markdown 内リスト表示の既存 snapshot/文字列検証に副作用がない。
- targeted tests:
  - `node --test scripts/tests/message-rich-text.test.ts`
  - static render で `message-follow-banner` と window wrapper class を確認する。

### Slice Review-1: 統合検証と手動確認

- 目的: build/test と手動確認で仮想化の回帰リスクを潰す。
- 依存: Slice Green-1, Green-2, Green-3
- 対象: 変更全体
- TDD mode: Review
- 受け入れ条件:
  - `npm test` または既存の該当 test command が成功する。
  - `npm run build` が成功する。
  - 大量履歴、末尾追従、追従解除、新着未読、artifact 展開、diff open、live approval/elicitation の手動確認が完了している。
- targeted tests:
  - `node --test scripts/tests/virtual-list.test.ts`
  - `node --test scripts/tests/session-app-render.test.ts`
  - `node --test scripts/tests/message-rich-text.test.ts`
  - 追加した message-list virtualization test
  - `npm run build`

## Affected Files

- `src/App.tsx`
- `src/session-components.tsx`
- `src/styles.css`
- `src/virtual-list.ts`
- `scripts/tests/virtual-list.test.ts`
- `scripts/tests/session-app-render.test.ts`
- `scripts/tests/message-rich-text.test.ts`
- 追加または拡張する `scripts/tests/*message-list*virtualization*.test.ts`

## Risks

- `artifactKey` が index 依存のため、append-only でない履歴再構成では展開状態が別メッセージへずれる可能性が残る。
- 固定推定行高のため、artifact や approval card が大きい場合に scrollbar の体感位置と実表示がずれる可能性がある。
- `messageListScrollSignature` と viewport 更新が相互に再描画を誘発し、追従状態が不安定になる可能性がある。
- `.message-list` class が Markdown 内部にも使われるため、CSS セレクタの広げすぎで表示崩れが起きる可能性がある。

## Validation Strategy

- pure function test で virtual window の境界を固定する。
- `renderToStaticMarkup` で大量 messages の windowing、未読バナー、artifact/pending/live UI の表示断片を確認する。
- build/test で型、bundle、既存描画テストの回帰を確認する。
- DOM 実スクロールは harness を追加せず、手動確認項目として記録する。

## Completion Criteria

- message-list が全件 DOM 描画ではなく windowed DOM 描画になる。
- 追従、未読、末尾移動、artifact 展開、diff、pending/live UI が既存挙動を維持する。
- 対象テストと build が成功する。
- 手動確認結果が `result.md` に記録される。
- `questions.md` が `質問なし` または `確認済み` である。

## Archive Readiness

- archive destination: `docs/plans/archive/2026/04/20260429-message-list-virtualization/`
- archive 前チェック:
  - `result.md` が完了状態である。
  - `worklog.md` に主要チェックポイントとコミット対応が記録されている。
  - `questions.md` の status が `質問なし` または `確認済み` である。
  - 未完了 follow-up が `result.md` に残っている。

## Follow-up Candidates

- `Message` への安定 id 追加と `artifactKey` の index 依存解消。
- 可変行高の実測 virtualizer 導入。
- DOM client test harness 導入。
- 大量履歴 fixture を使ったスクロール追従 E2E 検証。
