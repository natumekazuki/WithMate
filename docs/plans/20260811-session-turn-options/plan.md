# Plan

- 作成日: 2026-08-11
- タスク: Session scoped Turn Options の外部公開
- 状態: Complete

## Goal

- `turn.options`をCLI/MCP共通のapplication operationとして公開する
- 対象の通常Sessionで`turn.run`と`turn.enqueue`へ指定できるmodel、reasoning、approval、sandboxの組を、現在のcatalog revisionとともに取得できるようにする
- callerがGUIまたはSessionの保存済みdefaultへ依存せず、明示的で検証可能なTurn requestを構築できるようにする

## Accepted Contract Anchors

- `docs/adr/021-session-cli-mcp-application-boundary.md`
- `docs/design/session-external-runtime.md`
- `src/model-catalog.ts`
- `src/approval-mode.ts`
- `src/codex-sandbox-mode.ts`
- `src/session-external-runtime-contract.ts`

exact request、result、error、provider capabilityの組は、実装時に追加するshared type、validator、application contract testを正本とする。

## Scope

- `turn.options`のstrict input schemaとallowlist result projection
- 通常Sessionの存在、kind、providerを確認するSession scoped query
- 現在のmodel catalogから対象providerのmodelとreasoningの有効な組を投影する処理
- 対象providerで利用可能なapproval modeとsandbox modeの投影
- catalog revisionとSession providerの整合を保つapplication service統合
- CLI command、MCP tool、配布bundle、runbook
- shared contract、application service、CLI、MCPのtargeted test

## Out Of Scope

- `turn.run`または`turn.enqueue`のinput変更
- Sessionの保存済みmodel、reasoning、approval、sandbox、custom agentの更新
- GUIの選択状態やdefault値の返却
- Character selector
- provider未対応のcustom agentまたはprovider固有optionを空の汎用fieldとして先行公開すること
- interaction、attachment、transcript、Session file API
- execution、queue、idempotency、migrationの変更

## Task Brief

- Target behavior: `{ sessionId }`を受け取り、対象Sessionで現在選択可能なTurn optionとcatalog revisionを返す
- Failure modes: unknown field、Session不在、通常Session以外、catalog不在、Session provider不在、response上限超過を副作用なしのstable application errorへ変換する
- Canonical owner: shared public schemaは`src/session-external-runtime-contract.ts`、Session scoped解決はElectron Main ProcessのSession application/query境界、model/reasoningの候補はmodel catalog
- Done: CLI/MCPが同じprojectionとerrorを返し、`turn.run`/`turn.enqueue`の既存accepted inputを構築するのに必要な選択肢を欠かさず、private path、Session default、内部provider設定を返さない

## Pre-Implementation Closure Plan

- Gate: `ready`
- Unresolved contract decisions: なし。初期surfaceで外部作成可能な通常SessionはCodexであり、公開済みTurn requestが要求するmodel、reasoning、approval、sandboxを本sliceのprojection対象とする
- Canonical owners:
  - operation ID、input、result、error: shared Session runtime contract
  - Session存在、kind、provider: Session storage/query boundary
  - catalog revision、model、reasoning tuple: model catalog
  - approval、sandbox capability: provider runtime option boundary
  - transport mapping: CLI/MCP adapter
- Sibling channels: loopback JSON runtime、CLI、MCP。GUI IPCは既存catalog/runtime option取得を維持し、本operationを経由させない
- Failure timing: 全処理をread-onlyとし、validationまたは解決失敗はSession、execution、idempotency、Window、providerへ副作用を生じさせない
- Trigger matrices: Public API / Validation / Projection、Coupled Invariant / Versioned Selection、Owner / Scope / Projection、Limit / Resource
- Not triggered: persistence、migration、mutation idempotency、external side effect、concurrency、Window lifecycle
- Gate re-evaluation after specialist finding: `ready`。現行Copilot Sessionとdisabled Codex providerを新しいcapability/availability軸として追加した。`turn.run` inputをprovider別へ変更しない本sliceでは、正確な必須sandbox optionを構築できない非Codex providerを`RUNTIME_UNAVAILABLE`、disabled providerを`PROVIDER_DISABLED`でread-only拒否し、Codexだけを既存approval/sandbox ownerから投影する

## Invariant Matrix

