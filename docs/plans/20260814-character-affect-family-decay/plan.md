# Character Affect family集約とsession時間減衰

## Scope

Character Affectの新規eventへ必須`family`を導入し、append-only eventを正本のまま維持して、read projectionでsession eventだけを時間減衰させる。storage、schema migration、application projection、lifecycle evaluator、MCP、CLI、HTTP runtime、correction/reset/retry、metricsを同じ意味へ揃える。

PR baseは`feat/v6.3.23`とし、commit、push、PR作成はこの計画のauthority外とする。

## Dependency read-back

- 2026-08-14に`origin/feat/v6.3.23`をfetchし、開始時のWorktreeがclean、HEADと当時のbaseがともに`ca038bef6990d3805ed9ec105fb0dd680cea1e06`、baseとの差分なしであることを確認した。その後のbase更新をfast-forwardで取り込み、2026-08-15の最終検証baseを`11eb1de41d6add4e76fbfcd3ed20455506aaeeb9`へ合わせた。
- ADR 020の一般Memory境界は、一つのstdio MCP serverの`memory.*` namespace、CLI/MCP共通Memory V6 application runtime、MCP専用credentialとroute allowlistをaccepted contractとする。`withmate-memory-mcp-integration.test.ts`のMCP/CLI相互read/write 3件と`memory-v6-http-server.test.ts`のcredential/allowlistを含む11件が成功した。
- ADR 020のpending appraisal境界は、durable correlation、評価世代別idempotency、failure stage、bounded retry、8回目または恒久failureのquarantineをaccepted contractとする。settlement storage/settlerの32件が成功した。

## Pre-Implementation Closure Plan

### AFF-FAMILY-01

- Invariant ID: `AFF-FAMILY-01`
- Accepted contract / exact anchor: ユーザー要求の固定enumを新規eventの必須分類とし、自由`label`は保持する。ADR 018のappend-only event、owner/scope、correction、idempotency fingerprintを維持し、legacy rowは再分類しない。
- Scope / semantic owner: `affect-contract` validation、lifecycle evaluator output、Character Context request validation、storage create/correct/load、V6 schema ensure、MCP/CLI adapter。
- Failure mode / consumer impact: 未知familyまたはfamily欠落が保存される、adapterごとに分類意味が異なる、migrationがlegacy rowを`other`へ書き換える、同じidempotency keyのfingerprintからfamilyが欠落する。
- State transitions / failure timing: evaluator normalize、adapter validation、transaction前validation、record/correct/replay、旧V6 schema ensure、restart/load。
- Direct verification: unknown/missing family拒否、fresh schema CHECK、legacy populated DBへのnullable column追加と再実行、stored/corrected/replayed eventのfamily read-back。
- Independent review trigger: schema migration、public adapter、retry保存candidateを横断するためtargeted reviewを行う。
- Gate: `ready`

### AFF-PROJECTION-02

- Invariant ID: `AFF-PROJECTION-02`
- Accepted contract / exact anchor: family eventは少なくとも`targetType + targetId + family`で集約し、代表labelは減衰後寄与、`occurredAt`、安定event IDの順で決める。familyなしlegacy eventは`targetType + targetId + legacy label identity`で分離し、新規`other`とも混ぜない。
- Scope / semantic owner: `CharacterAffectStorage.getEffectiveState`のactive-set selectionとaggregation、Character Context effective projection、provider/lifecycle injection。
- Failure mode / consumer impact: targetまたはfamilyを越えた混合、bug/task negative affectのuser/relationship転写、同family異labelの未統合、legacy label間または`other`との誤統合、非決定的representative label。
- State transitions / failure timing: reset後active-set load、correctionで元event除外、projection grouping、layer別/effective合成、public response assembly。
- Direct verification: 同target同family異labelの統合、target/family差の分離、representative tie-break、legacy label/new other分離、correction/reset後active set。
- Independent review trigger: legacy/new event混在とlayer合成の反証reviewを行う。
- Gate: `ready`

### AFF-DECAY-03

