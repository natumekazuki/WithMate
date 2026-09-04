# v6.3.26 / v6.4.0 統合計画

## 目的

リリース済み `v6.3.26` を通常の merge として `feat/v6.4.0-integrate-v6.3.26` へ取り込み、v6.3.26 までの master 側機能と、v6.4.0 の Session orchestration 機能を一つの source state に統合する。

本計画は、この統合で維持する契約、conflict 解消、直接検証、commit-bound review の作業記録を所有する。SessionFolder の開始資料は正本にしない。

## 固定 source state

- target branch: `feat/v6.4.0-integrate-v6.3.26`
- target base branch: `feat/v6.4.0`
- target base commit: `4f6004da0f3a030b13157c38808a98474e01630a`
- merge source: annotated tag `v6.3.26`
- tag object: `00c68566afe27137b9bb444dcf49b79dbf39bff7`
- merge source commit: `750e7cd9010e7e7cdf721ca8a5a7180f85e81e1e`
- common ancestor: `0044aa46d496594b259497049e98744bd34fa6f3`

開始時に branch、HEAD、tag peeled commit、merge-base、clean worktree が上記と一致することを確認した。不一致はない。

## 調査結果

- target 固有 138 commits、source 固有 224 commits。
- source 側変更は 370 files、78,168 insertions、8,271 deletions。
- common ancestor 以降の変更 file は target 314、source 370、双方変更 104。
- `git merge-tree --write-tree --messages` で、content conflict 52件、add/add conflict 8件、合計60件を観測した。
- add/add conflict は Home Session query、Session summary query、window type test、runtime path security に集中する。
- source 側では Memory CLI が managed Skill 内から `resources/cli` へ移動し、managed distribution が Memory 専用 service から共通 Skill distribution service へ置き換わる。旧 path の参照を残さない。
- conflict marker がなくても、database schema、Session state、provider prompt、Home pagination、runtime lifecycle、IPC、preload、window API、package/packaging は双方の機能を落とし得る。

## Closure Plan / Map

### INTEGRATION-SOURCE-01: 固定 release 全体を履歴として取り込む

- Accepted contract / exact anchor: `v6.3.26` の annotated tag が `750e7cd9010e7e7cdf721ca8a5a7180f85e81e1e` を指し、squash や cherry-pick ではなく merge parent として履歴に残る。
- Scope / canonical owner: Git commit graph と最終 merge commit。
- Siblings in scope: target parent、source parent、common ancestor、version metadata。
- Failure mode / consumer impact: 可変 branch や別 commit を取り込み、release 済み source と最終 state が一致しない。
- State transitions / failure timing: merge 開始前、conflict 解消後、commit 後。
- Direct verification: `git rev-parse`、`git merge-base`、`git show --format=%P`、ancestor check。
- Independent review trigger: complete-diff review の preflight に含める。
- Gate: ready。

### INTEGRATION-PERSIST-02: V6 schema と既存データを加算的に統合する

- Accepted contract / exact anchor: v6.4.0 の Role binding、execution、origin、Work Item、coordination、schedule、notification、transcript と、v6.3.26 の Memory、Character context、Affect、afterglow を V6 required state として共存させる。既存 database を再作成せず、不足 table、column、index、trigger、backfill を transaction 内で ensure する。
- Scope / canonical owner: `database-schema-v6`、各 V6 storage、`app-database-path`、persistent store lifecycle。
- Siblings in scope: fresh create、populated upgrade、malformed detection、repair、二回実行、FK/CHECK/index、Session delete、relationship Affect retention。
- Failure mode / consumer impact: source 側の縮小 schema 採用で Role/WorkItem が消える、target 側採用で afterglow index が欠落する、partial migration や FK action で既存状態を失う。
- State transitions / failure timing: open 前検証、SAVEPOINT、commit、rollback、reopen、fallback selection。
- Direct verification: database schema、app database path、Session/Memory/Affect/Role/WorkItem storage の integration test と `PRAGMA foreign_key_check`。
- Independent review trigger: migration、data loss、owner/scope を横断するため targeted lens と complete-diff review を行う。
- Gate: ready。

### INTEGRATION-AUTH-03: Session と Memory の owner / runtime authority を混同しない

