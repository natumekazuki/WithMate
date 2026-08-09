# Character Affect Persistence Plan

- Issue: `ISSUE-251`
- Draft Issue ID: `WM-AFFECT-CORE`
- Status: completed
- Accepted contract: ISSUE-251本文、ADR 018

## Scope

- Character baselineはCharacter Definition由来の入力として扱い、通常イベントでは永続化しない。
- relationship affectは`(local-user, character)`、session affectは`(local-user, character, session)`でappend-only eventとして永続化する。
- Character Memory episodeは既存Memory V6のapplication/storage境界で作成、retry、supersede、forgetへ接続する。
- 初期版ではafterglowを実装しない。provider、MCP、CLI、renderer UI、応答context注入も後続Issueへ分離する。

## Pre-Implementation Closure Plan

Gate status: `ready`

Accepted contract / exact anchors:

- ISSUE-251本文のGoal、target behavior、Done when
- `docs/adr/018-character-affect-event-persistence.md`
- `src-electron/memory-v6-storage.ts`の`appendEntry`、`forgetEntries`、idempotency、supersede境界
- `src-electron/database-schema-v6.ts`のV6 schema ensure、Memory/Affect FK、savepoint境界

Supported scopeはCharacter Affect eventとMemory episodeの作成、retry、訂正、forget後の参照、session reset、別接続の並行appendである。provider、MCP、CLI、renderer UI、afterglow、応答context注入は対象外とする。

Canonical ownerは、Affect event/reset/auditが`CharacterAffectStorage`、Memory episodeのentry/state/relation/audit/idempotencyが`MemoryV6Storage`、両者の順序と収束が`CharacterAffectService`と具体episode writerである。Memory targetはsingle-user productの`local-user`をbinding ownerとし、`character/<characterId>` scopeへ保存する。`sourceSessionId`はMemory source provenanceでありowner scopeに使わない。

Cross-storage mutationは単一SQLite transactionへ統合しない。許可する状態は、Affect eventのみ作成済み、Memory episode作成済みかつAffect link未完了、両方完了である。Memory appendとAffect linkに同一event由来のstable idempotency keyを使い、失敗を返した同一requestのretryで完了状態へ収束させる。

### Invariant Matrix

| Invariant ID | Sibling channel | Coupled values / order | Failure mode / consumer impact | Direct verification | Status |
| --- | --- | --- | --- | --- | --- |
| AF-1 | record / read / reset | user, character, session, layer, target | 別sessionまたは別targetの状態が混ざる | storage targeted test | covered |
| AF-2 | record / correct / reset retry | owner tuple, operation, idempotency key, fingerprint | retryで二重登録、別requestを誤再生 | storage targeted test | covered |
| AF-3 | correct / reset / inspect | original, replacement/reset marker, audit | 訂正根拠消失、relationshipの誤削除 | storage targeted test | covered |
| AF-4 | episode create / motif repeat / retry | affect event ID, Memory idempotency key, motif | 同一eventのepisode重複、別eventの反復欠落 | real Memory integration test | covered |
| AF-5 | fresh / existing / failed ensure | Affect tables, Memory FK, savepoint | 部分schema、既存data破損 | database schema targeted test | covered |
| AF-6 | replay / conflict / rejection metrics | operation, outcome, audit reason | 抑止・拒否結果を観測不能 | storage/service targeted test | covered |
| AF-7 | affect correction / Memory supersede | original affect link, replacement event, old/new Memory entry, target tuple | Affectだけ訂正されMemory episodeが旧内容のままactive | real Memory correction/retry test | covered |
| AF-8 | Memory append / Affect link failure recovery | derived key, Memory commit certainty, link state | Memory成功後のlink失敗で重複または成功誤認 | failure injection + same-request retry test | covered |
| AF-9 | Memory forget / session reset | Memory state, affect link/audit/effective state, relationship scope | forget/resetが監査または別scopeを破壊 | integration test | covered |
| AF-10 | concurrent append | separate connection, BEGIN IMMEDIATE, busy timeout, session/relationship scope | overwrite、混線、欠落、不要なSQLITE_BUSY | worker barrierでwrite lockとappendを実際に重ねるtest | covered |
| AF-11 | service composition | episode candidate, concrete writer availability | writer未設定で候補を黙って破棄 | construction failure + concrete composition test | covered |

Selected trigger matrices:

- Mutation / External Side Effect: Memory commit後・Affect link前のfailureと同一request retryを扱う。
- Owner / Scope / Projection: `local-user`、Character、Session、Memory target、source provenanceを分離する。
- Limit / Concurrency / Resource: WAL、busy timeout、別接続transactionの実重複を扱う。
- Migration / Repair / Existing Data: additive schema ensureとsavepoint rollbackを扱う。

Public IPCや外部protocolは変更せず、UI reactive state、process lifecycle、secret-bearing IPCは対象外のため選択しない。