| ID | Invariant | Scope / owner | Failure mode | Consumer impact | Direct verification | Status |
| --- | --- | --- | --- | --- | --- | --- |
| TURN-OPTIONS-SCHEMA-01 | `turn.options`はstrictな`{ sessionId }`だけを受理し、CLI/MCP/loopbackで同じoperation contractを使う | shared runtime contract | adapterごとにunknown fieldや空IDの扱いが分岐する | callerがsurface依存のrequestを必要とする | raw/shared/CLI/MCP contract tests | covered |
| TURN-OPTIONS-OWNER-02 | optionはrequestで指定した通常Sessionのproviderから解決し、GUIのactive SessionやWindowを参照しない | Session application/query boundary | 別Sessionまたはactive Windowのproviderを使う | callerが対象Sessionでは無効なTurnを構築する | 複数Session、Windowなし、unsupported kind/provider tests | covered |
| TURN-OPTIONS-CATALOG-03 | resultのrevision、model、reasoning tupleは同じcurrent catalog snapshotから構築する | model catalog projection | revisionと候補が異なるsnapshot由来になる | 取得直後のTurnが不正tupleまたはstale扱いになる | revision切替、provider/model/reasoning tuple tests | covered |
| TURN-OPTIONS-CAPABILITY-04 | approvalとsandboxは対象providerで受理可能な値だけを返し、Session defaultを候補または推奨値として混ぜない | provider runtime option boundary | UI保存値を正当な全候補と誤認する | 明示指定契約がdefault fallbackへ崩れる | allowlist、Session default非投影、unsupported value tests | covered |
| TURN-OPTIONS-PROJECTION-05 | resultはpublic identifier、label、option valueだけをallowlistし、private path、settings、raw catalog objectを返さない | shared result projection | internal objectのspreadでprivate情報が漏れる | CLI/MCP callerへの内部情報露出 | exact deep-equalityとresponse size boundary tests | covered |
| TURN-OPTIONS-EFFECT-06 | success/errorともread-onlyで、Window作成・表示・focus、broadcast、execution作成を行わない | application composition | queryがGUI lifecycleまたはexecution ownerへ副作用を出す | 操作中断または見えない状態変更 | dependency spyでmutation/window/publication非依存を確認 | covered |

## Implementation Slices

1. shared operation/type/validator/result projectionを追加し、TURN-OPTIONS-SCHEMA-01とTURN-OPTIONS-PROJECTION-05を直接testで固定する
2. Session scoped option resolverをapplication serviceへ接続し、TURN-OPTIONS-OWNER-02、TURN-OPTIONS-CATALOG-03、TURN-OPTIONS-CAPABILITY-04、TURN-OPTIONS-EFFECT-06を直接testで閉じる
3. CLI/MCP schema、command、bundle、runbookを接続し、surface間の同一projectionとstable error mappingを検証する
4. typecheck、targeted test、build、全体testを実行し、Invariant MatrixとCompletion Evidenceを更新する

各sliceはsource、適用可能なexecutable contract、targeted checkが揃うまで完了扱いにしない。

## Validation

- shared request parserとresult projectionのtargeted tests
- Session不在、unsupported kind/provider、catalog不在、revision切替のapplication service tests
- model/reasoning、approval、sandboxのexact allowlist tests
- Window、broadcast、execution、persistenceへ副作用がないことのcomposition-level test
- CLI process contract test
- MCP tool schemaとstructured result contract test
- `npm run typecheck`
- `npm run build`
- `npm test`

## Review Convergence

- public projectionとversioned selectionのinteractionは、implementation-complete Candidateへ`contract-schema-projection` lensのtargeted reviewを一度だけ行う
- findingはaccepted contract違反かつ現実的に到達する`current-scope repair`だけを本sliceへ戻す
- 修正後は対象finding familyとresulting deltaのtargeted closureを一度だけ行い、探索reviewを再開しない
- Full-review gateの既定は`skip`。targeted checkと上記lensで直接検証できない具体的なcross-subsystem interactionが残る場合だけ`run`を再判定する

## Knowledge Placement

- exact public schemaとvalidationはtype/testへ置く
- Session scoped option解決の局所的な責務はsource構造で表現する
- 本sliceはADR 021のaccepted decisionを実装するため、新しい選択肢または長期trade-offが判明しない限りADRを追加しない
- CLIの利用方法が変わるため`docs/runbooks/session-cli.md`を更新する

## Open Questions

- なし。custom agentまたはprovider固有optionを公開できるproviderを外部Session作成へ追加するときは、そのproviderのaccepted request schemaとcapability ownerを先に確定し、`turn.options`と`turn.run`/`turn.enqueue`を同じ論理変更で拡張する

## Completion Evidence

- Targeted contract tests: shared contract、application service、CLI、MCPの59件がGreen
- Typecheck: `npm run typecheck`がGreen
- Production build: `npm run build`がGreen。Session CLI配布bundleを再生成済み
- Full test: 2442件中2440件pass、1件skip、変更外の`FileRootGitChangesService` deadline testが1件failure。直前の全体testでは同testを含めfailure 0で、失敗した1件の単独再実行はGreenのため、timing-dependentなvalidation gapとして分離した
- Targeted review: Candidate `session-turn-options-c1`のcontract-schema-projection lensで、非Codex SessionへのCodex option誤投影とdisabled providerへのsuccess返却を`current-scope repair`に分類した。Candidate `session-turn-options-c2`のtargeted closureで両方のfinding familyがclosed、blocking remainingは0
- Full-review gate: `skip`。public projection、provider capability、read-only effectはtargeted contract testと独立したcontract-schema-projection reviewで直接確認でき、未確認のcross-subsystem interactionは残っていない
- Structure convergence gate: `not-applicable / no-topology-evidence`。既存のshared contract、Session CRUD query、catalog projection、CLI/MCP adapter境界へ一つのread-only operationを追加しており、semantic owner分散、独立責務の混在、canonical boundary迂回、test couplingのevidenceはない
- ADR gate: 既存ADR 021のaccepted application boundaryを実装しており、新しい長期判断はないため追加不要
- Architecture document gate: `docs/design/session-external-runtime.md`のoperation mapは既に`turn.options`を保持する。利用手順だけをrunbookへ追加した