- Invariant ID: `AFF-DECAY-03`
- Accepted contract / exact anchor: session eventのread projectionだけに`0.5 ^ (ageMs / 6h)`を適用し、weightが0.05未満のeventはprojectionから除外する。relationship eventとbaselineは減衰させず、valence/arousal/intensity/custom dimensionsへ同じweightを適用して既存clampを維持する。Conversation Timingはclock sourceにしない。
- Scope / semantic owner: application-owned clockを受けるstorage projection。保存event、mutation ledger、reset、idempotency、state versionは対象外。
- Failure mode / consumer impact: relationship低下、保存値の書換え、dimensionごとの不一致、clockだけでmutation versionが変化、threshold境界の不安定、stale projection。
- State transitions / failure timing: read時評価、half-life経過、minimum threshold直前/直後、複数half-life、restart後read。
- Direct verification: half-life直後、複数half-life、threshold境界、relationship非減衰、同じ保存stateでclockだけ進めたprojection/evaluatedAt変化とversion不変、保存event read-back不変。
- Independent review trigger: clockとversion/idempotencyの分離をtargeted reviewする。
- Gate: `ready`

### AFF-MUTATION-04

- Invariant ID: `AFF-MUTATION-04`
- Accepted contract / exact anchor: ADR 018/020のappend-only correction/reset、write transaction内expected version検証、同一fingerprint replay、pending評価の世代別同一candidate/idempotency、bounded retry/quarantineを維持する。familyはcandidate identityとfingerprintに含めるが、projection clockは含めない。
- Scope / semantic owner: record/correct/reset、state version、turn settlement serialization、settler retry/reconcile、concurrency transaction。
- Failure mode / consumer impact: correction/reset済みeventが寄与する、family違いの同一key replay、clock由来version conflict、retry時のfamily欠落または二重登録、同時appraisalのlost update。
- State transitions / failure timing: validation前、transaction begin後version検証、commit後response loss、retry generation、partial/committed/unknown reconcile、concurrent appraisal。
- Direct verification: correction/reset active-set除外後decay、familyを含むreplay/conflict、retry二重登録なし、existing settlement recovery tests、同時appraisalのversion整合、clock-only version不変。
- Independent review trigger: concurrent versionとdurable retry candidateをtargeted reviewする。
- Gate: `ready`

### AFF-ADAPTER-METRICS-05

- Invariant ID: `AFF-ADAPTER-METRICS-05`
- Accepted contract / exact anchor: ADR 020によりlifecycle、MCP、CLIは同一application boundaryとprojection意味を使う。effective projectionは`family`と`evaluatedAt`を返す。metricsはfamily別候補/保存/拒否、other率、legacy projection、decay除外、cache hit/miss/stale、schema/version拒否を集計し、会話本文と自由labelを保持しない。
- Scope / semantic owner: Character Context application response、MCP Zod schema、CLI request adapter、HTTP route、lifecycle evaluator/prompt、application/storage metrics。
- Failure mode / consumer impact: adapterごとのschema差、同じclock/stateで異なるprojection、unknown familyの迂回、自由labelや会話内容のmetrics漏洩、no-cache実装をcache hitと誤計上。
- State transitions / failure timing: lifecycle internal call、MCP/CLI validation前、runtime dispatch、context response assembly、metrics read。
- Direct verification: lifecycle/MCP/CLIの同一clock projection、MCP/CLI unknown family拒否、output schemaのfamily/evaluatedAt、metrics bucketとprivacy assertion。cacheを導入しないため全projection readをmiss、hit/staleを0として計上する。
- Independent review trigger: public schema、privacy、兄弟adapterの反証reviewを行う。
- Gate: `ready`

## Closure Map

- Invariant ID: `AFF-FAMILY-01`から`AFF-ADAPTER-METRICS-05`
- Accepted anchor and meaning: ユーザー要求、ADR 018のappend-only owner/mutation契約、ADR 020の共通application boundaryとdurable retry契約。
- Canonical owner: domain validationは`src/character-affect/affect-contract.ts`、永続eventとprojectionは`src-electron/character-affect-storage.ts`、外部投影はCharacter Context application serviceが所有する。
- Siblings in scope: lifecycle evaluator、internal lifecycle context/appraisal、MCP、CLI、HTTP runtime、record、load、correct、reset、retry/recovery、fresh/legacy schema ensure、inspect、effective projection、metrics。
- Excluded siblings and reason: baselineは保存eventではなくCharacter Definition由来の別semantic ownerなのでfamily必須化と時間減衰の対象外。relationship eventは明示的に非減衰。Memory episode本文と一般MemoryはAffect family projectionを所有しない。Conversation Timingは会話表示contextでありAffect clockではない。UIはeffective projectionを独自加工せず、今回のconsumer契約に専用表示を持たない。
- Failure points: adapter validation前、storage transaction前、schema ensure途中、commit後response loss、retry/recovery、active-set選択後、read clock評価、public response assembly。
- Direct checks: family/schema/migration、aggregation/legacy/tie-break、decay boundaries/version stability、correction/reset/retry/concurrency、adapter integration/metrics privacy、typecheck/build。
- Independent review lens: (1) schema・legacy migration・mutation/version/retry、(2) projection・clock・legacy grouping、(3) MCP/CLI/lifecycle schema・metrics privacy。同じcandidate source stateへ各lensを一度ずつ割り当てる。

