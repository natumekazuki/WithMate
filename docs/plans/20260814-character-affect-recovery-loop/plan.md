# Issue #289 Character Affect回復ループ修正計画

## 目的と範囲

`ISSUE-289.md` のマスク済み証拠と完了条件を正本とし、completed turnのdurable settlement queueを項目単位で収束させる。再試行可能な失敗には永続backoffを適用し、上限到達または恒久失敗は本文を失わない隔離状態へ移す。Character Affect eventのfamily集約とsession時間減衰は対象外とする。

## Pre-Implementation Closure Plan

- Invariant ID: I289-QUEUE-CONVERGENCE
- Accepted contract / exact anchor: `ISSUE-289.md` の「失敗した一項目が他項目を妨げない」「再試行間隔、最大試行回数、隔離後の復旧方法を明示する」「未処理項目を自動で破棄しない」と、ADR 020の「1回のsettlementは一つのappraisal」「固定件数drain」「上限付きbackoff」「process再起動後もdurable pendingから再開」の意味を維持する。
- Scope / semantic owner: `CharacterAffectTurnSettlementStorage` が項目状態、次回時刻、試行回数、隔離を所有し、drainはdue itemだけを公平に走査し、schedulerはprocess内の単一drain ownerを維持する。
- Failure mode / consumer impact: retryableでないerror、15秒provider timeout、Context取得失敗が同じready itemとして無制限に再処理され、provider資源と警告logを消費する。
- State transitions / failure timing: enqueue(unready) → ready → attempting → settled、retryable failure → deferred(nextAttemptAt)、non-retryableまたは上限到達 → quarantined、operator recovery → ready。Session commit前のunready discard契約は変更しない。
- Direct verification: storage restartをまたぐnextAttemptAt/quarantine、drainがfuture/quarantined itemをskipし後続due itemをsettleすること、schedulerがactive item消滅時に停止することをNode testで直接確認する。
- Independent review trigger: 永続状態migration、timeout後のprovider資源解放、既存ambiguous effect reconciliationと新しい隔離判定のinteractionをtargeted reviewerへ渡す。
- Gate: ready

- Invariant ID: I289-IDEMPOTENT-EFFECT
- Accepted contract / exact anchor: ADR 018/020の、`effect: none` は同じcorrelation/evaluation generationから安全に再試行し、`partial|committed|unknown` は保存済みcandidate identityとidempotency keyを変えずread-back/reconcileし、未確認effectを成功扱いしない契約。
- Scope / semantic owner: turn settlerとsettlement storageのevaluation snapshot、Affect application serviceのidempotency/read-back。
- Failure mode / consumer impact: backoffまたは隔離導入時にcandidateを再生成し、Affect eventまたはMemory episodeを重複保存する。
- State transitions / failure timing: evaluation保存前、appraise dispatch前、commit後response loss、retry/restart、version conflict effect:noneの次generation。
- Direct verification: existing settler contract testに加え、deferred/restart後も同じcandidate keyを再利用し、quarantine/release後も保存済みevaluationを置換しないことを確認する。
- Independent review trigger: ambiguous effectとquarantine/releaseの相互作用。
- Gate: ready

- Invariant ID: I289-DIAGNOSTICS-PRIVACY
- Accepted contract / exact anchor: `ISSUE-289.md` の処理段階・例外名・安全なmessage・所要時間、および本文、workspace path、秘密情報をlogへ出さない完了条件。
- Scope / semantic owner: Character Context application serviceのAffect状態取得、Memory検索、response組み立てと、turn settlementのcontext/evaluation/appraisal各stage。
- Failure mode / consumer impact: 想定外例外が一律`storage_unavailable`となり原因段階が失われるか、診断追加で会話本文・path・secretを漏らす。
- State transitions / failure timing: 各stage開始から例外mappingまで。public error schemaとeffect semanticsは変更しない。
- Direct verification: stage別failure injectionでdiagnosticのstage/name/durationとredactionをassertし、public errorが従来どおりstructured contractを保つことを確認する。
- Independent review trigger: log投影のprivacy lens。
- Gate: ready

## Closure Map

- Invariant ID: I289-QUEUE-CONVERGENCE
- Accepted anchor and meaning: Issue完了条件とADR 020により、durable pendingは消去せず、各itemがsettled・deferred・quarantinedのいずれかへ収束し、他itemをstarvationさせない。
- Canonical owner: settlement storageのdurable item state。
- Siblings in scope: direct post-turn settlement、startup recovery、delayed drain、restart load、structured error、provider timeout/throw、operator inspect/release、warning projection。
- Excluded siblings and reason: Character Affect family集約とsession時間減衰は別のaccepted behavior変更であり、queue収束Invariantを所有しない。一般Memory MCP route/credentialは現行契約の確認対象だが変更対象ではない。
- Failure points: Session commit前、Context read、provider evaluation timeout、evaluation snapshot commit後、appraisal response loss、scheduler再起動、process restart。
- Direct checks: storage、drain、settler、context application serviceのtargeted testとtypecheck。
- Independent review lens: migration/queue fairness、idempotent effect、diagnostic privacy。

- Invariant ID: I289-IDEMPOTENT-EFFECT
- Accepted anchor and meaning: retryはeffect certaintyに応じて同一identityのreconcileまたはeffect:none確定後の新generationだけを許す。
- Canonical owner: turn settler + persisted evaluation snapshot。
- Siblings in scope: initial request、same-request retry、restart recovery、partial/committed/unknown、effect:none version conflict。
- Excluded siblings and reason: operator Affect correction/resetはturn settlement retryとは別authority・別semantic owner。
- Failure points: appraisal commit直後のresponse loss、failure progress保存直後のprocess exit、quarantine release後。
- Direct checks: idempotency key列と保存済みcandidate snapshotの不変性。
- Independent review lens: duplicate event/episode反例。

- Invariant ID: I289-DIAGNOSTICS-PRIVACY
- Accepted anchor and meaning: 内容を記録せず、failure stageと安全なmetadataだけで原因を切り分けられる。
- Canonical owner: application serviceとlifecycle log projection。
- Siblings in scope: Affect state read、Memory search、response assembly、provider evaluation、appraisal。
- Excluded siblings and reason: MCP/CLI transport error loggingは今回観測されたlifecycle経路ではなく、public error mappingも変更しない。
- Failure points: thrown Error、AbortError、non-Error throw、長いmessage/pathを含む例外。
- Direct checks: callback/log payloadに本文・workspace path・secretがなく、stage/name/duration/input length/query term count/attempt stateだけがあること。
- Independent review lens: privacy projection。

## 検証

- `scripts/tests/character-affect-turn-settlement-storage.test.ts`
- `scripts/tests/character-affect-turn-drain.test.ts`
- `scripts/tests/character-affect-turn-settler.test.ts`
- `scripts/tests/character-context-application-service.test.ts`
- provider adapterのtimeout/abort cleanupに関する既存targeted testまたは追加test
- `npm run typecheck`
- 変更Invariantに関係するCharacter Affect test群

## Sibling Sweep記録

実装後に `settlement-pending`、`recovery-failed`、`storage_unavailable`、`listReadyPending`、`recordAttempt`、`runBackgroundStructuredPrompt`、`character_affect_turn_settlements` を検索し、同じInvariant familyの入口・投影・migration・runbookを再確認する。
