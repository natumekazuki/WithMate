# Coordination Event API Closure Plan

## Scope

通常responseとTurn command busから分離したCoordination Eventを、dedicated storage、shared external runtime、trusted GUI IPC、System Prompt、既存Session右ペインへ一つの契約として追加する。work item、汎用operation ID、external streaming、archive、retentionは対象外とする。

## Closure Plan

### COORD-EVENT-01

- Accepted contract / exact anchor: 添付要求のcanonical event/state契約。本文とaction履歴をdedicated storageの正本とし、本文はappend-only、現在stateは履歴から投影する。correction作成と対象eventのsuperseded化はatomicにcommitする。
- Scope / semantic owner: Coordination event model、strict validator、event/action storage、state projection。
- Failure mode / consumer impact: 本文上書き、部分commit、不正kind/state/payload、private detail保存により、GUIとruntime consumerが履歴または現在状態を誤認する。
- State transitions / failure timing: create validation前、event commit、resolve/cancel action commit、correct transaction、restart後projection。
- Direct verification: model/validator unit、SQLite integration、failure injection、restart projection test。
- Independent review trigger: persistence transactionとpublic projectionを横断する高リスク境界。
- Gate: ready。

### COORD-AUTH-01

- Accepted contract / exact anchor: 添付要求とADR 026。actorはruntime binding、authorityとhierarchyはcanonical Session Role bindingから解決し、Coordination domainで再定義しない。
- Scope / semantic owner: application serviceのactor解決、Session binding lookup、self/subtree/escalation/resolve/cancel/correct authority、trusted GUI principal。
- Failure mode / consumer impact: actor偽装、cross-root/非ancestorの存在漏洩、executor subtree、Agentによるuser decision resolution、他actor eventの変更。
- State transitions / failure timing: replay判定、current binding/target検証、storage mutation前、read projection前。
- Direct verification: strict input、Role matrix、存在秘匿error、effect-none integration test。
- Independent review trigger: authorizationとtrusted GUI resolutionを横断する高リスク境界。
- Gate: ready。

### COORD-IDEM-01

- Accepted contract / exact anchor: 添付要求のprincipal-scoped idempotency、canonical replay before current validation、commit-before-publication、read-back契約。
- Scope / semantic owner: Coordination mutation idempotency table、fingerprint、application publication timing、get by event ID/key。
- Failure mode / consumer impact: response lossで重複event、別principal衝突、同key異input受理、commit後publication失敗によるrollbackまたは再実行。
- State transitions / failure timing: replay lookup、validation、transaction commit、publication、response、restart/retry。
- Direct verification: same/different principal replay、conflict、publication failure、restart/read-back、correct rollback test。
- Independent review trigger: idempotencyとtransaction/publicationの高リスクinteraction。
- Gate: ready。

### COORD-ADAPTER-01

- Accepted contract / exact anchor: 添付要求とADR 021。CLI、MCP、raw HTTPはshared type、strict validator、schema、error envelopeへ収束する。
- Scope / semantic owner: runtime operation catalog、request parser、application dispatch、MCP schema、CLI command map、HTTP dispatch。
- Failure mode / consumer impact: adapterごとのfield差、unknown-field迂回、mutation annotation/effect誤判定、private DTO漏洩。
- State transitions / failure timing: adapter parse、shared parse、dispatch、public result/error projection。
- Direct verification: shared contract test、CLI/MCP schema/dispatch test、HTTP全operation test、build後配布物確認。
- Independent review trigger: multiple public adapter interaction。
- Gate: ready。

### COORD-UI-01

- Accepted contract / exact anchor: 添付要求と既存Session right-pane architecture。eventがある場合だけCoordination tabを出し、未解決優先、detailはprogressive disclosure、user decisionはtrusted GUI IPCだけでresolveする。
- Scope / semantic owner: main IPC query/mutation/signal、renderer request-generation state、right-pane projection/component。
- Failure mode / consumer impact: initial load中event消失、out-of-order/Session切替でstale表示、判断待ちの見落とし、通常chat layout分岐、空説明card。
- State transitions / failure timing: Session選択、initial load、commit後signal、refresh response、option resolution。
- Direct verification: async state owner test、projection/component/IPC test、分離起動visual check。
- Independent review trigger: reactive UIとtrusted mutationのcross-process interaction。
- Gate: ready。

### COORD-PROMPT-01

