# 同一Characterの別Sessionへ短時間のAffect余韻を投影する計画

## 目的と現在地

添付Issueの契約に従い、同一の`local-user`とCharacterに属する直近Sessionのsession-layer Affect eventを、現在Sessionのread-time effective projectionへ短時間だけ合成する。永続event、Character Memory、relationship stateは変更しない。

契約、source、schema、storage、query、projection、cache、lifecycle、MCP、CLI、prompt injection、関連testを調査済みであり、統括回答により実装契約も確定した。sourceとtestの編集へ進める。

## 確認した正本と責務境界

- 添付Issue: 基本契約、必須Invariant、受け入れ条件、確認事項。
- `docs/adr/018-character-affect-event-persistence.md`: append-only event、session/relationship scope、6時間half-life、最小decay weight、reset/correction、Memory分離、read-time afterglowのscopeとbounded policy。
- `docs/adr/020-memory-affect-mcp-application-boundary.md`: lifecycle、MCP、CLIで共有するapplication boundary、read-time projection、shadow mode、cache metrics、privacy、retry semantics。
- `src/character-affect/affect-contract.ts`: Affect eventとeffective componentのschema。effective componentには発生元Sessionを公開するfieldがない。
- `src-electron/character-affect-storage.ts`: event/resetの正本、active-set、relationship/current-session projection、6時間half-life、reset、version、projection metrics。現在のprojection cacheは導入されておらず、readごとに再評価する。
- `src-electron/character-affect-service.ts`: storage projectionとMemory episode収束のapplication service。
- `src-electron/character-context-application-service.ts`: `character_context.get`の共有projection、public component mapping、MCP/CLI/lifecycleの共通metricsとerror boundary。
- `src-electron/database-schema-v6.ts`: Affect tablesと既存index。既存のeffective indexはcurrent session queryを主対象とし、全sessionの時間範囲queryには別のcovering順序が必要になる可能性がある。
- `src-electron/main.ts`、`src-electron/session-runtime-service.ts`、`src-electron/provider-prompt.ts`: lifecycleのcontext取得と、effective summaryだけをpromptへ注入するowner。
- `scripts/tests/character-affect-storage.test.ts`: session/relationship分離、correction/reset、decay、version不変、event件数。
- `scripts/tests/character-context-application-service.test.ts`: public context、MCP/CLI共通のprojection、privacy、Memory非混入。
- `scripts/tests/database-schema-v6.test.ts`: additive schema/index、既存row保持、schema validation。
- `scripts/tests/provider-prompt.test.ts`: promptへのeffective component注入とraw event非注入。

## Contract Closure Plan

### Invariant `AFTERGLOW-SOURCE-01`

- Accepted contract / exact anchor: 添付Issueの「永続eventのsessionId、layer、target、evidence、件数を変更しない」と、ADR 018の「eventをappendし、current stateをread projectionする」の意味。
- Scope / semantic owner: `CharacterAffectStorage`のread-time projectionと、`CharacterAffectService`の薄い委譲。
- Failure mode / consumer impact: afterglow生成時にevent row、reset、correction、idempotency、Memory linkを更新し、再起動・retry後に永続状態または件数が変わる。
- State transitions / failure timing: event read前、projection合成中、response assembly後、同じreadのretry、storage再open後。projectionは全段階でread-onlyとする。
- Direct verification: projection前後のevent/reset/idempotency/mutation/Memory件数とrow tupleを比較し、同じread、storage再open、retry後も一致させる。
- Independent review trigger: なし。read-only storage boundaryで直接検証できる場合はtargeted checkで閉じる。
- Gate: `ready`

### Invariant `AFTERGLOW-OWNER-02`

