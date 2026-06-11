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
- PR-03: additional directory list の add/remove operation。
- PR-04: runtime option update handler の共通 contract。

進行中:

- PR-05: send / run lifecycle の共通化 slice を整理中。
- PR-06: init / refresh 境界の共通化 slice を着手。
- PR-08: Auxiliary path の小さい共通化 slice を着手。

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
- 2026-06-07: PR-04 着手。通常 Session / Companion の approval / sandbox session patch 構築を `runtime-option-state` に集約。provider / running / read-only guard、`updatedAt` 生成、persist API、MateTalk local runtime state、model / reasoning fallback は surface 側に残した。
- 2026-06-07: 通常 Session / Companion の model / reasoning effort session patch 構築を `runtime-option-state` に集約。model catalog selection と fallback/validation 契約は既存 `model-catalog` helper に委譲し、Auxiliary runtime option save queue と MateTalk local runtime state は未変更。
- 2026-06-07: MateTalk の approval / sandbox option fallback を `resolveRuntimeOptionValue` に集約。approval は空 options なら default、sandbox は候補がある場合だけ補正する既存 effect 境界を維持し、送信 payload と local runtime state 自体は未変更。
- 2026-06-07: App / CompanionReview の Auxiliary model / reasoning effort patch 構築を `auxiliary-session-state` に集約。`runGuardedAuxiliarySessionUpdate`、保存 queue、active session guard、timestamp 生成は呼び出し側に残し、model catalog fallback/validation は既存 helper に委譲。
- 2026-06-07: App / CompanionReview の Auxiliary approval / sandbox patch 構築を `auxiliary-session-state` に集約。`runGuardedAuxiliarySessionUpdate`、保存 queue、active session guard、timestamp 生成は呼び出し側に残し、PR-04 runtime option update handler slice を完了扱いに変更。
- 2026-06-07: PR-05 着手。MateTalk 送信前の空入力 / 送信中 / trim 済み本文判定を `resolveMateTalkSubmitPreflight` に集約。provider 実行、turn controller、stale guard、error append、action dock 更新は未変更。`scripts/tests/mate-talk-state.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-07: App / Companion の optimistic running session と pending live run updater 作成を `buildOptimisticSessionRunUpdate` に集約。provider 実行、preview/sendability、draft clear、success/failure rollback は呼び出し側に残した。`scripts/tests/session-live-run-state.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-07: App / Companion の preview 後 sendability blocked message 解決を `getComposerSendBlockedMessage` に集約。preview API、sendability 計算、provider 実行、rollback は未変更。`scripts/tests/session-composer-feedback.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-07: MateTalk turn payload 構築を `buildMateTalkTurnInput` に集約。input clear 前の attachment / additional directory / runtime option snapshot と sandbox option なし provider の payload 省略 contract を維持し、provider 実行と stale guard は未変更。`scripts/tests/mate-talk-state.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-08: MateTalk turn の user / assistant / error message 作成を `buildMateTalkUserMessage` / `buildMateTalkAssistantMessage` / `buildMateTalkErrorMessage` に集約。message id と Error fallback の contract を test で固定し、provider 実行と stale guard は未変更。`scripts/tests/mate-talk-state.test.ts`、`npm run typecheck` は成功。
- 2026-06-08: App / Companion の optimistic run 開始適用を `applyOptimisticSessionRunUpdate` に集約。pending live run updater 反映後に running session を反映する順序を test で固定し、provider 実行、success/failure rollback は呼び出し側に残した。`scripts/tests/session-live-run-state.test.ts`、`npm run typecheck` は成功。
- 2026-06-08: App / Companion の optimistic run 失敗時 rollback を `rollbackOptimisticSessionRunUpdate` に集約。live run clear 後に session restore を呼ぶ順序を test で固定し、draft restore、error logging、provider execution は呼び出し側に残した。`scripts/tests/session-live-run-state.test.ts`、`npm run typecheck` は成功。
- 2026-06-08: App / Companion の run success saved session 反映を `applyResolvedSessionRunUpdate` に集約。保存済み session の state 反映を共通 helper に通し、Companion の reloadSnapshot 後処理と provider execution は呼び出し側に残した。`scripts/tests/session-live-run-state.test.ts`、`npm run typecheck` は成功。
- 2026-06-08: MateTalk turn の stale result guard を `shouldApplyMateTalkTurnUpdate` に集約。success / error / finally の同一 latest-turn 判定を helper 経由にし、message append、sending clear、provider execution は未変更。`scripts/tests/mate-talk-state.test.ts`、`npm run typecheck` は成功。
- 2026-06-08: send-or-cancel の action 決定を `resolveAuxiliaryAwareSendOrCancelAction` に分離。Auxiliary cancel、Auxiliary send 優先、selected cancel、selected send の優先順を pure helper と test で固定し、App / Companion の呼び出し境界は未変更。`scripts/tests/chat-window-adapter.test.ts`、`npm run typecheck` は成功。
- 2026-06-08: App / Companion の preview 後 send preflight 判定を `resolveComposerSendPreflight` に集約。preview API、composer preview state 反映、provider 実行、optimistic run 適用は呼び出し側に残した。`scripts/tests/session-composer-feedback.test.ts`、`npm run typecheck` は成功。
- 2026-06-08: App / Companion の selected / Auxiliary cancel 対象 id 解決を `resolveRunningSessionCancelTargetId` に集約。cancel API 呼び出し、エラー表示、Companion の `turnRunning` を含む UI 側 running 判定は呼び出し側に残した。`scripts/tests/chat-window-adapter.test.ts`、`npm run typecheck` は成功。
- 2026-06-08: App / Companion の send / cancel / reload failure message 解決を `resolveSessionRunErrorMessage` に集約。error の出力先、fallback 文言、provider 実行、rollback ordering は呼び出し側に残した。`scripts/tests/session-live-run-state.test.ts`、`npm run typecheck` は成功。
- 2026-06-08: MateTalk の composer capability 合成を `buildMateTalkComposerCapabilityProps` に分離。static text chat runtime defaults と MateTalk 固有の custom agent / skill picker 非表示、collapse 可の contract を focused test で固定し、ChatWindow / provider 実行 / send lifecycle は未変更。
- 2026-06-08: Companion の selected cancel target 組み立てを `buildRunningSessionCancelTarget` に集約。`turnRunning=true` かつ session `runState` が running でない短い区間でも cancel 対象 id を維持する contract を test で固定し、cancel API 呼び出しと provider 実行は未変更。
- 2026-06-08: Companion の send 開始前 guard を `resolveSessionTurnStartPreflight` に集約。session / API 不在、operation running、turn running、session running、inactive、空白 message の blocked contract と trim 済み user message を focused test で固定し、preview API、optimistic update、provider 実行は未変更。
- 2026-06-08: App / Companion の selected session run state / running boolean 導出を `resolveSelectedSessionRunState` / `resolveSelectedSessionIsRunning` に集約。既存どおり session `runState` を live run fallback より優先し、Companion の `turnRunning` は running boolean に残す contract を test で固定。send / cancel / provider 実行は未変更。
- 2026-06-08: App の selected / Auxiliary cancel target 組み立ても `buildRunningSessionCancelTarget` 経由へ統一。Companion と同じ target-id 解決経路にそろえ、cancel API 呼び出し、error handling、provider 実行は未変更。
- 2026-06-08: App の compact ActionDock preview running 判定を direct session `runState` 参照から `selectedSessionRunState` 経由へ統一。live run fallback を含む selected session running 導出と表示をそろえ、send / cancel / provider 実行は未変更。
- 2026-06-08: Agent session projection の composer dock running 判定を direct session `runState` 参照から `isSelectedSessionRunning` input へ統一。live run fallback を含む running boolean を composer / compact dock に渡す contract を focused test で固定し、provider 実行と state 更新は未変更。
- 2026-06-08: App main composer / picker の running gate を direct session `runState` 参照から `selectedSessionRunState` 経由へ統一。picker close、composer disabled、sendability、blocked feedback の判定を live run fallback とそろえ、preview API と provider 実行は未変更。
- 2026-06-08: Companion projection の running input 名を `isSelectedSessionRunning` へ統一。Agent projection と同じ語彙にそろえ、message column / right pane / compact dock に selected session running boolean が渡る contract を focused test で固定し、provider 実行と state 更新は未変更。
- 2026-06-08: App / Companion の ActionDock expand 時 composer focus 判定を `shouldFocusComposerForActionDockExpand` に集約。running 中は focus しない contract を focused test で固定し、expand state と provider 実行は未変更。
- 2026-06-08: MateTalk submit preflight の running 入力名を `isRunning` に統一。local state の `sending` rename は別 slice に残し、空入力 / running blocked / trim 済み本文の contract と provider 実行は未変更。
- 2026-06-08: MateTalk projection の running 入力名を `isRunning` に統一。hook の local state `sending` は呼び出し側で adapter し、ChatWindow へ渡す running contract と rendering は未変更。
- 2026-06-08: MateTalk hook の local run flag を `isRunning` に統一。blocked reason の `sending` 文言は既存 contract として残し、turn controller、provider 実行、rendering は未変更。
- 2026-06-08: MateTalk submit preflight の blocked reason を `running` に統一。呼び出し側は empty reason だけを扱う既存挙動のまま、provider 実行と UI 表示は未変更。
- 2026-06-08: MateTalk turn 開始時の turn state / user message 作成を `beginMateTalkTurnSubmission` に集約。hook 側の running state 反映順、payload 作成、provider 実行、stale guard は未変更。
- 2026-06-08: MateTalk turn success / error message 反映前の stale 判定と message 作成を `resolveMateTalkAssistantTurnUpdate` / `resolveMateTalkErrorTurnUpdate` に集約。provider 実行、finally の running clear、message append 先は未変更。
- 2026-06-08: MateTalk turn finally の running clear 判定を `resolveMateTalkTurnFinalization` に集約。success / error update helper と同じ stale 判定語彙にそろえ、provider 実行と running state の更新先は未変更。
- 2026-06-08: App の actual send preflight に渡す run state を raw session `runState` から `selectedSessionRunState` に統一。Companion と同じ live run fallback 込みの判定にそろえ、preview API、optimistic update、provider 実行は未変更。
- 2026-06-08: App retry banner の表示種別 / 表示可否 / action disabled 判定に渡す run state を `selectedSessionRunState` へ統一。live run fallback を含む selected session running 導出と retry UI をそろえ、retry action 実行、provider 実行、保存は未変更。
- 2026-06-08: Companion retry banner の表示種別 / 表示可否判定に渡す run state も `selectedSessionRunState` へ統一。retry action disabled と同じ derived running 入力にそろえ、retry action 実行、provider 実行、保存は未変更。
- 2026-06-08: App Activity Monitor の表示中判定を raw session `runState` から `selectedSessionRunState` へ統一。live run fallback を含む running 判定で scroll / unread state を扱うようにし、audit log 読み込み、provider 実行、保存は未変更。
- 2026-06-08: App title edit 開始 gate を raw session `runState` から `selectedSessionRunState` へ統一。Companion の title edit と同じ derived running 判定にそろえ、title 保存、provider 実行、永続化 API は未変更。
- 2026-06-08: App delete session guard の running 判定を raw session `runState` から `selectedSessionRunState` へ統一。live run fallback 中も削除開始を抑止するようにし、confirm 表示、delete API、provider 実行は未変更。
- 2026-06-08: App approval / sandbox runtime option 変更 guard の running 判定を `selectedSessionRunState` へ統一。patch 構築、persist API、provider 実行、runtime option helper は未変更。
- 2026-06-10: App additional directory add/remove operation guard の running 判定を `selectedSessionRunState` へ統一。picker / remove operation、session patch、persist API は未変更。
- 2026-06-10: App pasted session attachment canPaste の selected session 側 running 判定を `selectedSessionRunState` へ統一。Auxiliary session 側の running 判定、save API、reference insertion、error handling は未変更。
- 2026-06-10: App message list / pending bubble scroll signature の selected session run-state 入力を `selectedSessionRunState` へ統一。Auxiliary session 側の run-state branch、scroll helper、message projection は未変更。
- 2026-06-10: App / Companion の selected session cancel operation を `runRunningSessionCancelOperation` に集約。cancel API 名、error 表示、Auxiliary cancel は surface 側に残し、target 解決と API 不在 no-op contract を helper test で固定。
- 2026-06-10: App / Companion の Auxiliary cancel operation も `runRunningSessionCancelOperation` に接続。cancel API 名と App 側 error 表示は surface 側に残し、runState running target の cancel contract を helper test で補強。
- 2026-06-10: PR-06 着手。App / Companion の active Auxiliary refresh load gate を `runActiveAuxiliarySessionRefreshOperation` に集約。active id 不一致では load せず、effect stale 時は result を捨て、refresh result の state 適用、App の error logging、Companion の silent catch、subscription / live-run API は surface 側に残した。`scripts/tests/auxiliary-session-refresh-operation.test.ts`、`scripts/tests/auxiliary-session-state.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Companion の closed Auxiliary sessions 初期 load operation を `runClosedAuxiliarySessionsLoadOperation` に集約。parent id 不在の skip、load 後 stale 抑止、load failure 時の empty fallback を helper contract にし、state 反映だけ surface 側に残した。`scripts/tests/auxiliary-session-refresh-operation.test.ts`、`scripts/tests/auxiliary-session-state.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Companion の active Auxiliary session 初期 load operation を `runActiveAuxiliarySessionLoadOperation` に集約。parent id 不在の skip、load 後 stale 抑止、load failure 時の null fallback を helper contract にし、state 反映だけ surface 側に残した。`scripts/tests/auxiliary-session-refresh-operation.test.ts`、`scripts/tests/auxiliary-session-state.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Companion の Companion session summaries 初期取得 + subscription を `startCompanionSessionSummariesSubscription` に集約。API 不在時 no-op cleanup、初回取得、購読更新、cleanup 後 stale 抑止を helper contract にし、state 反映だけ surface 側に残した。`scripts/tests/companion-session-summary-subscription.test.ts`、`scripts/tests/auxiliary-session-refresh-operation.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Companion の live session run 初期取得 + subscription を `startLiveSessionRunSubscription` に集約。no-api / no-session / merge-view guard は surface 側に残し、対象 session の reset、初回取得、購読更新、cleanup 後 stale 抑止、Auxiliary refresh callback 呼び出しを helper contract にした。review 指摘に合わせ、App / CompanionReview の caller-level guard が helper 呼び出し前に残ることも source-level test で固定した。`scripts/tests/session-live-run-subscription.test.ts`、`scripts/tests/companion-session-summary-subscription.test.ts`、`scripts/tests/auxiliary-session-refresh-operation.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Home の open CompanionReview window ids 初期取得 + subscription を `startOpenCompanionReviewWindowIdsSubscription` に集約。API 不在時 no-op cleanup、購読更新、初回 list、cleanup 後 stale 抑止、購読更新後の初回 list 上書き抑止を helper contract にした。`scripts/tests/open-companion-review-window-subscription.test.ts`、`scripts/tests/session-live-run-subscription.test.ts`、`scripts/tests/companion-session-summary-subscription.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Companion の provider quota telemetry 初期取得 + subscription を `startProviderQuotaTelemetrySubscription` に集約。API 不在、provider 不在、surface 側 disabled では null telemetry を反映し、初回取得、取得失敗 fallback、対象 provider の購読更新、cleanup 後 stale 抑止を helper contract にした。review 指摘に合わせ、App の Copilot provider 限定と CompanionReview の merge view 除外が caller 側に残ることも source-level test で固定した。`scripts/tests/session-telemetry-subscription.test.ts`、`scripts/tests/session-telemetry-state.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Companion の session context telemetry 初期取得 + subscription を `startSessionContextTelemetrySubscription` に集約。API 不在、session 不在、surface 側 disabled では null telemetry を反映し、初回取得、取得失敗 fallback、対象 session の購読更新、cleanup 後 stale 抑止を helper contract にした。App の Copilot provider 限定と CompanionReview の merge view 除外が caller 側に残ることも source-level test で固定した。`scripts/tests/session-telemetry-subscription.test.ts`、`scripts/tests/session-telemetry-state.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Companion の model catalog 初期取得を `startModelCatalogSubscription` に集約。App は購読更新あり、CompanionReview は merge view で disabled / 初期取得失敗時 null fallback の surface 差分を helper 引数に残した。review 指摘に合わせ、購読更新後に遅い初回取得が古い revision / null で上書きしない revision guard と focused test を追加。MateTalk は app settings / mate state 初期化と failure feedback が結合しているため別 slice に分離。`scripts/tests/model-catalog-subscription.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Home / MateTalk の app settings 初期取得 + subscription 反映を `startAppSettingsSubscription` に集約。review 指摘に合わせ、Home / MateTalk の結合初期化からも `getAppSettings()` を外して helper 配下へ移し、購読更新後に遅い初回取得 result / failure fallback が古い settings を復活させない guard と focused test を追加。Home / MateTalk の model catalog / mate state 初期化と failure feedback は維持。`scripts/tests/app-settings-subscription.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: Home / MateTalk の model catalog 初期取得 + subscription 反映も `startModelCatalogSubscription` に接続。結合初期化から `getModelCatalog(null)` を外し、購読更新後に遅い初回 catalog result / null / failure fallback が古い状態や不要な feedback を復活させない guard を全 surface へ適用した。Home / MateTalk の mate state / embedding / growth 初期化は維持。`scripts/tests/model-catalog-subscription.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: Home の session summaries / companion session summaries 初期取得 + subscription 反映を `startSessionSummariesSubscription` / `startCompanionSessionSummariesSubscription` に集約。Mate 未作成時に一覧を読み込まない旧境界は維持しつつ、購読更新後に遅い初回取得 result / failure fallback が古い一覧や不要な feedback を復活させない guard を helper contract にした。`scripts/tests/session-summary-subscription.test.ts`、`scripts/tests/companion-session-summary-subscription.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: Home / MateTalk の mate state + profile 初期取得を `loadMateStatusSnapshot` に集約。`not_created` では profile を読まない、state/profile 取得後に inactive なら stale とし、さらに caller 側でも ready result 適用直前に active を再確認して UI state へ古い結果を反映しない contract にした。Home の `refreshMateStatus` と MateTalk 初期化を同じ loader 経由にし、review 指摘に合わせて caller-level guard の focused test も追加。`scripts/tests/mate-status-load-operation.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: PR-07 着手。App / Companion / MateTalk の main composer draft change UI state 反映を `applyComposerDraftChangeCommand` に集約。feedback clear、draft、caret、main caret mirror の順序を helper contract にし、Auxiliary draft save、path insertion、send execution、draft persistence storage は未変更。`scripts/tests/composer-draft-handlers.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: MateTalk の submit preflight を `resolveTextComposerSubmitPreflight` 経由へ移行。空入力 / running / trim 済み本文の contract を App / Companion が使う `session-composer-feedback` 側に置き、MateTalk 固有の空入力 feedback 文言だけ wrapper 引数に残した。provider 実行、turn lifecycle、draft clear、runtime option は未変更。`scripts/tests/session-composer-feedback.test.ts`、`scripts/tests/mate-talk-state.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Companion / MateTalk の送信開始後の main draft clear を `applyComposerDraftClearCommand` に集約。App / Companion の draft only clear と MateTalk の caret reset 付き clear を同じ command の optional caret 引数で表現し、MateTalk の path reference clear、rollback restore、Auxiliary draft は未変更。`scripts/tests/composer-draft-handlers.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Companion の session 切替時 main composer draft reset を `applyComposerDraftClearCommand` 経由へ移行。App は main caret mirror も helper 引数で同期し、Companion は composer caret reset だけを適用する形で、preview reset、picker base directory、workspace path match state、IME state、Auxiliary draft は未変更。`scripts/tests/composer-draft-handlers.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Companion の main Skill prompt 挿入後 draft apply を `applyComposerDraftChangeCommand` 経由へ移行。Skill prompt handler 側で caret UI state は先に反映済みのため、command の caret setter を optional にして App は main caret mirror だけ同期、Companion は draft 反映だけを行う contract にした。Auxiliary skill selection、focus/caret 復元、provider 分岐、保存境界は未変更。`scripts/tests/composer-draft-handlers.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-10: App / Companion / MateTalk の quote 挿入後 draft apply を `applyComposerDraftChangeCommand` 経由へ移行。App は main caret mirror、Companion は main composer branch、MateTalk は feedback clear 付き draft/caret 反映を同じ command で表現し、Auxiliary quote branch、workspace path match close、focus/caret 復元は未変更。`scripts/tests/composer-draft-handlers.test.ts`、`scripts/tests/session-shell-handlers.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-11: App / Companion / MateTalk の path reference 挿入後 draft apply を `applyComposerDraftChangeCommand` 経由へ移行。App は main caret mirror、Companion は main composer branch、MateTalk は feedback clear 付き draft/caret 反映を同じ command で表現し、Auxiliary draft save、picker / paste / session files 保存境界、path reference attachment 更新、workspace match state は未変更。`scripts/tests/composer-draft-handlers.test.ts`、`scripts/tests/session-shell-handlers.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-11: App / Companion / MateTalk の path reference 削除後 draft apply を `applyComposerDraftChangeCommand` 経由へ移行。App は main caret mirror、Companion は main composer branch、MateTalk は draft/caret 反映を同じ command で表現し、Auxiliary draft save、削除対象正規化、path reference attachment removal、workspace match state は未変更。`scripts/tests/composer-draft-handlers.test.ts`、`scripts/tests/session-shell-handlers.test.ts`、`scripts/tests/mate-talk-state.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-11: App / Companion の workspace path match 選択後 main draft apply を `applyComposerDraftChangeCommand` 経由へ移行。MateTalk は workspace path match なしのため対象外とし、App は main caret mirror、Companion は main composer branch を同じ command で表現。Auxiliary draft save、workspace match state、focus/caret 復元は未変更。`scripts/tests/composer-draft-handlers.test.ts`、`scripts/tests/session-shell-handlers.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-11: App / Companion が共用する retry draft restore command 内の draft / caret / main caret mirror 反映を `applyComposerDraftChangeCommand` 経由へ移行。retry banner 判定、draft replace confirmation、workspace match close、focus 復元、resend 経路は未変更。`scripts/tests/retry-state.test.ts`、`scripts/tests/composer-draft-handlers.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-11: App / Companion / MateTalk の IME composition end 後 caret 同期を `buildOnDraftSelectHandler` 経由へ移行し、MateTalk の app / projection / text chat composer props に composition handlers を接続。MateTalk submit shortcut は native composition と MateTalk composition ref の両方で抑止する contract に補強。selection fallback、draft 変更、IME start の責務は未変更。`scripts/tests/composer-draft-handlers.test.ts`、`scripts/tests/mate-talk-chat-projection.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-11: Companion の optimistic send 失敗時 draft restore を `applyComposerDraftChangeCommand` 経由へ移行。restore 条件、provider 実行、rollback live run clear、snapshot restore、error 表示は未変更。`scripts/tests/composer-draft-handlers.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-11: App / Companion の main composer sendability と forced blocked feedback の解決を `resolveComposerSendabilityState` に集約。Auxiliary sendability、MateTalk text submit preflight、preview API、provider 実行は未変更。`scripts/tests/session-composer-feedback.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-11: App / Companion の composer preview request 作成を `createComposerPreviewRequest` に集約。App と Auxiliary は session preview、Companion main は companion preview を使う contract とし、preview resolution の debounce/stale/error 処理、path reference preview、provider 実行は未変更。`scripts/tests/composer-preview-resolution.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-11: App / Companion の送信直前 composer preview request 作成も `createComposerPreviewRequest` 経由へ移行。App は session preview、Companion main は companion preview を使い、preview 結果の state 反映、send preflight、draft clear、provider 実行は未変更。`scripts/tests/composer-preview-resolution.test.ts`、`scripts/tests/session-composer-feedback.test.ts`、`npm run typecheck`、diff check は成功。
- 2026-06-11: Companion の Auxiliary cancel target 組み立てを `buildRunningSessionCancelTarget` 経由へ移行し、App の Auxiliary cancel と同じ `runRunningSessionCancelOperation` contract に揃えた。cancel API、error 表示、Auxiliary send/save、provider 実行は未変更。`scripts/tests/chat-window-adapter.test.ts`、`npm run typecheck`、diff check は成功。

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
- 通常 Session / Companion の approval / sandbox session patch 構築を `runtime-option-state` に集約。2026-06-07 着手。
- 通常 Session / Companion の model / reasoning effort session patch 構築を `runtime-option-state` に集約。2026-06-07 完了。
- MateTalk の approval / sandbox option fallback を `runtime-option-state` に集約。2026-06-07 完了。
- App / CompanionReview の Auxiliary model / reasoning effort patch 構築を `auxiliary-session-state` に集約。2026-06-07 完了。
- App / CompanionReview の Auxiliary approval / sandbox patch 構築を `auxiliary-session-state` に集約。2026-06-07 完了。

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
- MateTalk 送信 preflight を `mate-talk-state` に集約。2026-06-07 着手。
- App / Companion の optimistic running session と pending live run updater 作成を `session-live-run-state` に集約。2026-06-07 着手。
- App / Companion の sendability blocked message 解決を `session-composer-feedback` に集約。2026-06-07 着手。
- MateTalk turn payload 構築を `mate-talk-state` に集約。2026-06-07 着手。
- MateTalk turn message 作成を `mate-talk-state` に集約。2026-06-08 着手。
- App / Companion の optimistic run 開始適用を `session-live-run-state` に集約。2026-06-08 着手。
- App / Companion の optimistic run 失敗時 rollback を `session-live-run-state` に集約。2026-06-08 着手。
- App / Companion の run success saved session 反映を `session-live-run-state` に集約。2026-06-08 着手。
- MateTalk turn stale result guard を `mate-talk-state` に集約。2026-06-08 着手。
- send-or-cancel の action 決定を `send-or-cancel` に集約。2026-06-08 着手。
- App / Companion の preview 後 send preflight 判定を `session-composer-feedback` に集約。2026-06-08 着手。
- App / Companion の selected / Auxiliary cancel 対象 id 解決を `send-or-cancel` に集約。2026-06-08 着手。
- App / Companion の send / cancel / reload failure message 解決を `session-live-run-state` に集約。2026-06-08 着手。
- MateTalk の composer capability 合成を projection helper に集約。2026-06-08 着手。
- Companion の `turnRunning` を含む selected cancel target 組み立てを `send-or-cancel` に集約。2026-06-08 着手。
- Companion の send 開始前 guard を `session-live-run-state` に集約。2026-06-08 着手。
- App / Companion の selected session run state / running boolean 導出を `send-or-cancel` に集約。2026-06-08 着手。
- App の selected / Auxiliary cancel target 組み立てを `send-or-cancel` に集約。2026-06-08 着手。
- App の compact ActionDock preview running 判定を `selectedSessionRunState` 経由へ統一。2026-06-08 着手。
- Agent session projection の composer dock running 判定を `isSelectedSessionRunning` input 経由へ統一。2026-06-08 着手。
- App main composer / picker の running gate を `selectedSessionRunState` 経由へ統一。2026-06-08 着手。
- Companion projection の running input 名を `isSelectedSessionRunning` へ統一。2026-06-08 着手。
- App / Companion の ActionDock expand focus 判定を `action-dock-state` に集約。2026-06-08 着手。
- MateTalk submit preflight の running 入力名を `isRunning` へ統一。2026-06-08 着手。
- MateTalk projection の running 入力名を `isRunning` へ統一。2026-06-08 着手。
- MateTalk hook の local run flag を `isRunning` へ統一。2026-06-08 着手。
- MateTalk submit preflight の blocked reason を `running` へ統一。2026-06-08 着手。
- MateTalk turn 開始時の turn state / user message 作成を `mate-talk-state` に集約。2026-06-08 着手。
- MateTalk turn success / error update の stale 判定と message 作成を `mate-talk-state` に集約。2026-06-08 着手。
- MateTalk turn finally の running clear 判定を `mate-talk-state` に集約。2026-06-08 着手。
- App actual send preflight の run state 入力を `selectedSessionRunState` 経由へ統一。2026-06-08 着手。
- App retry banner / retry action disabled の run state 入力を `selectedSessionRunState` 経由へ統一。2026-06-08 着手。
- Companion retry banner の run state 入力を `selectedSessionRunState` 経由へ統一。2026-06-08 着手。
- App Activity Monitor の running 判定を `selectedSessionRunState` 経由へ統一。2026-06-08 着手。
- App title edit 開始 gate の running 判定を `selectedSessionRunState` 経由へ統一。2026-06-08 着手。
- App delete session guard の running 判定を `selectedSessionRunState` 経由へ統一。2026-06-08 着手。
- App approval / sandbox runtime option 変更 guard の running 判定を `selectedSessionRunState` 経由へ統一。2026-06-08 着手。
- App additional directory add/remove operation guard の running 判定を `selectedSessionRunState` 経由へ統一。2026-06-10 着手。
- App pasted session attachment canPaste の selected session 側 running 判定を `selectedSessionRunState` 経由へ統一。2026-06-10 着手。
- App message list / pending bubble scroll signature の selected session run-state 入力を `selectedSessionRunState` 経由へ統一。2026-06-10 着手。
- App / Companion の selected session cancel operation を `send-or-cancel` helper 経由へ統一。2026-06-10 着手。

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
- App / Companion の active Auxiliary refresh load gate を `auxiliary-session-refresh-operation` に集約。2026-06-10 着手。
- App / Companion の closed Auxiliary sessions 初期 load operation を `auxiliary-session-refresh-operation` に集約。2026-06-10 着手。
- App / Companion の active Auxiliary session 初期 load operation を `auxiliary-session-refresh-operation` に集約。2026-06-10 着手。
- App / Companion の Companion session summaries 初期取得 + subscription を `companion-session-summary-subscription` に集約。2026-06-10 着手。
- App / Companion の live session run 初期取得 + subscription を `session-live-run-subscription` に集約。2026-06-10 着手。
- App / Home の open CompanionReview window ids 初期取得 + subscription を `open-companion-review-window-subscription` に集約。2026-06-10 着手。
- App / Companion の provider quota telemetry 初期取得 + subscription を `session-telemetry-subscription` に集約。2026-06-10 着手。
- App / Companion の session context telemetry 初期取得 + subscription を `session-telemetry-subscription` に集約。2026-06-10 着手。
- App / Companion の model catalog 初期取得を `model-catalog-subscription` に集約。2026-06-10 着手。MateTalk の結合初期化は別 slice。
- App / Home / MateTalk の app settings 初期取得 + subscription 反映を `app-settings-subscription` に集約。2026-06-10 着手。
- Home / MateTalk の model catalog 初期取得 + subscription 反映も `model-catalog-subscription` に接続。2026-06-10 着手。
- Home の session summaries / companion session summaries 初期取得 + subscription 反映を `session-summary-subscription` / `companion-session-summary-subscription` に集約。2026-06-10 着手。
- Home / MateTalk の mate state + profile 初期取得を `mate-status-load-operation` に集約。2026-06-10 着手。

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
- App / Companion / MateTalk の main composer draft change UI state 反映を `composer-draft-handlers` に集約。2026-06-10 着手。
- MateTalk の submit preflight を `session-composer-feedback` の text composer primitive に接続。2026-06-10 着手。
- App / Companion / MateTalk の送信開始後 main draft clear を `composer-draft-handlers` に集約。2026-06-10 着手。
- App / Companion の session 切替時 main composer draft reset を `composer-draft-handlers` に接続。2026-06-10 着手。
- App / Companion の main Skill prompt 挿入後 draft apply を `composer-draft-handlers` に接続。2026-06-10 着手。
- App / Companion / MateTalk の quote 挿入後 draft apply を `composer-draft-handlers` に接続。2026-06-10 着手。
- App / Companion / MateTalk の path reference 挿入後 draft apply を `composer-draft-handlers` に接続。2026-06-11 着手。
- App / Companion / MateTalk の path reference 削除後 draft apply を `composer-draft-handlers` に接続。2026-06-11 着手。
- App / Companion の workspace path match 選択後 main draft apply を `composer-draft-handlers` に接続。2026-06-11 着手。
- App / Companion 共用の retry draft restore command を `composer-draft-handlers` に接続。2026-06-11 着手。
- App / Companion / MateTalk の IME composition end 後 caret 同期を draft select handler に接続。2026-06-11 着手。
- Companion の optimistic send 失敗時 draft restore を `composer-draft-handlers` に接続。2026-06-11 着手。
- App / Companion の main composer sendability と forced feedback 解決を `session-composer-feedback` に接続。2026-06-11 着手。
- App / Companion の composer preview request 作成を `use-composer-preview-resolution` に接続。2026-06-11 着手。
- App / Companion の送信直前 composer preview request 作成を `use-composer-preview-resolution` に接続。2026-06-11 着手。

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
- App / Companion の Auxiliary cancel operation を `send-or-cancel` helper 経由へ統一。2026-06-10 着手。
- Companion の Auxiliary cancel target 組み立ても `buildRunningSessionCancelTarget` に接続。2026-06-11 着手。

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
