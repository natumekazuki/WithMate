# Home Session pagination移植計画

## 目的

`feat/v6.3.25`で実装済みのHome Session一覧のbounded query、順次読み込み、stale response防止、再取得時のloaded page維持を、`feat/v6.4.0`の現行責務へ一つの論理変更として移植する。

枝全体またはmerge commitは取り込まない。`feat/v6.4.0`を正本とし、source commitからaccepted behaviorだけを責務単位で統合する。

## 固定するsource state

- target branch: `perf/v6.4.0-home-session-pagination`
- target base: `d63f88c9871933d2e1da5f4d93a926c037aed55c`
- source branch: `feat/v6.3.25`
- 参照するsemantic commit:
  - `328753559838753b2fc7c6fc0bc7dee4771de75a`
  - `672a0ecb24cffcc918600aa55b73e04a8d51f7f9`
  - `6d4acc842e25ce71134a569e171a5a7b55bec07c`
  - `672cba28d3de52714a0d4f4f12b6df2f427a782a`
- cherry-pickしないmerge commit:
  - `90513b0aab26dcaed34b9a985f85f7622e5385c5`
  - `d59a05b9eadfe77dac6cf0b2cd753142a1407d54`

source branchが進んでも、上記4 commitの挙動を移植対象とする。別の変更が必要になった場合は、同じaccepted contractに属する根拠を確認してからscopeへ加える。

## Accepted contract

- Homeの初回表示はSession全件をrendererへ送らず、boundedなsummary pageだけを取得する。
- pageは安定したcursorで続きから取得し、同一Sessionを重複表示しない。
- pinned、recent、openの既存表示意味と優先順位を維持する。
- open中のSessionはrecent pageの範囲外でもHomeから失われない。
- 一覧末尾への接近を`IntersectionObserver`で検出し、`hasMore`の場合だけ次pageを取得する。
- 同一scopeの追加取得を重複実行せず、終端後は取得しない。
- 検索条件またはquery generation変更前のresponseを現在stateへ適用しない。
- background refreshでは読み込み済みpage数を再取得し、先頭1pageへ巻き戻さない。
- background refreshで既存scroll位置を不必要に移動させない。
- load more失敗時は既存一覧を保持し、loadingを解除して再試行可能にする。
- `hasMore`、`nextCursor`、request cursorを一つのpage contractとして整合させる。
- 不正なcursor、limit、scopeを共有validatorまたはpublic IPC境界で拒否する。
- summary queryからHome一覧に不要なSession detailやprovider情報を返さない。
- unboundedな旧一覧取得をfallbackとして残さない。

## Invariant closure

### HOME-PAGE-01: bounded summary page

- Accepted anchor and meaning: Home一覧はsummary-onlyのbounded pageを取得し、全Session detailをhydrateしない。
- Canonical owner: summary request／cursor／resultの共有型とvalidator、storage query、main query service、IPC／preload projection。
- Siblings in scope: scope、search、limit、cursor、open Session補完、`hasMore`、`nextCursor`。
- Failure points: 不正入力の内部到達、unbounded fallback、page境界の重複または欠落、private detailのprojection。
- Direct checks: validator、storage/query、query service、IPC registration、preload、window typeのcontract test。
- Independent review trigger: public IPC、storage query、renderer stateの組合せをtargeted checkだけで閉じられない場合。
- Gate: ready。

### HOME-PAGE-02: renderer page state

- Accepted anchor and meaning: initial load、load more、search reset、background refreshは同じpage collectionを操作し、pinned／recent／openの表示意味を維持する。
- Canonical owner: `src/home/home-session-summary-query.ts`と`src/HomeApp.tsx`のHome固有state transition。
- Siblings in scope: page merge、重複排除、open Session補完、loaded page数を維持したrefresh、load more failure。
- Failure points: refresh時の1page巻き戻り、page外のopen Session欠落、failure時の既存一覧消失、scroll reset。
- Direct checks: Home query state testとcomponent／integration test。
- Independent review trigger: storageのcursor順とrenderer merge順を直接testで結合できない場合。
- Gate: ready。

### HOME-PAGE-03: async generation

