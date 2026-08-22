# 20260820 Home Session Pagination

## Scope

- Home の Session summary 初期取得、検索、追加ページ取得、更新通知を bounded query に移行する。
- V6 storage、Main query / IPC / preload、Home subscription / projection、既存 summary consumer の契約を同じ論理変更で整合させる。
- Session detail、message、artifact は一覧取得へ混ぜない。
- 既存DBに migration を追加せず、現行の `last_active_at` と `id` を使う keyset pagination を第一候補とする。ただし、対象 storage version と index の適用範囲は確認後に確定する。

## Contract Closure Plan

- Invariant ID: `HOME_SESSION_SUMMARY_PAGE_V1`
- Accepted contract / exact anchor:
  - ユーザー要求: Home 初期表示、一覧更新、検索は全 Session summary の一括 hydrate / 全配列 broadcast に比例させない。
  - ユーザー要求: 初期表示は bounded summary page、detail/message/artifact は一覧へ混ぜない。
  - ユーザー要求: `lastActiveAt DESC` と stable tie-breaker により pagination の重複・欠落を防ぐ。
  - `docs/design/data-loading-performance-audit.md`: summary/detail 境界と Home summary-first の方針。
  - `docs/design/electron-session-store.md`: Main Process を persistence owner とし、Home 系 window と Session window の通知責務を分ける方針。
  - `docs/adr/004-launch-character-random-selection.md`: open Session の Character 除外と最近の Session 利用順を使う random selection の accepted behavior。
  - Executable contracts: `src/HomeApp.tsx`、`src/home/home-session-projection.ts`、`src/home/home-launch-state.ts`、`scripts/tests/home-*`、`scripts/tests/session-summary-subscription.test.ts`、`scripts/tests/window-broadcast-service.test.ts`。
- Scope / semantic owner: Session summary query の canonical owner を storage query / Main query service に置き、IPC parser/response、Home subscription、Home projection、broadcast facade を同じ契約へ接続する。Session detail query、Companion summary、Memory V6 entry query は別 owner として直接変更しない。
- Failure mode / consumer impact: 全件 hydrate、全配列 broadcast、loaded page だけの client filter、cursor 境界の重複・欠落、pinned/open Session の消失、random Character の履歴弱体化、削除・更新後の stale 表示、detail/message/artifact の一覧混入。
- State transitions / failure timing: 初回 page request → subscription invalidation / response loss → current query page refresh → create/update/pin/delete 後の page convergence。検索条件変更と cursor 更新は同一 query state の世代として扱い、古い response を反映しない。
- Direct verification: storage SQL の limit / cursor / search / tie-breaker、IPC request parser と bounded response、Home subscription の initial/update/error/cleanup、Home projection の page・pinned・open・search、create/update/delete/pin 通知、random Character の open/history source、typecheck、build、data-loading benchmark。
- Independent review trigger: storage・public IPC・cross-window broadcast の複合 interaction が targeted check だけで直接閉じない場合に限り、commit 済み clean source の targeted review を行う。
- Gate: ready（`HOME_SESSION_SUMMARY_PAGE_V1` と各 consumer 契約を統括確認済み）

## Current consumer and bottleneck map

- Home Dashboard の Recent Sessions は `listSessionSummaries()` で全 summary を受け、renderer で検索・pinned precedence・表示を行う。
- Home Session Monitor は同じ `HomeApp` の summary state と open Session Window ID を突き合わせるため、最新 page にいない open Session を別経路で維持する必要がある。
- Settings window は同じ `HomeApp` entry の session summary subscription を起動し、session cleanup 後に summary refresh を要求する。
- Memory V6 Review window は Session summary を表示しないが、現在の `HomeApp` 初期化では同じ summary subscription が起動するため、不要な取得経路として確認対象に含める。
- New Session / Companion の random Character selection は、summary の最近順と open Session の Character ID を使う。page だけを渡すと accepted behavior を弱体化する。
- Mate profile / avatar 更新 handler は Home data hydrate の一部として全 session summary を再取得する。
- Main の persistent-store initialize / persistence facade / query helper は内部 cache の再構築に全 summary を使う。Home public query と同じ owner に混ぜず、runtime の detail hydration 要件を確認する。
- `MainBroadcastFacade` は現在、更新のたびに全 summary を読み、Home 系 window へ全配列を送る。Session window には既存の ID invalidation を送る。