- Accepted contract / exact anchor: 添付Issueの「同一userIdかつ同一characterIdだけ」「relationshipへ自動昇格しない」、ADR 018のlocal-user ownerとsession/relationship scope。
- Scope / semantic owner: `CharacterAffectStorage.getEffectiveState`のcandidate queryと`assertSessionOwner`、public context scope。
- Failure mode / consumer impact: 別user、別Character、current Session、relationship event、期限外event、削除済みsource Sessionがafterglowへ混入する。
- State transitions / failure timing: current session owner validation、source event query、source session reset/correction、current/afterglow aggregation、public mapping。
- Direct verification: current only、relationship only、afterglowあり、別user、別Character、期限外、source reset/correction、source session削除のprojectionを直接確認する。
- Independent review trigger: DB scope/indexとpublic projectionの相互作用に未検証の横断経路が残る場合だけ、commit-bound targeted reviewを再判定する。
- Gate: `ready`。同一target identityとtask系continuityは統括回答で確定した。

### Invariant `AFTERGLOW-PROJECTION-03`

- Accepted contract / exact anchor: 添付Issueの「current SessionとCharacter Definitionを優先」「補助componentとして減衰合成」「task、bug、artifact、selfを無関係な話題へ強く持ち込まない」。ADR 018の既存baseline、relationship、session aggregationと6時間half-life。
- Scope / semantic owner: storage projectionのcandidate selection、decay、aggregation。`CharacterContextApplicationService`は公開可能なcomponent fieldだけを写す。
- Failure mode / consumer impact: afterglowがcurrent eventやbaselineを上書きする、同一targetの寄与が二重に強くなる、task系感情が無関係なSessionへ強く漏れる、期限判定がread clockとずれる。
- State transitions / failure timing: current rowsとbaselineのselection → bounded afterglow query → source/session decayと選別 → current優先のaggregation → public response assembly。
- Direct verification: TTL境界、intensity/valenceの減衰、current same-target優先、negative task suppression、baseline/relationship/currentの優先順をstorageとpublic contextで確認する。
- Independent review trigger: TTLと同一targetの決定後、aggregationとpublic prompt injectionに具体的なinteractionが残る場合のみtargeted reviewを再判定する。
- Gate: `ready`。TTL、cross-session係数、source Session選択、component capは統括回答で確定した。

### Invariant `AFTERGLOW-BOUNDED-04`

- Accepted contract / exact anchor: 添付Issueの「query件数、注入component数、時間範囲、cacheをboundedにし、Session数へ比例した全件hydrateを行わない」と受け入れ条件のbounded query。
- Scope / semantic owner: `CharacterAffectStorage`のSQL query、database schemaのindex、aggregationのcomponent cap、既存のread-time no-cache policy。
- Failure mode / consumer impact: 全Sessionのeventをhydrateして応答遅延・メモリ使用量がSession数に比例する、component上限がquery前後で崩れる、cacheがderived stateを永続化する。
- State transitions / failure timing: SQL admission → row limit → source reset/decay filter → component limit → response/cache metrics。read時計の進行でversionは変更しない。
- Direct verification: schema index、`LIMIT`付きquery、上位component上限、期限外除外、連続read/reopen時のno-cacheとevent非増加を確認する。
- Independent review trigger: なし。index/query planとrow/component limitを直接検証できるなら追加reviewは不要。
- Gate: `ready`。query row 64件、afterglow component 3件、固定TTL、additive indexで確定した。

### Invariant `AFTERGLOW-PRIVACY-05`

- Accepted contract / exact anchor: 添付Issueのraw transcript、evidence本文、secret、private path、ユーザー感情推定をprojection、log、metricsへ含めないこと。ADR 020と`provider-prompt.ts`のeffective summary境界。
- Scope / semantic owner: `CharacterContextApplicationService`のpublic mapping、MCP/CLI routeの共有service、prompt section、metrics/log projection。
- Failure mode / consumer impact: source eventのreason/evidence/sourceSessionIdやprivate dataがMCP/CLI response、prompt、metrics、diagnosticへ漏れる。
- State transitions / failure timing: storage internal row → effective state → context response → MCP/CLI adapter → prompt/log/metrics。
- Direct verification: public response、MCP/CLI parity、prompt text、metrics、unexpected-error diagnosticにraw contentとsource Session identityがないことをassertする。
- Independent review trigger: public schemaを変更する場合だけprivacy lensをcommit-bound reviewへ渡す。
- Gate: `ready`（公開field追加なしの方針を前提とする）