- Accepted contract / exact anchor: Session Role binding は永続的な hierarchy owner、provider agent runtime binding は短命な execution generation とする。Memory/Character/Project identity は canonical binding から解決し、caller input、CLI fallback、legacy pointer から権限を昇格させない。
- Scope / canonical owner: Session role binding、agent runtime binding registry、provider runtime binding/turn coordinator、Memory application HTTP boundary、runtime discovery registry。
- Siblings in scope: create、revoke、generation replacement、tools/list fallback admission、timeout、shutdown、multi-instance cleanup、legacy projection。
- Failure mode / consumer impact: identity spoof、stale generation の再利用、MCP failure から operator CLI mutation への silent fallback、別 instance の runtime artifact 削除。
- State transitions / failure timing: binding 発行、turn admission、listed→eligible→admitted、revoke、replacement、shutdown、response loss。
- Direct verification: runtime binding HTTP、Memory HTTP/MCP integration、provider binding/coordinator、runtime discovery、quit barrier の test。
- Independent review trigger: authorization、concurrency、process lifecycle の targeted lens と complete-diff reviewを行う。
- Gate: ready。

### INTEGRATION-PUBLIC-04: public operation の全 adapter 到達性を維持する

- Accepted contract / exact anchor: Session application service を raw HTTP、client、CLI、MCP、runtime catalog、managed Skill が共有し、operation、schema、strict validation、error、effect certaintyを一致させる。Memory/Glossary の MCP/CLI distribution と fallback 境界も同時に維持する。
- Scope / canonical owner: TypeScript contract、shared application dispatch、IPC registration、preload、window API types、CLI/MCP builders、packaging。
- Siblings in scope: runtime catalog、Session CRUD/turn/interaction/coordination/work/schedule/transcript、Memory/Character/Affect、Glossary、help/schema、artifact path。
- Failure mode / consumer impact: 実装だけ存在して登録されない、CLI/MCP の片方だけ欠落する、unknown field や spoofed principal が adapter を迂回する、artifact が build/package されない。
- State transitions / failure timing: validation、dispatch、mutation commit、response mapping、build、installed artifact 起動。
- Direct verification: operation set parity、IPC/preload/window type、CLI/MCP contract、package config、artifact smoke、typecheck/build。
- Independent review trigger: public API、external side effect を横断するため targeted lens と complete-diff reviewを行う。
- Gate: ready。

### INTEGRATION-SESSION-05: Session orchestration の状態遷移と通知を維持する

- Accepted contract / exact anchor: GUI Turn queue、origin Session、schedule、terminal failure notification、Role hierarchy、WorkItem decomposition/aggregation、coordination、Session communication、Root WorkItem を v6.4.0 契約のまま維持し、v6.3.26 の running-turn persistence、window restore、provider options と共存させる。
- Scope / canonical owner: Session state/storage/application services、execution/schedule/notification/coordination/work services、broadcast/subscription、Session/Home projection。
- Siblings in scope: enqueue/run/cancel/wait/retry/restart、origin projection、parent-child deletion、schedule fire claim、notification retry、communication observer、window restore。
- Failure mode / consumer impact: queue が二重実行される、origin/owner が誤帰属する、terminal 通知が欠落または重複する、Role/WorkItem が v5 state へ退行する、restore または schedule 導線が消える。
- State transitions / failure timing: enqueue、claim、running、terminal、cancel、restart recovery、invalidation、window reopen。
- Direct verification: Session storage/runtime/execution/Role/WorkItem/coordination/communication/schedule/notification/restore の test と主要導線 visual check。
- Independent review trigger: concurrency、owner、複合状態遷移を横断するため targeted lens と complete-diff reviewを行う。
- Gate: ready。

### INTEGRATION-UI-06: Home / Session / provider projection の両 branch 機能を保つ