- Accepted anchor and meaning: request開始時のscopeとgenerationが変わったresponseは現在stateへ適用しない。
- Canonical owner: `src/home/home-session-query-generation.ts`とHome query orchestration。
- Siblings in scope: initial load、search、load more、background refresh、失敗後retry。
- Failure points: out-of-order responseによる新しい検索結果の上書き、同一cursorの二重取得、loading flagの残留。
- Direct checks: generation unit testとHome state transition test。
- Independent review trigger: none。direct checkで観測できる。
- Gate: ready。

### HOME-PAGE-04: sentinel UI

- Accepted anchor and meaning: scroll rootを指定したsentinelは交差時だけ一度load moreを起動し、loading中または終端では起動しない。
- Canonical owner: `HomeRecentSessionsPanel`とprops、既存Home layoutのCSS。
- Siblings in scope: observer lifecycle、root、`hasMore`、loading、retry時の再交差。
- Failure points: 非交差での取得、二重取得、終端後取得、大きなloading cardによるlayout変化。
- Direct checks: component test。可能なら分離起動でscroll、loading、search、refreshを確認する。
- Independent review trigger: none。component testとvisual checkで観測できる。
- Gate: ready。

## 実装範囲

source側の探索起点は次のとおりとする。target側で責務が移動している場合は、同じ意味を所有する現行ファイルへ統合する。

- query、storage、IPC: `src-electron/session-summary-query.ts`、`src-electron/session-storage-v6.ts`、`src-electron/main-query-service.ts`、`src-electron/main-ipc-registration.ts`、`src-electron/preload-api.ts`
- public renderer contract: `src/session-state.ts`、`src/withmate-window-api.ts`、`src/withmate-window-types.ts`
- renderer state: `src/home/home-session-summary-query.ts`、`src/home/home-session-query-generation.ts`、`src/HomeApp.tsx`
- UI: `src/home/HomeRecentSessionsPanel.tsx`、`src/home/home-recent-sessions-panel-props.ts`、`src/styles.css`
- executable contract: 対応する`session-summary-query`、storage、query service、IPC、preload、window type、Home query generation、Home component test

`src-electron/session-summary-query.ts`、`src/home/home-session-summary-query.ts`、`src/home/home-session-query-generation.ts`はtarget baseに存在しない。新規追加する前に、同じ責務を所有する既存helperがないことを確認する。

## 対象外

- `feat/v6.3.25`全体のmergeまたはmerge commitのcherry-pick
- package version変更
- Template、Skill、Affect、Markdown、Session Detailsなどの無関係な変更
- Coordination Event、Coordination Window、右ペイン
- Home固有のpage mergeを将来consumer向けに汎用化すること
- source側のhistorical plan fileの複製
- `AGENTS.md`の変更またはcommit
- pushとPR作成

main bootstrap、IPC deps、broadcast facade、window broadcast serviceは、同じpage contractを接続するために必要な場合だけ更新する。private wiringの都合でpublic contractを複製しない。

## 実装と検証の順序

1. `git status --short`、branch、HEADを確認し、source4 commitの意図と差分を読む。
2. `contract-closure`でInvariantとsibling entrypointを再確認する。
3. `design-tests`で各failure mode、consumer、canonical owner、observableを固定する。
4. shared request／result／cursor contractとvalidatorを定める。
5. storage query、query service、IPC、preloadを同じcontractへ統合する。
6. Home page collection、generation、refresh、failure transitionを統合する。
7. sentinel UIを接続し、既存のpinned／recent／open、search、pin、Session作成、broadcast refreshを維持する。
8. targeted testを責務ごとに実行する。
9. `npm run typecheck`、`npm test`、`npm run build`を現行commitで実行する。
10. 可能なら分離起動で初期page、scroll、failure時の表示維持、search、refresh後scroll、Session作成、pin、open Sessionを確認する。
11. 同じInvariant familyのsibling sweepと必要なcommit-bound reviewを閉じる。
12. 一つの通常commitを作成する。

## 完了条件

- accepted contractがsource、type、validator、storage、IPC、renderer state、UI、testで一致する。
- source branchの無関係な変更を含まない。
- targeted test、typecheck、全test、buildの結果を現行commitへ固定して報告できる。
- visual checkの実施結果、または未実施理由とvalidation gapを区別している。
- 未解決blocking findingがなく、残リスクを分類している。
- 日本語のconventional commits形式で一つの論理変更としてcommitしている。

