# Public API、migration、review closure

## 担当する範囲

各capability sliceがTypeScript内部だけで完結せず、raw HTTP、CLI、MCP、runtime catalog、managed Skill、migration、reviewまで同じ契約で閉じるための共通手順を定義する。

## Public surface parity

operationのcanonical listは`src/session-external-runtime-contract.ts`に置く。各operationについて次を同じlogical changeで更新する。

- input／output／error／effect TypeScript contract
- strict runtime validator
- Session external application service dispatch
- HTTP statusとversioned error envelope
- raw runtime client
- CLI command mapping、input file、JSON output
- MCP input／output schema、tool metadata、registration
- runtime catalog capability、contract revision、limit
- managed `withmate-session` Skillとoperations reference
- runbook

CLI、MCP、HTTPが個別のauthority判定またはdomain validationを持たない。adapterはtransport変換に限定し、shared application serviceへ渡す。

shell、Git、provider固有toolなどSession Runtime外の実行経路は、公開operationを揃えるだけでは制御できない。provider capability envelopeまたは共通tool brokerで同じgrant、budget、effect recordを強制できるまではvalidation gapとして明示し、WithMate APIだけで完全なauthority enforcementを達成したとは扱わない。

## Operation consolidation

計画に列挙したoperation candidateを機械的に全て追加する必要はない。実装開始時に次を満たす場合はstrict unionへ統合できる。

- 同じcanonical ownerとtransactionを持つ。
- authority、idempotency、effect certaintyが同じである。
- state transitionがinput discriminatorで一意に表現できる。
- destructive annotationと利用者の理解を損なわない。

統合しても、計画にあるcapability、failure mode、direct validationを削らない。逆に、異なるownerやfailure timingを一つのgeneric patch APIへ隠さない。

## Error contract

少なくとも次を区別する。

- invalid input／unknown field
- binding required／stale runtime generation
- forbidden／grant expired／grant scope mismatch
- not found／archived／deleted tombstone
- revision conflict／grant revision conflict／budget conflict
- state conflict／relation conflict／stale aggregate
- budget exhausted／deadline reached
- effect none／committed／partial／unknown
- recovery required

private path、secret、raw provider payload、内部stackをerror detailへ含めない。callerがread-backとrecovery actionを判断するためのstable resource ID、current revision、operation IDは返す。

## 必要な schema と service

- canonical operation registryとstrict input／output validator
- shared application operation dispatchとprincipal resolution
- raw HTTP、CLI、MCP adapterのgeneratedまたは同期検証可能なmapping
- runtime catalogのcapability、contract revision、limit、validation gap projection
- versioned error envelopeとeffect certainty
- migration registry、verifier、repair entry point
- provider capability envelopeまたは共通tool brokerとの接続境界

## Migration strategy

全能力を一つのschema migrationへ詰め込まない。sliceごとにschema revisionを進め、直前revisionからのmigrationとfresh database createを同じ最終schemaへ収束させる。

各migrationは次を検証する。

- empty、populated、malformed database
- table、index、foreign key、triggerの適用順
- failure injectionとrollback
- migration再実行
- verifierとrepair
- current projectionとbaseline event
- owner、grant、budget、result、decision、artifact visibility

table rebuildではforeign key actionによる意図しないchild削除を検出する。旧database fallbackを採る場合、repair不能な新candidateがvalidな旧databaseを隠さない。

## Compatibility

本計画はv6.4.0未releaseのため、外部利用者向けの長期deprecated operationを原則として残さない。repository内のCLI、MCP、managed Skill、GUIは同じrelease内で一括更新する。

ただし、進行中operation、保存済みidempotency record、queued execution、既存database rowはmigration対象であり、コード上の旧operationを消すだけではならない。startup時にcanonical current operationへreconcileするか、明示的なmigration-required errorを返す。

## Test design

実装slice開始時に`design-tests`でfailure modeと最短observableを選ぶ。TypeScript testの新規追加または意味変更は`review-test-value`を通す。