- Accepted contract / exact anchor: Home pagination は cursor fingerprint、page scope、stale response rejection、in-flight guard、invalidation preserve refresh を維持する。Schedules、Coordination、diagnostics、window restore、Session Details、Template、Markdown front matter、file preview、Memory/Glossary UIを単一の既存 UI shellへ統合する。provider prompt は Session context、coordination response、attachment manifest と sanitised Affect projectionを共存させる。
- Scope / canonical owner: Home/Session state と projection、summary query/subscription、provider prompt composer、MessageRichText/search projection、shared styles。
- Siblings in scope: recent/pinned/open、load more、all/ids invalidation、restore set、schedule pane、Role/coordination display、front matter table/fallback/search。
- Failure mode / consumer impact: stale page が現行stateを上書きする、重複page request、片側のpaneやaction欠落、providerがRole/coordinationを認識できない、front matter表示と検索が不一致。
- State transitions / failure timing: initial load、load more、query change、in-flight invalidation、window restore、message render/search。
- Direct verification: Home query/generation/component、summary subscription、provider prompt、Session projection、MessageRichText/search test と visual check。
- Independent review trigger: async UI と cross-subsystem projection のうち直接testで閉じないinteractionを targeted reviewへ渡す。
- Gate: ready。

### INTEGRATION-PACKAGE-07: v6.4.0 の依存・build・配布物を一貫させる

- Accepted contract / exact anchor: package version は `6.4.0`。v6.3.26 の更新済み依存、front matter/locking/YAML依存、Memory/Glossary CLI と、v6.4.0 の cron/session CLI を同時に含める。lockfile は最終 `package.json` から npm で再生成する。
- Scope / canonical owner: `package.json`、`package-lock.json`、CLI build scripts、`resources/cli`、`build/cli`、electron-builder files/extraFiles。
- Siblings in scope: renderer/electron build、Memory/Glossary/Session CLI、LICENSE、provider binaries、Windows launcher。
- Failure mode / consumer impact: version退行、CLI置換、依存欠落、lock drift、installerにartifactが含まれない。
- State transitions / failure timing: install/lock generation、build、pack、installed launcher smoke。
- Direct verification: package config test、`npm install --package-lock-only`後のclean再実行、各CLI artifact test、build、packaging smoke。
- Independent review trigger: public distribution surface として complete-diff reviewへ含める。
- Gate: ready。

## Test Design Gate

上記各Invariantの failure mode、consumer、canonical owner、observable をそのままtest選定へ用いる。既存testで直接観測できる場合は新規testを追加しない。競合解消で既存testの意味を変更する場合は、内部callやmarkupではなく次を観測する。

- schema/state: required table/index/FK/CHECK、persist/reload後のtuple、rollback/retry。
- authority: canonical identity、forbidden error、mutation前のside effect absence。
- public API: operation set、strict schema、adapter result/error/effect parity、artifact起動。
- async/session: durable state transition、owner、invalidation、restart recovery、terminal delivery。
- UI/provider: projection output、stale response rejection、実browser geometry/interaction。

TypeScript testを追加または意味変更した場合は、base `4f6004da0f3a030b13157c38808a98474e01630a` から審査対象commitまで `review-test-value` のGit modeを実行し、抽出対象の `@test-value`、extract exit 0、ACCEPTを完了条件とする。

## 実装手順

1. 本計画をmerge前にcommitし、merge source固定とClosure Mapを履歴へ残す。
2. `v6.3.26`を通常mergeし、60件の直接conflictを schema/storage、runtime/API、Home/Session UI、package/docs の順で解消する。
3. add/add 8件は双方の型、state、query、security checkを意味単位で統合する。
4. 104件の共有変更fileを sibling sweepし、markerのないschema縮小、public registration欠落、projection退行、旧resource pathを検出する。
5. `package.json`を先に確定し、正規npmでlockfileを再生成する。
6. targeted checkを責務ごとに実行し、必要なtest/source/docsだけを同じInvariant family内で修正する。
7. 全test、typecheck、build、CLI artifact/package smoke、分離visual checkを実行する。
8. merge結果を通常commitし、固定OIDのclean detached review worktreeでtargeted reviewと一度だけcomplete-diff reviewを行う。
9. findingはaccepted contract、到達条件、consumer影響、Invariant familyで分類し、current-scope repairだけを追加commitで閉じる。

## Validation matrix

| Invariant | Direct checks |
| --- | --- |
| SOURCE-01 | branch/HEAD/tag/parents/ancestry/status static check |
| PERSIST-02 | database schema/path、Session V2/V3/V6、Memory、Affect、Role、WorkItem、migration tests |
| AUTH-03 | agent/provider binding、Memory HTTP/MCP/fallback、runtime discovery、quit barrier tests |
| PUBLIC-04 | external runtime contract/application/raw HTTP、IPC/preload/window types、Session/Memory/Glossary CLI/MCP/artifact tests |
| SESSION-05 | execution/queue/origin/schedule/notification/coordination/communication/Root WorkItem/storage tests |
| UI-06 | Home summary/query/generation/components、subscription、provider prompt、Session projection、Template/Markdown tests、visual check |
| PACKAGE-07 | package config、lock consistency、CLI build/artifact、`npm run typecheck`、`npm test`、`npm run build`、packaging smoke |