### Invariant `AFTERGLOW-RECOVERY-06`

- Accepted contract / exact anchor: 添付Issueの「retry、cache rebuild、process restartでderived projectionを永続eventへ変換しない」とADR 018/020のidempotency、effect、read-time projection。
- Scope / semantic owner: storage read boundaryと既存application/lifecycle retry boundary。afterglow専用mutationは追加しない。
- Failure mode / consumer impact: 同一context readやprocess再起動が新規event、Memory episode、relationship update、idempotency observationを作る。
- State transitions / failure timing: first read → response loss/retry → cacheなし再評価 → process close/reopen。
- Direct verification: event/Memory/relationship countsとrow tupleを全段階で比較する。
- Independent review trigger: なし。
- Gate: `ready`

## Closure Map

- Canonical owner: event validationとschemaは既存の`affect-contract.ts` / `database-schema-v6.ts`、永続eventとeffective projectionは`CharacterAffectStorage`、transport非依存のpublic projectionは`CharacterContextApplicationService`、MCP/CLI/HTTPはadapter、prompt注入は`provider-prompt.ts`。
- Siblings in scope: current session event、relationship event、cross-session session event、baseline、reset、correction、session deletion、lifecycle context read、MCP context-get、CLI context-get、prompt composition、projection metrics、schema ensure、process restart/retry。
- Excluded siblings and reason: Character Memory search/appendはAffect afterglowの内容を所有しないため対象外。Affect appraise、correction、resetのwrite contractは変更しない。Conversation Timingは別のsoft signalでありAffect decay clockへ流用しない。UIはeffective projectionを独自加工しない。
- Failure points: source query、reset/correction active-set、time cutoff、decay weight、aggregation precedence、public field mapping、MCP/CLI binding、prompt serialization、metrics/logging、restart。
- Direct checks: storage integration、schema/index、context application integration、MCP/CLI parity、prompt unit、typecheck、build。
- Independent review lens: 永続化query、owner/scope、privacy、public context、MCP/CLI/lifecycle parity、provider promptにまたがるnon-localな相互作用をcomplete diffで確認する。Full-review gateは`run`とする。

## 統括回答で確定した契約

### TTL

afterglowのhard TTLは既存`sessionHalfLifeMs`から導出する。既定値は6時間で、永続設定、table、column、`user_version`は追加しない。`ageMs >= sessionHalfLifeMs`のeventは除外し、境界時刻ちょうども期限外とする。`evaluatedAt`と既存application clockを共用し、Conversation Timingは使わない。

cross-session専用のweightは`0.5 * 0.5 ^ (ageMs / sessionHalfLifeMs)`とする。age 0の最大値は0.5で、valence、arousal、intensity、custom dimensionsへ同じweightを適用する。0.5は永続設定ではなくprojection policyの定数とする。

### current Sessionと同一targetの扱い

current Sessionに同じcomponent identityがある場合、そのidentityのafterglowを完全除外する。identityは`targetType + targetId + family`とし、familyがnullのlegacy eventは`targetType + targetId + legacy label`で識別する。current Sessionのversion、label、intensity、eventIdsへafterglowを混ぜない。

### task系targetのcontinuity

`task`、`bug`、`artifact`、`self`は、current Sessionのreset後にactiveなsession-layer eventとして同じ`targetType + targetId`がある場合だけ候補にする。baseline、relationship event、current query、raw transcript、reason、evidenceはcontinuity判定に使わない。同一component identityは、task continuityを満たしてもsame-target規則で除外する。