## Contract decisions confirmed

1. Cursor: versioned opaque keyset cursor。`last_active_at DESC, id DESC` と query fingerprint を内部に持ち、最大512文字。
2. Pinned/open synthesis: recent page と bounded special entry をID dedupeして合成。recent/pinnedは50件、openは100 ID単位でchunkし、pinnedの続きはcursorで取得する。
3. Search owner: query textをstorage SQL / Main query serviceへ渡し、全Sessionを検索対象にしたmatching pageを返す。正規化後120文字、raw inputもparserでboundedにする。
4. Update notification: `scope: "ids"`（最大256件）または `scope: "all"` をHomeとSessionへ配信し、超過時は切り捨てずallへ切り替える。
5. Random Character: rendererへ全summaryを戻さず、default SessionのCharacterごとの最新利用順位を返す専用projectionとopen ID chunk queryをstorage ownerに追加する。

## Migration and verification

- schema version を変更しない場合、migration は不要。ただし V2/V3/legacy storage の bounded query parity と既存 index を direct check する。
- response の `limit`、cursor、query、ID list、broadcast ID list は parser / owner boundary で上限を固定する。
- Home の UI は page state と query state を分離し、古い response が新しい検索結果へ戻らないことを検証する。
- benchmark は現行 baseline と変更後の first page / search / update refresh を同じ synthetic data で比較し、full summary count を response に含めないことを確認する。

## Read-only baseline (2026-08-20)

- `npx tsx scripts/benchmark-data-loading.ts --profile small`: 10 Session、200 message、`listSessionSummaries` 0.334 ms。
- `npx tsx scripts/benchmark-data-loading.ts --profile medium`: 80 Session、9,600 message、2,000 audit log、`listSessionSummaries` 1.393 ms。
- 現行 benchmark は V2 の全 summary list と detail / audit path を計測するが、V6、search query、Home page refresh、broadcast payload size は計測しない。変更後に追加する直接検証が必要。
- 既存 targeted test は 70 pass / 1 fail。`home-session-projection.test.ts` は実行環境に `react` package が未導入のため module resolution error で開始できず、変更由来ではない validation gap として扱う。他の storage / subscription / launch / broadcast / preload test は通過した。

## Accepted contract (2026-08-20)

- Cursor は versioned opaque keyset cursor とする。内部には `last_active_at`、`id`、正規化済み query fingerprint を持ち、最大長は 512 文字。SQL の順序と境界条件は `last_active_at DESC, id DESC` で統一し、decode失敗・version不一致・query不一致は validation error とする。
- recent page は最大 50 件。pinned special entry は page ごと最大 50 件とし、全体を暗黙に切り捨てず `pinnedNextCursor` / `hasMore` で追加取得できるようにする。open Session ID は request / chunk ごと最大 100 件とし、超過分は chunk で全件反映する。recent / pinned / open は同一 summary projection と search 条件を使い、Session IDでdedupeする。
- Search owner は storage query。対象は既存 Home search と同じ `taskTitle`、`workspacePath`、`workspaceLabel`、Session kind label。trim / case normalizationを維持し、`%`、`_`、escape文字はliteralとして扱う。queryは正規化後120文字、raw inputにもbounded parserを置く。
- Update notification は既存の `sessionIds[]` invalidation を Home系へ広げる。ただし payload は `scope: "ids"`（重複除去済み最大256件）または `scope: "all"` とし、超過・正確な列挙不能時にIDを切り捨てず `all` へ切り替える。Home / Session は scopeに応じて bounded refresh / detail再hydrateする。
- query変更、create、update、pin、delete、invalidationでは cursor chain を破棄して先頭 pageから新しい generation を開始する。rendererは request generation を保持し、古い response を反映しない。page取得中に通知が来た場合は response後に再取得して収束させる。
- random Character は rendererへ全 `SessionSummary[]` を戻さず、`sessionKind === "default"` の Characterごとの最新利用順位を再現する最小 projectionと、open Session ID chunk queryをstorage ownerから取得する。loading / error / 成功後0件の区別とADR 004の抽選規則を維持する。
- Home public query は現行runtimeで使用するV6 storageとMain query serviceをcanonical ownerとする。V2/V3/legacyは現行runtimeの同じpublic interfaceを実際に通る場合だけ parity adapterを追加し、内部 migration / benchmark用途には未使用adapterを増やさない。runtime初期化・cache再構築の全summary経路は内部用途として残す。
- Home Dashboard / Monitorだけが必要な summary queryを購読し、Memory Reviewは起動しない。Settingsは常設subscriptionを持たず、cleanup完了後のinvalidationまたはbounded refreshを使う。Mate profile / avatar更新後もcurrent pageとspecial entryだけをrefreshする。
- `HOME_SESSION_SUMMARY_PAGE_V1` の Full-review gate は `run`。実装commit後、cleanなcommit-bound review targetでcomplete-diff holistic reviewを1回実施し、finding修正は同じInvariant familyへ限定してtargeted closureする。