## Architecture gate

- 新規ADRは作らない。既存decisionの語彙拡張とprojection policyなので、ADR 018へfamily/legacy/decay/migrationを、ADR 020へ共通projection/evaluatedAt/version/metricsを追記する。
- 既存の段階導入構造はCharacter Affect全体の`shadow | active`だけで、family aggregationとdecayを独立にshadow観測するflagはない。projection専用flagを新設すると設定・運用契約が増えるため、この変更では追加しない。既存shadow modeを保存成功やdry-runとして扱わない。
- projection cacheは導入しない。readごとにapplication clockで再評価し、cache metricsはmissのみを計上する。

## Validation

1. targeted affect storage/service/context/evaluator/settlement tests
2. database schema/migration tests
3. CLI/MCP/HTTP integration tests
4. concurrency worker tests
5. `npm run typecheck`
6. `npm run build`
7. Sibling Sweep、Candidate snapshot、3 lensの独立targeted review

現行baseへ合わせたimplementation-complete candidateに対し、全test、`npm run typecheck`、`npm run build`は成功済み。buildには既存の`::highlight`解釈警告とchunk size警告があるが、失敗はない。独立reviewはCandidate snapshot固定後に実施する。

## Independent review closure

Candidate 1を固定し、次の3 lensを独立した`targeted_reviewer`へ渡した。

- schema・mutation・retry: 既に別理由で隔離済みのfamilyなしcandidateがrelease時に旧identityを再利用する経路を`blocking / current-scope repair`へ分類した。release時に保存candidateをfailure codeとは独立に再検証し、invalidなら評価世代を進めてcandidate/progressを破棄する修正と、restartを含む直接testを追加した。
- projection・clock・legacy: NUL区切りのgroup keyがlegacy target/labelの組合せで衝突する経路を`risk-candidate`へ分類し、accepted riskにはしなかった。構造的JSON tuple keyへ変更し、衝突例の直接testを追加した。
- adapter schema・metrics privacy: 配布Skill referenceが必須`family`、projectionの`family`/`evaluatedAt`、metrics bucketを説明していない点を`blocking / current-scope repair`へ分類した。referenceとSkill contract testを更新した。

3 finding familyの修正後targeted checkは35件すべて成功した。全test、`npm run typecheck`、`npm run build`も成功し、各finding familyのtargeted closureで未解決blockingなしを確認した。complete-diff reviewで検出したlifecycle `evaluatedAt`投影漏れも修正し、Candidate 3のtargeted closureで完了した。

## Follow-up closure: post-commit metrics

- Invariant ID: `AFF-METRICS-COMMIT-06`
- Accepted contract / exact anchor: `savedByFamily`はapplication service経由でdurableに新規作成されたeventをfamily別に一度だけ数える。Memory episodeのpost-commit failureでもeventの`effect: committed`と整合し、同一idempotency replayは新規保存として数えない。metricsへ自由label、reason、evidence、target IDを保持しない。
- Scope / semantic owner: `CharacterAffectService.recordAppraisal`がstorageの`created`結果をpost-commit errorへ保持し、`CharacterContextApplicationService.appraise`がfamily counterへ反映する。correctionとresetのmetricsは別ownerのため対象外。
- Failure mode / consumer impact: eventがdurableに存在する一方、episode永続化失敗で`recordAppraisal`がthrowし、`savedByFamily`だけ過少計上される。影響はtelemetryに限定される。
- State transitions / failure timing: event validation、record commit、episode write、post-commit error、同一request replay、再度のepisode failure。
- Direct verification: episode write失敗後に`effect: committed`、storage event 1件、`savedByFamily.<family>` 1件を確認し、同一request retryでも1件のままであることとmetrics privacyを確認する。
- Independent review trigger: none。単一application boundaryでfailure timingを直接testできるcurrent-scope repair。
- Gate: `ready`