### 直近source Sessionとbound

current Sessionを除き、TTL内にreset後のactive session-layer eventを持つSessionのうち、`occurredAt DESC`、event IDの既存canonical順で最新のeligible eventを持つ1 Sessionだけをsourceにする。source Sessionを決めてからcontinuity、same-target、component capを適用し、最新sourceがfilter後に0件でも古いSessionへfallbackしない。`sessions_v6.last_active_at`と会話本文はsource選択に使わない。

source Sessionのquery row上限は64件、public effective projectionへ追加できるafterglow componentは最大3件とする。reset、correction、state、TTLはSQL admissionまたはbounded query内で適用し、LIMIT後のfilterで無効rowが枠を占有しないようにする。afterglowとread clockはcurrent SessionのAffect versionへ含めず、public component schemaと`contributingLayers`は変更しない。

afterglowは既存session layerとしてのみ表現し、新規event、Character Memory episode、relationship state、projection cacheを作らない。既存public componentの`targetId` / `label` fieldはschemaどおり扱うが、afterglowのsource Session identity、reason、evidenceはpublic projection、MCP、CLI、promptへ出さない。metricsにはsource Session identity、target ID、自由label、reason、evidenceを含めず、candidate row数、selected component数、TTL、same-target、continuity、component-capによる固定分類のaggregate counterだけを許可する。

afterglowとbaselineまたはrelationshipが同じeffective identityへ合成される場合、afterglowは非afterglowの代表labelを上書きしない。current Sessionの同一identityはcandidate段階で完全除外するため、current eventのlabel、intensity、eventIds、versionもafterglowから変更しない。

indexは`CREATE INDEX IF NOT EXISTS`によるadditive ensureで追加する。table rebuild、data backfill、column追加、`user_version`変更が必要になった場合はscopeを拡張せず実装を停止して再確認する。

## 承認後の直接検証

少なくとも次を実装後に直接確認する。

1. age 0のafterglow weightが0.5であり、current Session eventと同じ強度にならない。
2. `ageMs = sessionHalfLifeMs`のeventが除外される。
3. 過去Sessionが2つある場合、最新source Sessionだけが候補になる。
4. 最新sourceがcontinuityまたはsame-target filterで0件になっても、古いSessionへfallbackしない。
5. legacy `family = null`がlegacy labelを含むidentityでsame-target判定される。
6. source Sessionのreset後eventだけが候補になり、corrected eventは候補にならない。
7. current Session resetはcurrent active target tupleだけを更新し、別source Sessionのresetとして誤用されない。
8. event rowは64件、afterglow componentは3件を超えない。
9. 別Sessionのwriteとread clock進行でeffective projectionが変わっても、current Sessionのversionは変わらない。
10. public context、MCP、CLI、prompt、metricsへsource Session identity、reason、evidenceが出ない。
11. 既存V6 DBへのindex ensure再実行でrow、event、reset、Memory件数が変わらない。

## 実装後のtest設計

各testはsourceの現在表現ではなく、下記の観測可能なfailure modeを直接検出する。