## Gate

- Contract Closure: ready
- Test Design: ready（各failure modeの直接observableを実装前に固定済み）
- Migration: schema version変更なしを前提に進める。V6既存複合順序indexを利用し、V2/V3/legacy parityは現行runtime consumerに到達する場合だけ確認する。

## Implementation result

- `SessionStorageV6` を canonical owner とし、V2/V3/legacy storageにも同じ bounded query interfaceを実装した。recent / pinned / openを `last_active_at DESC, id DESC` のkeyset queryで取得し、summary projectionだけを返す。既存のfull summary readはruntime初期化・persistence内部経路に残した。
- public IPC / preload は `listSessionSummaryPage` と `listSessionCharacterUsage`へ移行した。scope、limit、query、cursor、open Session IDをparserで検証し、recent / pinnedは50件、openは100件、normalized queryは120文字、raw queryは512文字、cursorは512文字、invalidation IDは256件に制限した。
- Homeはrecent / pinnedの先頭pageとopen Sessionの100件chunkをstorageへ問い合わせ、Session IDでdedupeして合成する。pinnedの追加pageとrecentの追加pageはopaque cursorで取得し、query generationで古いresponseを反映しない。検索はstorage側で全Sessionを対象にし、renderer側のfilterは表示projectionの既存整合用に残した。
- random Characterは全summaryを履歴用途へ渡さず、default SessionのCharacterごとの最新利用順位projectionと、全open Session IDのchunk queryを使う。Memory Reviewはsummary query / subscriptionを起動せず、Settingsは常設subscriptionを持たず明示的なbounded refreshだけを使う。
- summary更新broadcastは全配列hydrateを廃止し、`{ scope: "ids", sessionIds }` または `{ scope: "all" }` のinvalidationへ収束した。256件超過・正確な列挙不能時はallへ切り替える。open Session Window ID broadcastも100件超過時はallとし、receiverが100件pageを全chunk取得する。
- ADR 004、data-loading audit、Electron session store、provider adapterの設計記述をbounded query / invalidation / Character usage projectionへ更新した。schema versionとmigrationは変更していない。

## Validation result (pre-commit)

- Targeted checks: storage V2/V3/legacy/V6、summary parser / cursor、Home summary query、window ID page、IPC / preload、Main query、broadcast、subscription、launchを含む129 tests pass / 0 fail。
- `npm run typecheck`: pass。
- `npm run build`: pass。既存のLightningCSS `::highlight` warningとlarge chunk warningは継続している。
- `npm test`: 2,553 pass / 1 fail / 1 skipped。唯一のfailureは既存の `scripts/tests/withmate-memory-mcp-integration.test.ts` の配布artifact assertion（expected `undefined`、actual `true`）で、変更対象のSession経路とは無関係。
- `npx tsx scripts/benchmark-data-loading.ts --profile small`: 10 Sessionでfull summary 0.335 ms、bounded first page 0.458 ms、search page 0.271 ms、Character usage 0.149 ms。
- `npx tsx scripts/benchmark-data-loading.ts --profile medium`: 80 Session / 9,600 message / 2,000 audit logでfull summary 0.914 ms、bounded first page 0.962 ms、search page 0.531 ms、Character usage 0.154 ms。
- `npx tsx scripts/benchmark-data-loading.ts --sessions 1000 --messages 1 --audit-logs 1 --operations 1 --raw-items 1 --artifact-every 2`: full summary 7.46 msに対しbounded first page 0.874 ms、search page 2.588 ms、Character usage 0.501 ms。bounded response件数は50件だった。
- `git diff --check`: pass。`npm run benchmark:data-loading -- --profile ...` はこのnpm環境で`--profile`がnpm configとして解釈されるため、同じscriptを`npx tsx`で直接実行した。

## Commit and review gate