- Accepted contract / exact anchor: 添付要求。capability、登録条件、失敗時の扱いだけをSession System Promptへ追加し、response形式やprivate bindingを強制・漏洩しない。
- Scope / semantic owner: provider prompt composition。
- Failure mode / consumer impact: Agentが判断待ち登録失敗を隠す、通常response形式が固定される、opaque/private detailがpromptへ漏れる。
- State transitions / failure timing: provider generation prompt composition。
- Direct verification: prompt content/absence test。
- Independent review trigger: none（直接contract testで観測可能）。
- Gate: ready。

## Closure Map

### COORD-EVENT-01 / COORD-IDEM-01

- Canonical owner: Coordination storage transaction。
- Siblings in scope: create、resolve、cancel、correct、event/action load、current projection、empty/populated/repeated migration、restart、response-loss replay。
- Excluded siblings and reason: archive/export/retentionはfirst sliceのsupported scope外。
- Failure points: validation前、transaction中間、commit直後、publication/response失敗、restart。
- Direct checks: payload boundary、append-only row、action order、atomic rollback、canonical replay、summary-only query plan/selected columns。
- Independent review lens: partial commit、replay ordering、projection/data leakage。

### COORD-AUTH-01

- Canonical owner: application serviceとcanonical Session Role binding owner。
- Siblings in scope: self/subtree read、get/list、ancestor target、escalation/blocker/user decision resolution、cancel、correct、execution owner。
- Excluded siblings and reason: Role変更、child作成、Session tree UIはADR 026 ownerで変更対象外。
- Failure points: replay前後、target存在確認、storage mutation前、public projection前。
- Direct checks: all Role/root/ancestor/descendant combinations、not-found-equivalent rejection、execution mismatch effect-none。
- Independent review lens: authority bypass、cross-root existence disclosure、principal-scoped replay。

### COORD-ADAPTER-01 / COORD-PROMPT-01

- Canonical owner: shared runtime contractとapplication service。
- Siblings in scope: CLI、MCP、raw HTTP、runtime catalog、error/effect envelope、System Prompt capability。
- Excluded siblings and reason: external streamingとA2A Turn command busは別ownerかつ対象外。
- Failure points: adapter schema、shared parse、dispatch、response size、prompt composition。
- Direct checks: unknown field rejection、operation/schema parity、mutation effect classification、private field absence。
- Independent review lens: sibling adapter drift。

### COORD-UI-01

- Canonical owner: trusted main IPCとrenderer feed state owner。
- Siblings in scope: initial load、commit signal、out-of-order response、Session selection、tab availability、detail toggle、option resolution。
- Excluded siblings and reason:独自chat layout、Session tree/Role editorは対象外。
- Failure points: request in-flight、signal arrival、old response arrival、selected Session change、mutation response loss。
- Direct checks: generation comparison、refresh coalescing、projection ordering、component interaction、visual smoke。
- Independent review lens: stale overwriteとuntrusted resolution path。

## Test Design Gate

- Storage failure: event本文またはactionが片側だけcommitされる。Consumerは履歴と現在stateを誤認する。OwnerはCoordination SQLite transaction。Observableはrowsとrestart後projection。Layerはintegration。
- Authority failure: request fieldまたは別rootからeventを参照・変更できる。Consumerは機密性とscopeを失う。Ownerはapplication authority boundary。Observableはnot-found-equivalent errorとmutationなし。Layerはapplication integration。
- Adapter failure: CLI/MCP/HTTPで受理fieldまたはerrorがずれる。Consumerはtransportで契約が変わる。Ownerはshared parser/schema projection。Observableは同一input/output/error。Layerはcontract/integration。
- Reactive failure:古いloadが新しいSession/feedを上書きする。Consumerは誤った判断事項を見る。Ownerはrenderer feed state owner。Observableは選択Sessionと表示items。Layerはstate/component interaction。
- Prompt failure:response形式強制またはprivate binding漏洩が起きる。Consumerは通常会話とauthority境界を失う。Ownerはprompt composer。Observableは生成system prompt。Layerはunit。

既存checkはCoordination domainを扱わないためdistinctである。各testはproduction entry/result、DB state、DOM interactionを観測し、private call順やmarkup snapshotは固定しない。

## Validation and review

targeted contract/storage/application/adapter/UI/prompt test、`npm run typecheck`、`npm test`、`npm run build`、分離起動visual checkを実行する。commit済みsourceをclean detached worktreeでcomplete-diff reviewし、blocking findingは同じInvariant familyのdirect checkとtargeted closureで閉じる。