Triggered review lenses:

- `lifecycle-effect-concurrency`: AF-4、AF-7〜AF-10
- `contract-schema-projection`: AF-1〜AF-3、AF-5、AF-6、AF-11とowner/scope tuple

Unresolved contract decisions: なし。

## Knowledge Placement

- current implementation: source
- expectation、failure mode、concurrency overlap: type、schema、targeted test
- append-only、cross-storage idempotent convergence、Memory supersedeを選ぶ理由: ADR 018
- architecture document:既存V6 foundation文書はsource/ADR pointerだけを維持する
- Candidate Definition、Evidence Ledger、review結果:このtask-local planに保持する

## Done

- Memory episodeの作成、同motif反復、retry、訂正時supersede、forget後のAffect監査保持を実Memory V6で確認する。
- Memory成功後・Affect link前のfailureが同一request retryで重複なく収束する。
- worker barrierを使い、別接続のtransactionが実際に重なる並行appendを確認する。
- schema、typecheck、関連test、全体test、production buildが成功する。
- triggerされた独立reviewを現行Candidateで閉じ、未解決blocking findingを残さない。

## Evidence Ledger

現行Candidateへ含めるsourceとexecutable contractに対し、次を実行した。

| Evidence | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npx tsx --test scripts/tests/character-affect-storage.test.ts`（連続5回） | 各12/12 pass |
| `npx tsx --test scripts/tests/character-affect-storage.test.ts scripts/tests/character-affect-service.test.ts scripts/tests/database-schema-v6.test.ts scripts/tests/memory-v6-storage.test.ts scripts/tests/memory-v6-service.test.ts` | 86/86 pass |
| `npm test` | 2210 tests、2209 pass、1 skip、0 fail |
| `npm run build` | pass。rendererとElectron main/Memory CLIをproduction build |
| `git diff --check` | pass |

最初の全体testは並行test worker終了時の待機が無期限になり得るため中断した。worker exit/error検知と10秒timeoutを追加した後、上記の現行Candidate全体testを完走している。レビュー証拠はCandidate Definition作成後に追記する。

### Candidate ISSUE-251-C1 review

Candidate preflightは`verified`。次のspecialist reviewを期限内に完了した。

- `lifecycle-effect-concurrency`: AF-4、AF-7〜AF-10
- `contract-schema-projection`: AF-1〜AF-3、AF-5、AF-6、AF-11

Finding Promotionでは、5件すべてをsupported scope内で再現可能かつ同じCharacter Affect semantic ownerに属する`current-scope repair`、最終分類`blocking`とした。

1. forgotten Memory episodeの訂正がAffect commit後に恒久失敗する。
2. source session削除後の訂正retryが保持済みledgerを再生しない。
3. relationship eventのpublic projectionがscopeとprovenanceを混同する。
4. optional fieldの明示的undefinedがinvalid JSONまたは別fingerprintになる。
5. `local-user`制約がMemory候補の有無で変わる。

修正後、Memory統合、storage、schema、Memory V6のtargeted testは84/84 pass、typecheckと`git diff --check`はpass。source変更によりC1はsupersededとし、現行Candidateの全体test、build、specialist closureは新Candidateで取り直す。

### Candidate ISSUE-251-C2 targeted closure

Candidate preflightは`verified`。C1のfinding familyを二つのtargeted closureへ渡し、次の同一owner内blocking findingが残った。

1. Affect訂正commit後・Memory commit前の失敗で、retryがpredecessor Memory IDを失いsupersedeしない。
2. relationship eventのmutation projectionが発生元Sessionをscope用`sessionId`として公開する。

訂正eventへ`supersedes_memory_entry_id`を永続化し、retryで同じsupersede tupleを復元する。mutationはscope用`session_id`とprovenance用`source_session_id`を分離する。failure injectionとpublic projection assertionを追加し、修正後targeted testは85/85 pass、typecheckはpass。source変更によりC2はsupersededとし、新Candidateでfinding family closureを取り直す。

### Candidate ISSUE-251-C3 targeted closure

Candidate preflightは`verified`。C2の残存familyをtargeted closureへ渡し、次のblocking findingを同じsupported scopeへpromotionした。

1. 訂正Memory commit後・Affect link前のretryがactive predecessor事前検証で遮断される。
2. mutation provenance列とFKがV6 required schema検証へ含まれず、不完全DBをvalidと判定し得る。

writerの初回事前検証とMemory append時のidempotency replayを分離し、訂正Memory commit後・link前failureの回帰testを追加する。Affectの新しい列とFKをrequired schemaへ追加し、provenance列欠落DBを拒否するnegative testを追加する。source変更によりC3はsupersededとし、現行Candidateでdirect check、closure、holistic reviewを取り直す。

並行testの初期化時に複数workerが同時に`PRAGMA journal_mode=WAL`を実行し、対象transactionが重なる前に`SQLITE_BUSY`となるsetup raceをdirect checkで検出した。append用connectionを順に初期化してから、別connectionのwrite lockと全append transactionをbarrierで重ねる構成へ修正した。修正後のstorage testは連続5回すべて12/12 passであり、write lock保持中にappend結果が返らないことと、解放後の欠落・混線・重複がないことを確認している。

### Candidate ISSUE-251-C4 targeted closure

Candidate preflightは`verified`。`lifecycle-effect-concurrency` closureはAF-7、AF-8、AF-10にblocking finding、accepted risk、validation gapなしで完了した。reviewerによるservice/storageの独立実行は19/19 pass。

`contract-schema-projection` closureでは、required FK検証が参照元列と参照先tableだけを比較し、`ON DELETE` actionを検証しないblocking findingが残った。`source_session_id`を`ON DELETE CASCADE`へ変更したDBをvalidと判定でき、source session削除時にrelationship mutation auditを不可逆に失うため、AF-1、AF-5の`current-scope repair`へpromotionした。

全Character Affect FKを参照元列、参照先table、参照先列、`ON DELETE` actionのtupleで検証し、未列挙だったmutationの`character_id`、`event_id`、`reset_id`とobservationの`session_id`もrequired FKへ追加した。provenance FKを`CASCADE`へ置換したDBを拒否するnegative contractを追加した。修正後、database schema testは13/13、関連targeted testは86/86、typecheck、全体2210 tests（2209 pass、1 skip）、production buildが成功した。source変更によりC4はsupersededとし、最終Candidateで両lensの現行証拠を取り直す。

### Candidate ISSUE-251-C5 targeted closure

Candidate preflightは開始時に`verified`。`contract-schema-projection` closureで、FK欠落fixtureが`source_session_id`列自体も削除してrequired-column検査で先に失敗し、required-FK検査を直接検証していないblocking findingが残った。AF-5のexecutable contract不足として`current-scope repair`へpromotionした。

fixtureは`source_session_id`列を残して対象FKだけを削除し、列の存在とFKの欠落を事前assertしたうえで`isValidV6Database`が拒否する形へ修正した。修正後targeted testは86/86、全体testは2210 tests（2209 pass、1 skip）。C5の`lifecycle-effect-concurrency` reviewerは変更前Candidateの検証後にこのtest差分を検出し、mismatchとして証拠を発行しなかった。C5はsupersededとし、最終Candidateでcontract finding closure、lifecycle delta非影響、holistic reviewを取り直す。

### Candidate ISSUE-251-C6 review

Candidate preflightは`verified`。`contract-schema-projection`と`lifecycle-effect-concurrency`のtargeted closureはいずれもreview前後のidentity一致を確認し、blocking finding、accepted risk、validation gapなしで完了した。

一度だけ実行したfresh holistic complete-diff reviewでは、次の2件をsupported scope内の`current-scope repair`、最終分類`blocking`へpromotionした。

1. relationship eventのrecord idempotency replayがsession owner検証より後にあり、commit後にsource sessionが削除されると同一request retryが失敗する。
2. Affect schema validationが一部CHECKだけを検証し、event `state`などのinvariant-bearing CHECKを欠く既存DBをvalidと判定し得る。

`recordEvent`はcanonical fingerprintとledger replayを先に解決し、新規作成だけsession ownerを検証する。source session削除後も同じrelationship event IDを`created: false`で返し、replay observationを残すcontractを追加した。schema validationは全Character Affect tableのenum、scope、tuple、非空、JSON、range CHECKを検証し、列・index・FKを維持したままevent `state` CHECKだけを欠くDBを拒否するnegative contractを追加した。C6のholistic entryはimmutableな発見記録とし、complete diffの再レビューは行わない。最終Candidateではこの2 familyのdirect check、targeted closure、両specialist lensへのdelta非影響だけを取得する。

### Candidate ISSUE-251-C7 completion

Candidate preflightと最終verificationは`verified`。最終差分では、関連targeted testが86/86、全体testが2210 tests（2209 pass、1 skip）、typecheck、production build、`git diff --check`が成功した。

holistic reviewで検出した2件のfinding familyは、次のtargeted closureで閉じた。

- `ISSUE-251-TC7-CONTRACT`: record replay順序とCharacter Affect CHECK schemaを確認し、blocking finding、accepted risk、validation gapなしでapprove
- `ISSUE-251-TC7-LIFECYCLE`: source session削除後のrelationship lifecycleと並行appendへの非影響を確認し、blocking finding、accepted risk、validation gapなしでapprove

両reviewはC7のverificationをreview前後に実行し、source identityの一致を確認した。C6のholistic complete-diff reviewは一度だけ実行したimmutableな発見記録として保持し、C7の完了根拠にはdirect checkと上記targeted closureを使用する。ISSUE-251の完了条件に対する未解決項目はない。