- pre-commitのtargeted check / typecheck / build / benchmarkを完了後、対象pathだけをstageしてtask branchへ通常commitする。
- commit後はcommit OIDに固定したclean detached worktreeをSessionFolder配下へ作り、`HOME_SESSION_SUMMARY_PAGE_V1` のcomplete-diff holistic reviewを1回実施する。findingがあれば同じInvariant familyだけを修正し、current commit上のdirect checkで閉じる。
- review targetのcleanlinessまたはreviewer availabilityを満たせない場合は、full-review gateをvalidation gapとして完了報告へ残す。

## Post-commit review status (2026-08-20)

- 実装commitは `328753559838753b2fc7c6fc0bc7dee4771de75a`（`perf(home): Home Session一覧をbounded queryへ移行`）。commit後の同OIDで targeted 129 tests、`npm run typecheck`、`npm run build`、1,000 Session benchmarkを再実行し、いずれも成功した。
- commit-bound review targetは `HEAD`、base ancestry、tracked / untracked cleanlinessを確認できる状態まで準備した。Windowsの既存archive長過ぎpathは変更差分外のため、レビューtargetではskip-worktreeとして除外し、変更48ファイルと関連設計文書はmaterializeした。
- Full-review gateは reviewer availability のため実質レビュー未完了となった。blocking findingの有無は未判定であり、complete-diff holistic review未実施をvalidation gapとして残す。レビュー未実施を理由にsourceの追加変更やfinding修正は行っていない。
- 残る主なリスクは、bounded responseを返しても `%query%` のSQL部分一致検索自体はSession件数に比例し得ること、およびholistic review未実施であること。前者は今回のsynthetic benchmarkでfirst page / search latencyを計測済みだが、FTS導入の要否は別変更として扱う。

## Review finding closure (2026-08-21)

- commit-bound complete-diff reviewで、表示検索がopen Session summaryにも適用されてrandom Character除外を弱める問題と、検索・open ID変更後のdebounce中に旧responseが反映され得る問題をblocking findingとして確認した。
- open Session summaryは表示検索から分離して全件を100 IDずつ取得し、表示時のrenderer projectionだけへ検索を適用する。これによりMonitorとrandom Character除外は検索状態に依存しない。
- query textとopen Session ID集合からquery keyを作り、query key変更時に旧request tokenを即時失効させる。cursor/page stateはlayout effectで破棄し、debounced refreshの旧responseを適用しない。
- reviewで挙がった100件超のopen Window ID取得中の集合変化は、offset paginationをSession ID keyset cursorへ変更して閉じた。前pageのIDが閉じても後続IDを欠落させないtestを追加した。
- finding familyのtargeted 143 tests、`npm run typecheck`、`npm run build`は成功した。既存のLightningCSS warningとlarge chunk warningは継続している。

## Review finding closure (2026-08-22)

- 参照された `9fdab775` ではなく、task branchの現行tip `1dad4366`を正本として確認した。checkout、reset、rebaseは行っていない。
- Finding 1は `HomeSessionSummary` / `HomeSessionSummaryPageResult` を公開page contractのcanonical typeとし、Home consumer、Main query、IPC dependency / registration、window API、V1/V2/V3/V6 storageのpage経路を同じ型へ揃えた。各page SQLはHome表示に必要な列とkeyset cursor用の `last_active_at` だけを明示し、V6のruntime policy / Character snapshotも必要なJSON pathだけを抽出する。既存の `listSessionSummaries()` とdetail取得の広いprojectionは内部用途として残した。
- Finding 2は `open` requestの重複除去後ID数より小さい `limit` をparserで拒否し、storage側でも `open` pageが `hasMore: true` / cursorなしを返さない不変条件を保持した。Homeは引き続き100 ID単位でchunk取得する。
- 回帰確認はV1/V2/V3/V6 storage、Main query、Home query、parserを含む targeted 77 tests、`npm run typecheck`、`npm test`（2603 pass / 0 fail / 1 skipped）、`npm run build`、bounded benchmark（1000 Sessionでpage 50件）で実施した。buildに既存のLightningCSS `::highlight` warningとlarge chunk warningがあるが、終了コードは0だった。
- これは既存 `HOME_SESSION_SUMMARY_PAGE_V1` のfinding family修正なので、complete-diff holistic reviewは再実行せず、直接検証とfinding family限定のtargeted closureで閉じる。