## Review gate

`Full-review gate=run`。public API、永続化、migration、authority、concurrency、複数subsystem interactionを横断し、targeted checkだけでは統合欠落を閉じられないためである。

- baseCommitOid: `4f6004da0f3a030b13157c38808a98474e01630a`
- reviewCommitOid: mergeと直接検証完了後に固定する。
- review target: SessionFolder配下のclean detached worktree。
- targeted lens: schema/migration/data retention、runtime authority/discovery、public adapter parity、Session async ownership、Home/provider projection。
- complete-diff review: 一つの論理統合commitに対して一度だけ実施する。
- finding修正後: 元Invariant familyのdirect checkとresulting deltaに限定したtargeted closureを行い、complete-diff reviewは再実行しない。

## 作業記録

### 開始時検証

- source固定値: pass。
- worktree clean: pass。
- merge-tree: 60 conflicts（content 52、add/add 8）。
- semantic conflict候補: schema縮小、Session state v6→v5退行、Session public surface欠落、Memory runtime authority、Home async pagination、provider prompt、CLI packaging。

### 実装結果

- 計画commit `a8cee60a` を第一parent、`v6.3.26` のpeeled commit `750e7cd9010e7e7cdf721ca8a5a7180f85e81e1e` を第二parentとするmerge commit `13b3495d9182d9b80ff70c0d49aa1fab058d190b` を作成した。
- `v6.3.26` を `--no-ff --no-commit` で通常 merge し、content 52件、add/add 8件を解消した。package/docs 6件、test 20件、Electron 17件、renderer 17件の計60件であり、解消後の conflict marker は0件である。
- V6 schema は Role / WorkItem / coordination / execution / schedule / notification / transcript と、Memory / Character context / Affect afterglow を同じ required stateへ統合した。persistent store lifecycle は両runtimeの起動・終了順序を保持した。
- Session storage/state は schema v6、immutable Role binding、WorkItem owner、`codexSpeed` / `codexReviewer`、running-turn atomic persistenceを共存させた。running-turnのcanonical summary生成ではRole binding列も同じtransaction snapshotから読む。
- Session external runtime、raw HTTP、CLI、MCP、runtime catalog、IPC、preload、window API、broadcast/subscriptionを維持し、Memory / Glossary runtime・CLI・MCP・fallback認可と共存させた。
- Home はpagination、stale response rejection、in-flight guard、invalidation refreshに、Schedules、Coordination、diagnostics、window restoreを統合した。Session UIはRole / WorkItem / coordinationに、message collapse/navigation、Glossary、Markdown front matter、file操作を統合した。
- provider promptはSession context、pending coordination、SessionFolder attachment manifestを維持し、Affectは必要fieldだけを投影する。
- package versionは`6.4.0`とし、v6.3.26の更新依存と`cron-parser`を統合した。`npm install --package-lock-only --ignore-scripts`でlockfileを再生成し、Memory / Session / Glossary CLIのbuild・packaging entryを共存させた。
- TypeScript testの変更対象にはGit modeの`@test-value v1` metadataを付与した。source文字列位置を観測していたGlossary search revision testは、revision更新と遅延request競合を実DOMで観測するcomponent integration testへ置き換えた。
- merge commitのreviewで検出した公開境界、永続化、UI interactionのblocking findingは、repair commit `6b5e7c9dcdf58fa62c22b88084e8fee4b9f99a51` で同じInvariant family内に修正した。provider bindingへSession Roleを復元し、Session runtime discoveryを共有multi-instance registryとowner selectorへ移行し、Glossary MCPをCodexとforeground Copilotへ到達可能にし、character-authoringのrelational owner復元とSchedule submit shortcutのowner選択を修正した。

### 検証結果