| Boundary | Direct check |
| --- | --- |
| domain state | validator／state machine unitまたはcomponent test |
| transactionとevent | storage integration＋failure injection |
| authority | application service principal／grant integration |
| adapter parity | raw HTTP、CLI、MCP contract test |
| migration | populated schema migrationと二回実行 |
| concurrency／budget | deterministic concurrent admission test |
| filesystem | Windows identity、junction、TOCTOU integration |
| UI projection | state／projection component testと必要なvisual smoke |

testはprivate method call順やmarkup snapshotではなく、state、result、event、owner、effect certainty、public projectionを観測する。

## Direct validation

- canonical operation集合とraw HTTP、CLI、MCP、runtime catalogの公開集合が一致する。
- 全adapterがunknown field、spoof principal、stale generationを同じdomain errorへ正規化する。
- effect-bearing operationのresponse loss後にoperation IDでread-backできる。
- populated databaseとfresh databaseが同じcurrent schemaとprojectionへ収束する。
- migration failure、再実行、repairが既存owner、result、grant、artifact visibilityを失わない。
- provider tool経路ごとにgrantとbudgetの強制可否がruntime catalogのvalidation gapと一致する。

## Commit と review

各sliceのbase commitをtask開始時に固定し、実装、docs、testを一つのlogical changeとして通常commitする。public API、persistence、authority、resource limitを変更するため、各sliceで一回だけcomplete-diff reviewを行う。

review前に次を揃える。

- baseCommitOidとreviewCommitOid
- reviewTargetのclean detached worktree
- included／excluded scope
- accepted contractとInvariant IDs
- executedOnCommitOid付きのcheck結果
- review lensとdeadline

reviewerはpreflightでHEAD、cleanliness、commit object、base ancestryを確認する。findingはroot Agentがaccepted contract、到達条件、consumer impact、Invariant familyで分類する。

finding修正は同じfamilyのdirect checkとresulting delta reviewで閉じる。complete-diff reviewを再実行しない。別semantic ownerの変更はboundary prerequisiteとして別sliceへ分ける。

## Review lens

| Slice | 主なlens |
| --- | --- |
| shared authority | escalation、identity spoof、revoke race、private projection |
| budget | concurrent oversubscription、late usage、reservation leak |
| Session lifecycle | move／delete closure、Character owner、provider generation |
| Work Item lifecycle | source revision、reassign、reopen、provenance |
| aggregation correction | stale propagation、supersede chain、finalize atomicity |
| delegation | partial success、response loss、compensation race |
| routing／transfer | cross-root scope、double owner、draining |
| files／artifacts | containment、TOCTOU、recursive delete、retention |
| root management | aggregate source、cancel／drain race、cleanup classification |

## Integrated release closure

全slice統合後は、各complete diffを再reviewせず、次のcross-slice interactionだけをtargeted reviewする。

- grant revoke中のdelegation compensation
- Session move中のWork Item reassignとbudget ownership
- root transfer中のrunning Turn、artifact、Coordination Event
- result correction後のroot resultとexternal handoff
- archive／reuse後のprovider generationとlate event
- root deadline到達後のcancel、collect、artifact transfer
- Session Runtime外のshell、Git、provider toolがgrantとbudgetを迂回しないこと

最終commitでtypecheck、全test、build、migration rehearsal、必要なvisual／filesystem smokeを実行する。未実行check、validation gap、accepted riskを区別し、未解決blocking findingがないことをrelease条件とする。

## Documentation closure

- authority、event history、delete、budget、artifact identityはADRへ残す。
- current public operationはdesign docとgenerated contractへ反映する。
- CLI、MCP、recovery、budget運用はrunbookへ反映する。
- managed SkillはAgentが利用可能な能力、read-back、retry、compensation、authority境界を説明する。
- 完了したplanはresultとcommit／review evidenceを記録してarchiveする。