| Failure mode | Contract | Consumer impact | Canonical owner | Observable / check layer | 既存checkとの差分 |
| --- | --- | --- | --- | --- | --- |
| current Sessionのeventがafterglowへ二重計上される | current優先、同一target規則 | current topicのintensity/labelが変わる | storage aggregation | current + afterglow同一targetのeffective tuple、storage integration | 既存testはsession間を分離し、afterglowを確認しない |
| 期限外・別user・別Character・別Sessionのeventが混入する | owner/scope/TTL | privacyと感情の誤帰属 | storage query | clock境界、scope、source sessionを含むfixtureのeffective state | 既存testはcurrent sessionとrelationshipだけを確認 |
| task/bug/artifact/selfが無関係なSessionへ強く残る | negative task suppression | 新規話題の応答 tone が汚染される | storage candidate selection | 同一targetなしでcomponent不在、同一targetで許可 | 既存testはtask eventをcurrent session内でのみ確認 |
| relationship eventがafterglowとして複製・昇格される | relationship正本不変 | relationship stateが二重化する | storage layer selection | relationship event 1件、session Bのcomponent 1件、event count不変 | 既存testはrelationship共有を確認するがafterglow由来の重複を見ない |
| queryがSession数に比例して全件hydrateする | bounded query/component cap/index | latencyとmemoryが増える | storage SQL/schema | required index、query row LIMIT、component cap、多数event fixture | 既存testにquery上限とindex planの観測がない |
| context/MCP/CLI/promptへraw dataやsource Sessionが漏れる | privacy/public projection | secret・本文・provenance漏えい | context application / prompt | public JSON、MCP/CLI parity、prompt text、metricsのnegative assertion | 既存testはMemory bodyとevent raw responseの非混入を一部確認 |
| read/retry/restartでderived stateが保存される | read-only/recovery | event・Memory件数が増える | storage/application boundary | read twice、close/reopen、cache-metrics、DB row/count tuple | 既存retry testはwrite idempotencyのみ確認 |

直接検証の層は、SQL・event tuple・decay・aggregationを`CharacterAffectStorage` integration test、schema/indexを`database-schema-v6.test.ts`、public projectionとadapter parityを既存context integration test、prompt serializationを`provider-prompt.test.ts`、型と配布経路をtypecheck/buildとする。新しいpublic fieldを追加しない場合、MCP/CLI schemaの変更は不要で、既存integration testで同一effective responseを確認する。

## 変更候補と検証順序

1. planのaccepted gateを確認し、ADR 018/020または既存designへ恒久契約を反映する。planだけを正本にしない。
2. 必要なbounded query indexをV6 `ensureV6Schema`へadditiveに追加する。既存V6 DBへsavepoint内で`CREATE INDEX IF NOT EXISTS`を適用し、user_versionや永続event rowは変更しない。
3. `CharacterAffectStorage`のread-time queryへ、同一user/character、session layer、current session除外、source reset、TTL、candidate limitを実装する。derived afterglowをevent、mutation、Memoryへ書かない。
4. current/relationship/baseline/afterglowのaggregationとcomponent capを実装し、発生元Session、reason、evidenceをpublic componentへ写さない。
5. `CharacterContextApplicationService`、MCP/CLI adapter、lifecycle、`provider-prompt.ts`のownerを確認し、既存public schemaとshadow modeの意味を保つ。
6. `current only`、`relationship only`、`afterglowあり`、別scope、期限切れ、same-target、negative task suppression、件数非増加、restart/cache/retry、privacyを直接testする。
7. 関連targeted test、`npm run typecheck`、`npm run build`を実行する。通常commit後、base/review commitを固定したclean detached worktreeでcomplete-diff holistic reviewを1回実施する。finding修正が必要な場合だけ同じInvariant familyのdirect checkとtargeted closureを行い、holistic reviewは再実行しない。

## Validation gap

初回baselineでは依存関係未導入のため62件成功、1件失敗した。失敗は`character-affect-concurrency-worker.ts`が一時`npx`環境から`tsx`を解決できない環境要因で、source assertionの失敗ではなかった。

実装後のtargeted testは72件中72件成功し、`npm run typecheck`と`npm run build`も成功した。全体の`npm test`は2554件中2552件成功、1件skip、1件失敗で、失敗は変更対象外の`withmate-memory-mcp-integration.test.ts`にある配布artifact smokeの`memory.append`応答（`append.isError === true`）だった。同テスト単独でも同じ失敗を再現し、afterglow変更のsource/testとは無関係な既存の配布artifact/runtime環境差分として残す。buildのwarningは既存の`::highlight`未認識とchunk size超過のみだった。

統括回答で確認は完了している。以降はsource、test、schema、ADRを同じ契約で更新し、planだけを正本にしない。
