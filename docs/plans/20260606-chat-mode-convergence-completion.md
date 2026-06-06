# Chat Mode Convergence Completion Plan

## Goal

Agent / Companion / MateTalk で別々に実装されている同じチャット機能を、仕様差分を adapter に残しながら共通実装へ寄せ切る。

## Scope

- 対象: composer、message actions、attachment/path reference、session files、additional directories、runtime options、send/run lifecycle、draft/refresh/Auxiliary 周辺。
- 非対象: UI 全面刷新、provider API 契約変更、永続化 schema / migration、packaging 変更。
- 方針: 1 PR で 1 つのリスク領域を完結させる。保存、非同期、clipboard/file 境界は単純 wrapper 化で済ませない。

## Current State

完了済み:

- 共通 chat projection / window props: `chat-window-adapter.ts`、`live-session-projection.tsx`、`live-session-window-props.tsx`、`session-chat-projection.tsx`、`companion-chat-projection.tsx`、`mate-talk-chat-projection.tsx`。
- message action primitive: copy / quote のテキスト正規化と挿入計算。
- shell handler factory: header/action dock/picker、title edit、composer submit key、workspace match selection、skill prompt insertion、session files open、path insertion/removal command。
- composer/path helpers: draft select/composition、paste collection、path preview/search、send-or-cancel routing。

進行中:

- PR-01: `createPathReferenceRemovalHandler` で App / CompanionReview / MateTalk の attachment path reference 削除 wrapper を共通化中。

## Progress Log

- 2026-06-07: `createPathReferenceRemovalHandler` を MateTalk にも適用。削除 command 前に candidates を正規化できる contract を追加し、MateTalk の draft 削除と path reference attachment list 更新の両方で正規化済み targets を維持。

## PR Plan

### PR-01: Interaction Handler Finish

対象:

- draft key / interaction handlers の残り。
- path reference removal の MateTalk 適用。2026-06-07 完了。
- quote / path / picker など、保存 API に触れない薄い wrapper の取り残し。

やらないこと:

- send flow、draft persistence、snapshot refresh、Auxiliary save。

検証:

- `scripts/tests/session-shell-handlers.test.ts`
- `scripts/tests/chat-window-adapter.test.ts`
- `npm run typecheck`

完了条件:

- Agent / Companion / MateTalk の同一 UI interaction が共通 helper または surface adapter 経由になり、surface 固有分岐だけが呼び出し側に残る。

### PR-02: Clipboard Paste And Session Attachment Boundary

対象:

- paste -> pasted file save -> session file reference insertion。
- App / Companion / MateTalk の precondition、sessionId、preventDefault、error handling の共通 contract。

やらないこと:

- additional directory persistence。
- send/run orchestration。

検証:

- `scripts/tests/composer-paste-handlers.test.ts`
- session shell / path insertion の focused tests。
- clipboard `files` と `items` の両経路、空 paste、save failure。

完了条件:

- 同じ clipboard input が 3 mode で同じ保存/挿入/失敗 contract を通る。

### PR-03: Additional Directory Operations

対象:

- additional directory add/remove の path 正規化、重複排除、list open state、remove state。
- App / Companion / MateTalk の mode 固有 persistence 境界を adapter 化。

やらないこと:

- draft persistence ordering。
- send lifecycle。
- runtime option state transition。

検証:

- additional directory operation tests。
- App / Companion / MateTalk の add/remove focused tests。
- `npm run typecheck`

完了条件:

- 3 mode が同じ directory operation contract を持ち、保存先だけ surface adapter で差し替わる。

### PR-04: Runtime Option Updates

対象:

- approval、model、reasoning effort、sandbox の update handler。
- App / Companion の persisted session update と MateTalk の local runtime state の差分を明示した共通 interface。

やらないこと:

- send execution。
- snapshot refresh。
- Auxiliary send/save。

検証:

- runtime option focused tests。
- model/reasoning fallback tests。
- 必要に応じて reload 後の persisted state 確認。

完了条件:

- runtime option の表示、変更、送信前参照が共通 contract で説明できる。

### PR-05: Send / Run Lifecycle

対象:

- Agent `sendMessage` / `handleSend`。
- Companion `sendCompanionTurn`。
- MateTalk turn flow。
- success / failure / cancel / stale result guard の共通 lifecycle。

やらないこと:

- draft persistence。
- Auxiliary 派生処理。
- init / refresh。

検証:

- success / failure / cancel / retry の focused tests。
- turn lifecycle の partial / complete / error tests。
- `npm run typecheck`

完了条件:

- 3 mode の send result と error rollback が同じ lifecycle primitive で扱われる。

### PR-06: Init / Fetch / Refresh

対象:

- initial fetch、refresh、subscription result の適用。
- projection sync、stale refresh guard、empty state。

やらないこと:

- send execution 本体。
- Auxiliary send/save。

検証:

- empty boot、existing session resume、refresh race の focused tests。
- `npm run typecheck`

完了条件:

- 初期化と再取得後に、古い state 復活、表示欠落、二重生成が起きない共通 contract になる。

### PR-07: Draft Persistence And Sendability

対象:

- draft 保存、dirty state、sendability 判定、typing 中 save ordering。
- App / Companion / MateTalk の draft storage 差分を adapter 化。

やらないこと:

- 新 schema。
- init/fetch 自体。

検証:

- typeahead、save debounce、連続送信、reload restore の focused tests。
- `npm run typecheck`

完了条件:

- draft の可視化、保存、送信可否が 3 mode で同じ ordering rule を持つ。

### PR-08: Auxiliary Path

対象:

- App / Companion の Auxiliary send、draft save、additional info、return-to-main 周辺。
- PR-05 / PR-07 の common lifecycle と接続。

やらないこと:

- MateTalk 主経路変更。
- provider API 契約変更。

検証:

- Auxiliary send/save focused tests。
- runtime option concurrent update tests。
- return-to-main / reload 後の storage consistency tests。

完了条件:

- App / Companion の Auxiliary path が共通 layer 経由になり、UI state と payload/storage が乖離しない。

## Risk Gates

- PR-01 は低リスク。Spark fast review で十分。
- PR-02 / PR-03 / PR-04 は中リスク。clipboard/file、persistence、runtime option の focused tests を必須にする。
- PR-05 以降は高リスク。非同期 ordering、stale result、rollback、reload を検証し、必要なら GPT-5.5 reviewer を使う。

## Completion Criteria

- Agent / Companion / MateTalk の同じ機能が、共通 helper / command / lifecycle primitive / adapter のいずれかに集約されている。
- surface 固有コードは provider、mode capability、保存先、文言、feature availability の差分だけを持つ。
- 各 PR の targeted tests と `npm run typecheck` が成功する。
- 最終 PR 後に full `npm test` または同等の統合検証結果を記録する。
