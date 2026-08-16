# master / v6.4 Session runtime 統合計画

## Goal

`master` の現行runtime境界を正本として取り込み、v6.4で追加したSession CLI/MCP、外部Turn実行、queue、interaction、files、transcript、managed Skillを失わずに再接続する。統合後、Agent runtime bindingからactor Sessionを解決する狭い公開操作を追加する。

## Scope

- `master` のAgent runtime binding、terminal commit、Workspace validation、prompt composition、app lifecycleを採用する。
- v6.4のSession external runtimeと17 operationsを維持する。
- binding必須の`session.self`を追加し、既存のeffect-bearing operationは明示`sessionId`を維持する。
- DB schemaとmigrationはmaster / v6.4双方のtable、column、repairを保持する。
- Codex / Copilot実接続は今回の検証対象外とする。

## Authority

- local sourceのmerge、競合解消、必要な実装、test更新、非破壊的な検証、merge commitを行う。
- push、PR操作、Codex / Copilotへの実接続は行わない。
- `AGENTS.md`は変更・commit対象にしない。

## Invariants

### INT-SELF-01: actor Session identity

- Accepted contract / exact anchor: `docs/adr/021-agent-runtime-binding-authority-boundary.md`の、request由来のSession IDをactor identityにせず、main processのbinding registryで解決する契約。既存Session external runtimeはcross-Session targetを明示`sessionId`で選ぶ。
- Scope / semantic owner: Agent runtime binding registryとSession runtime exchange principal。
- Failure mode / consumer impact: request bodyによるidentity上書き、stale bindingのfallback、別Sessionへの誤帰属。
- State transitions / failure timing: binding発行、provider childへの伝播、MCP/CLI request、resolve、revoke、retry。
- Direct verification: valid bindingでself解決、missing / invalid / revoked bindingの拒否、明示target operationのschema維持。
- Independent review trigger: authorityとbinding伝播をtargeted reviewする。
- Gate: ready。

### INT-TERM-01: durable terminal outcome

- Accepted contract / exact anchor: provider Turnの成功・失敗はdurable terminal Session commitをforeground完了条件とし、audit enrichment、affect appraisal、cleanup失敗はterminal outcomeを反転させない。
- Scope / semantic owner: Session terminal commit owner。external execution projectionはその結果へ従属する。
- Failure mode / consumer impact: provider effect適用後にfailed / not_appliedを返す、Sessionとexternal executionのterminal状態が分岐する。
- State transitions / failure timing: provider settle、terminal commit、response loss、cleanup、background enrichment。
- Direct verification: success / failure / cleanup failure時のSessionとexecution終端状態を観測する。
- Independent review trigger: terminal commitとexternal executionのcross-subsystem interactionをtargeted reviewする。
- Gate: ready。

### INT-LIFE-01: single shutdown owner

- Accepted contract / exact anchor: app lifecycleがquitを単一所有し、admission停止後にruntime、provider、binding、storeを依存の逆順で一度だけ閉じる。
- Scope / semantic owner: `AppLifecycleService`。Session external runtime shutdownはparticipantとする。
- Failure mode / consumer impact:二重quit / store close、running execution残留、bindingやlistenerの解放漏れ。
- State transitions / failure timing: before-quit、draining、handler settle、provider invalidate、binding revoke、store close、quit。
- Direct verification: lifecycle testで順序、一回性、in-flight判定を確認する。
- Independent review trigger: targeted testで順序を直接観測できるためnone。
- Gate: ready。

### INT-WORKSPACE-01: common workspace admission

- Accepted contract / exact anchor: Session Turnはprovider dispatch前にcurrent Workspaceの存在、directory種別、accessibilityを共通validation ownerで確認する。
- Scope / semantic owner: Workspace validation service。GUI run、external run、enqueue、queue admissionをsiblingsとする。
- Failure mode / consumer impact:外部入口だけvalidationを迂回、queue待機中に無効化されたWorkspaceへdispatchする。
- State transitions / failure timing: immediate admission、enqueue、dequeue admission、dispatch直前。
- Direct verification:各入口のinvalid Workspace拒否と、queued Turnの再検証。
- Independent review trigger: none。
- Gate: ready。

### INT-ATTACH-01: immutable attachment snapshot

- Accepted contract / exact anchor: admitted attachmentはprovider dispatch前にidentity-bound snapshotへ固定し、providerはlive originではなくsnapshotを消費する。
- Scope / semantic owner: attachment snapshot leaseとprovider adapter input。
- Failure mode / consumer impact:promptのFolder Contextやrelative pathがlive SessionFolderを指し、admission後の変更をproviderが読む。
- State transitions / failure timing:validation、snapshot、provider dispatch、cleanup。
- Direct verification: adapterへ渡るpath / additional directoryがsnapshot rootへ解決されることをcontract testで観測する。
- Independent review trigger: Codex / Copilot実接続を今回除外するため、packaged provider smokeはvalidation gapとして残す。
- Gate: ready。

### INT-MIGRATE-01: additive schema repair

- Accepted contract / exact anchor: supported旧schemaからのmigration / repairで既存Session、Turn、public context、Memory、Affect dataを保持し、再実行で同じfinal schemaへ収束する。
- Scope / semantic owner: database schema v6 migration。
- Failure mode / consumer impact:table rebuild時のcascade data loss、masterまたはv6.4 column/tableの欠落、partial repair。
- State transitions / failure timing:empty / populated old schema、rebuild、DROP、restore、failure、rerun。
- Direct verification:既存migration testsとauxiliary repair regressionを現行merge差分へ実行する。
- Independent review trigger: migration/data-loss lensをtargeted reviewする。
- Gate: ready。

## Integration sequence

1. `master`をmergeし、masterのsemantic ownerを残してtext conflictを解消する。
2. external executionをmasterのterminal commit、lifecycle、Workspace validationへ再接続する。
3. prompt compositionをmaster順序へ合わせ、Session Contextをnon-authoritative hintとして配置する。
4. Session runtime exchangeへbinding principalを追加し、`session.self`を公開する。
5. migration、runtime、contract、lifecycleのtargeted checks、typecheck、buildを実行する。
6. visual-check用profileでElectronを分離起動し、起動まで確認する。

## Deferred validation

- Codex / Copilot provider processからSession MCPへbinding environmentが継承されるpackaged smoke。
- Codex / Copilotがattachment snapshot pathを実際に読み取るE2E。