- conflict marker: 0。`git diff --check`: pass（Windows改行予告のみ）。
- schema/storage/migration、Session orchestration、Memory/Auth、IPC/UI/packageの責務別targeted check: pass。全体testで見つかったrunning-turn Role bindingの9 failureは、専用storage queryとtest fixtureを契約へ合わせて修正後に再検証した。
- `review-test-value` Git mode: base `4f6004da0f3a030b13157c38808a98474e01630a`、head `6b5e7c9dcdf58fa62c22b88084e8fee4b9f99a51` でextract exit 0、682 records、diagnostics 0。merge時点の657 recordsとrepair差分の28 records（既存変更3件を含む）を審査し、全件ACCEPT。REDESIGNとなった1件はcomponent integration testへ変更後にACCEPT。
- repair commit上の責務別targeted check: 17 test files、286 tests、286 pass、0 fail、0 skip。
- `npm test`: 3,426 tests、3,425 pass、0 fail、1 skip。
- `npm run typecheck`: pass。
- `npm run build`: pass。renderer、Electron、Memory CLI、Session CLIを生成した。
- `npm run dist:dir`: pass。`release/win-unpacked`へ`WithMate.exe`、Memory / Session / Glossaryの3 launcherと対応artifactを配置した。
- `scripts/start-withmate-visual-check.ps1`: isolated userDataの再作成、V6 DB snapshot、Electron 44.1.1起動までpass。process `40772`は応答中でwindow title `Home`を確認した。

### Review結果

- merge commit `13b3495d9182d9b80ff70c0d49aa1fab058d190b` をclean detached worktreeへ固定し、一度だけcomplete-diff reviewを実施した。
- blocking findingは、Session provider bindingからRole bindingが欠落する、Session runtime discoveryがlast-writer pointerを使う、Glossary MCPがproviderへ登録されない、character-authoring clear後のrunning turn開始でrelational `character_id`が復元されない、Schedule編集時のCtrl/Cmd+Enterがchat sendへ接続される、の5件だった。すべてrepair commit `6b5e7c9d` で修正し、direct checkを再実行した。
- non-material findingは、`.gitattributes`に削除済みMemory artifact pathが残ることと、READMEのbuild説明がGlossary / Session CLI生成を列挙しないことの2件だった。統合契約の成立を妨げず、blocking repairとInvariant familyが異なるため本commitへ混在させない。
- repair commit `6b5e7c9dcdf58fa62c22b88084e8fee4b9f99a51` はRuntime/public、Persistence、Schedule UIの3系統でtargeted closure reviewを実施し、全系統でapprove、未解決blocking finding 0件となった。complete-diff reviewは再実行していない。
- Runtime/public closureでは、App Settings reset直後のGlossary Skill diagnosticsが旧custom rootを示し得る点をLow / non-materialとして分類した。Codex / Copilot MCP登録、packaged launcher、runtime authorityはこのcacheを使用せず、再起動または次回Settings保存で収束するため、operation到達性は妨げない。reset経路でもGlossary Skill同期を行う改善はhardening候補とする。
- Persistence closureでは、clear→fresh後のmessage insert失敗に限定してrelational ownerのrollbackをread-backする追加caseをhardening候補とした。現行も同一transactionのsource、既存rollback test、clear→freshのDB read-backでaccepted contractは直接検証済みである。

### Validation gap / 残リスク

- Windows UI操作サービスが`Trusted RPC service is not configured: sky`を返したため、起動済みvisual-check windowの画面キャプチャと主要導線の目視操作は未実施。process応答とHome window生成までは確認済みである。
- `dist:dir`のunpacked artifactとlauncher配置は確認したが、NSIS installerを生成・installした状態からの全CLI起動は未実施。
- 実Codex CLI設定への登録と、実Copilot account child processからのGlossary MCP起動は未実施。launcher内容、artifact配置、Codex add/read-back分岐、Copilot SessionConfig投影は直接testで確認した。
- Session runtime cleanupがfilesystemまたはregistry errorで失敗した場合、heartbeat停止後から20秒のstale判定までentryが残り、unbound consumerが一時的にambiguousまたはunavailableとなる可能性がある。owner検証、identity challenge、AggregateErrorとlogで検知・回復可能であり、secret露出やauthority bypassにはつながらない。
- provider固有shell/Git/toolがSession Runtime API外で行う副作用は、v6.4.0 autonomy計画に記載されたvalidation gapを引き継ぐ。
