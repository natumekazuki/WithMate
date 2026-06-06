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
- PR-02: pasted session attachment の保存/挿入/失敗/no-op contract。

進行中:

- PR-03: additional directory list の add/remove operation を共通化中。

## Progress Log

- 2026-06-07: `createPathReferenceRemovalHandler` を MateTalk にも適用。削除 command 前に candidates を正規化できる contract を追加し、MateTalk の draft 削除と path reference attachment list 更新の両方で正規化済み targets を維持。
- 2026-06-07: MateTalk の quote message handler を `createQuoteMessageTextHandler` へ置換。sending 中 no-op、draft/caret 更新、feedback clear、focus/caret 復元の既存挙動は維持。
- 2026-06-07: PR-02 着手。App / CompanionReview / MateTalk の pasted session attachment handler を `createPastedSessionAttachmentHandler` に集約。surface 固有の paste 可否、sessionId、save API 取得、reference insertion だけを adapter 側に残し、clipboard `items` 経由の file paste も handler contract の test で固定。
- 2026-06-07: pasted session attachment 保存失敗時の notification contract を `createPastedSessionAttachmentHandler` に追加。App / CompanionReview は alert、MateTalk は feedback に接続し、保存失敗時は reference insertion しないことを test で固定。
- 2026-06-07: pasted session attachment の no-op 境界を補強。save API 未取得、session id 未取得では preventDefault / save / insertion を行わず、非 Error failure では fallback message を通知する contract を test で固定。未取得値は null / undefined の両方を covered。
- 2026-06-07: PR-03 着手。additional directory list の add/remove 純粋操作を `additional-directory-state` に集約し、MateTalk の local additional directories も同じ helper 経由へ置換。Windows separator 正規化、重複排除、削除判定を focused test で固定。
- 2026-06-07: additional directory list の比較 key を Windows drive / UNC path だけ case-insensitive、POSIX path は case-sensitive として補強。Windows の case 差、末尾 slash 差、drive root の重複/削除、POSIX の大小違い非 dedupe contract を focused test で固定。
- 2026-06-07: 通常 Session / Companion の additional directory add/remove session patch を `additional-directory-state` に集約。picker UI state、`updatedAt`、persist API は surface 側に残し、保存境界は変更しない形で App / CompanionReview の重複 patch 構築を置換。
- 2026-06-07: additional directory picker の base directory 解決を `resolveAdditionalDirectoryPickerBase` に集約。App / Companion / MateTalk / Auxiliary の優先順を共通 helper 経由にし、空文字は従来どおり fallback する contract を test で固定。
- 2026-06-07: additional directory add picker operation を `runPickedAdditionalDirectoryOperation` に集約。App / Companion / MateTalk の precondition、picker base 解決、cancel no-op、選択後 callback 呼び出しを共通化し、persist / local state / UI state 反映順は surface callback に残した。
- 2026-06-07: additional directory remove operation を `runAdditionalDirectoryRemovalOperation` に集約。App / Companion / MateTalk の remove guard、no-op 結果、削除 callback 呼び出しを共通化し、persist / local state 更新は surface callback に残した。

## PR Plan

### PR-01: Interaction Handler Finish

対象:

- draft key / interaction handlers の残り。
- path reference removal の MateTalk 適用。2026-06-07 完了。
- quote / path / picker など、保存 API に触れない薄い wrapper の取り残し。MateTalk quote handler は 2026-06-07 完了。

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
- pasted session attachment handler の共通 wrapper 化。2026-06-07 着手、App / CompanionReview / MateTalk への適用完了。
- pasted session attachment 保存失敗時の通知と no-insertion contract。2026-06-07 完了。
- save API / session id 未取得時の no-op と fallback failure message contract。2026-06-07 完了。未取得値は null / undefined の両方を covered。

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
- additional directory list の add/remove 純粋操作を `additional-directory-state` に集約。2026-06-07 着手、MateTalk local list への適用完了。
- additional directory list の comparison key を Windows drive / UNC path は case-insensitive、POSIX path は case-sensitive として補強。2026-06-07 完了。
- 通常 Session / Companion の persisted session patch 構築を `additional-directory-state` に集約。2026-06-07 完了。
- additional directory picker base directory 解決を `additional-directory-state` に集約。2026-06-07 完了。
- additional directory add picker operation を `additional-directory-state` に集約。2026-06-07 完了。
- additional directory remove operation を `additional-directory-state` に集約。2026-06-07 完了。

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