### Closure Map

- Invariant ID: `AFF-METRICS-COMMIT-06`
- Accepted anchor and meaning: durable eventの新規作成結果とfamily別保存telemetryを一致させる。
- Canonical owner: Affect storageの`created`判定、Affect serviceのpost-commit error、Character Context application metrics。
- Siblings in scope: successful create、successful replay、episode失敗後create、episode失敗後replay、metrics projection。
- Excluded siblings and reason: MCP Zodのdispatch前拒否はapplication serviceを通らず、adapter validation metricsの別owner。correction/resetは`savedByFamily`のcandidate保存契約ではない。
- Failure points: event commit後、episode side effect失敗、error mapping前、retry replay時。
- Direct checks: Character Context application serviceのpost-commit failure/replay testとprivacy assertion。
- Independent review lens: none。

修正前の直接testは`0 !== 1`でfailureを再現した。post-commit errorへstorageの`created`結果を保持する修正後は、episode failureと同一request replayを含むAffect service/application serviceの18件、`npm run typecheck`が成功した。

## Follow-up closure: Node 22 SQLite text read-back

- Invariant ID: `AFF-STORAGE-TEXT-07`
- Accepted contract / exact anchor: Affect eventの`targetId`はpublic schemaで非空文字列として受理され、保存後のcreate response、個別取得、inspect、effective projectionで同じ文字列を欠損なく返す。Node 22の`node:sqlite`がTEXT内のNUL以降をread-back時に切り捨てても、DBへ保存済みのUTF-8 bytesとpublic projectionを一致させる。
- Scope / semantic owner: `CharacterAffectStorage`のevent row read境界。record/correctのcreate response、`getEvent`、`inspect`、`getEffectiveState`、idempotent replayが同じrow復元規則を使う。
- Failure mode / consumer impact: NULを含む`targetId`がNode 22で短縮され、異なるtargetがpublic response上で同一に見える。legacy identityの集約境界も誤って観測される。
- State transitions / failure timing: event commit後のrequire/read、replay read、inspection、active-set projection。保存値、schema、migration、correction/reset stateは変更しない。
- Direct verification: 既存のNUL衝突反証testでcreate response、`getEvent`、`inspect`、effective projectionをNode 22とNode 24の両方で確認し、関連storage test、typecheck、buildを実行する。
- Independent review trigger: none。単一storage read境界で全material siblingを直接testでき、保存形式とschemaを変更しないcurrent-scope repair。
- Gate: `ready`

### Closure Map

- Invariant ID: `AFF-STORAGE-TEXT-07`
- Accepted anchor and meaning: public schemaが受理した非空`targetId`は、commit後の全event read channelで完全にround-tripする。
- Canonical owner: `CharacterAffectStorage`のevent row selectionと`StoredAffectEvent` / projection変換。
- Siblings in scope: record/correct/replayの`requireEvent`、`getEvent`、`inspect`、`getEffectiveState`。
- Excluded siblings and reason: `value_json`内のlabel/reason/evidenceはJSON escapeを介して既にNode 22でもround-tripし、reset/mutation rowは`targetId`を所有しない。DB schemaとstored TEXT bytesは正しいためmigrationも対象外。
- Failure points: commit後のTEXT column decodeでNUL以降が欠損し、create/read/projection consumerへ短縮値が返る。
- Direct checks: Node 22/24で同じNUL入りeventのcreate/get/inspect/projection結果を比較する。
- Independent review lens: none。

修正前はNode 22.22.0でcreate responseの`targetId`がNUL直前の`a`へ短縮されるfailureを再現した。event row取得時に`target_id`をBLOBとして読み、UTF-8へ復元する共通境界へ修正した後、Node 22.22.0とNode 24.18.0のstorage test各18件、CIと同じNode 22 shard 1（710 passed、1 skipped）、`npm run typecheck`、`npm run build`が成功した。保存値、schema、migrationへの変更はなく、未解決blockingとvalidation gapはない。
