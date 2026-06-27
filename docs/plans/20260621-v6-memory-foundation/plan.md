# V6 Memory Foundation Plan

## 目的

V5 Character-first runtimeを維持したまま、Skill-first Memory accessの基盤を追加する。

## Source of Truth

- `AGENTS.md`
- `docs/design/documentation-map.md`
- `docs/design/v6-database-foundation.md`
- `docs/design/v5-character-transition.md`
- `docs/design/character-storage.md`
- `docs/design/v6-memory-foundation.md`
- `docs/design/provider-adapter.md`
- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/database-schema.md`

## Resume Notes

別環境で再開する場合は、まずこのplanと`docs/design/v6-memory-foundation.md`を読む。
`codex/v6-develop`はV6 Memory開発のbase branchとする。

PR #221が未マージの場合は、Phase 1b response / state contractとして次も確認する。

- https://github.com/natumekazuki/WithMate/pull/221
- branch: `codex/v6-memory-response-design`

PR #221で扱う範囲:

- `MemoryEntrySummary` / `MemoryEntryDetail`
- search responseはactive entryのpreviewのみ
- `memory.get_entry`はfull bodyを返す
- forgotten / superseded / missing entryの通常`get_entry`は`MEMORY_ENTRY_NOT_FOUND`相当
- `memory.append` responseはbodyなしsummaryと`created`
- `memory.forget` responseは複数entryの`results[]`

PR #221以外で次に検討が必要な情報:

- provider binding spike: provider process / agent shell childへturnごとのbindingを注入できるか
- Skill / CLI packaging: global Skill、CLI shim、Skill内`reference/`の配布と更新単位
- V6 DB foundation: DB file name、必要データのみの自動移行、V6 session / message schema

再開時の推奨順序:

1. PR #221が未マージなら先にレビュー / マージする。
2. Phase 0.5としてV6 DB foundationの固定済み境界を確認する。
3. Storage実装前にprovider binding spikeでCLI実装可否を確認する。
4. Skill / CLI referenceはCLI contract確定後に実ファイル化する。

## 変更してよい範囲

- V6 Memory shared contracts
- Main Process Memory storage / service
- localhost server
- CLI
- provider runtime binding abstraction
- global Skill management
- diagnostics
-関連tests / docs

## 変更してはいけない範囲

- `character.md` runtime正本の変更
- Character snapshotのmutable化
- `character-notes.md`の毎turn注入
- provider instruction syncをCharacter注入主経路へ戻すこと
- legacy Memory tableの意味変更
- V5以前session / legacy Memoryの互換migration
- Memory Management Windowの同時復活
- background extraction / Growth / Monologueの同時実装
- SkillとMCPの同時公開
-無関係なprovider refactor

## Phase 0: Docs And Contract

成果物:

- `docs/design/v6-memory-foundation.md`
- `docs/design/v6-database-foundation.md`
- documentation map更新
- API request / response schema
- owner / scope / state decision
- binding / security decision
- capability matrix更新案

完了条件:

- open questionが実装blockerとfollow-upに分類されている。
- legacy / V5 / V6の正本境界が明記されている。
- V6 DB全体再設計とdestructive reset方針が明記されている。
- provider binding spikeをPhase 0/1と並行して開始し、CLI実装前にsupported / unsupportedの見通しを立てる。

## Phase 0.5: V6 Database Foundation

候補path:

```text
docs/design/v6-database-foundation.md
src-electron/database-schema-v6.ts
scripts/tests/database-schema-v6.test.ts
```

内容:

- V6 DB file naming
- migration boundary
- Character / app settings / provider settings / model catalogの自動移行範囲
- V6 sessions / messages / audit / project scope / Memory schema
- legacy session / Memory / GrowthをV6正本へ持ち込まない方針

完了条件:

- V5以前session / legacy Memoryをmigration対象にしない。
- Character catalog、Character definition files、app settings、provider settings、model catalogは必要なデータだけ自動移行する。
- Character file storage rootは現行`<userData>/characters/<character-id>/`を継続する。
- V6 project scopeを専用tableで新設する。
- legacy `project_scopes` / `project_memory_entries`を再利用しない。

## Phase 1a: Request Contract And Validation

候補path:

```text
src/memory-v6/memory-contract.ts
src/memory-v6/memory-validation.ts
scripts/tests/memory-v6-contract.test.ts
```

内容:

- search / append / forget request contract
- refs / kind / tags
- machine-readable error
- normalization / validation
- pure TypeScriptのみで、DB / provider / CLI / runtime bindingに依存しない

完了条件:

- invalid owner / scope combinationを拒否する。
- null byte / size / duplicate tagsを正規化する。
- contractにprovider固有型を含めない。
- project pathのGit解決、Character `current`解決、permission判定はservice層に残す。

## Phase 1b: Response And State Contract

候補path:

```text
src/memory-v6/memory-state.ts
src/memory-v6/memory-response-contract.ts
scripts/tests/memory-v6-response-contract.test.ts
```

内容:

- `MemoryEntry`
- owner / scope / source
- search hit / pagination
- get / tags / append / forget response
- versioned error envelope
- responseに含めるstate / body / preview境界

完了条件:

- all responseに`schemaVersion`がある。
- search hitにfull bodyを含めない。
- normal search responseにforgotten / superseded entryを出さない。
- cursorはopaque stringとして扱う。
- append retryで同じentry responseを返せるshapeを持つ。
- forget responseで対象IDごとの結果を表現できる。

## Phase 2: Storage

Status: 完了

候補path:

```text
src-electron/memory-v6-schema.ts
src-electron/memory-v6-storage.ts
scripts/tests/memory-v6-storage.test.ts
```

内容:

- new tables
- append
- get
- lexical/tag search
- supersede
- forget
- tag catalog
- mutation event

完了条件:

- transaction failureでpartial stateを残さない。
- forgotten / supersededを通常searchから除外する。
- legacy tableへwriteしない。
- V6 DB foundationで定義したtableだけへwriteする。

実装:

- `src-electron/memory-v6-storage.ts`
- `src-electron/memory-v6-schema.ts`
- `scripts/tests/memory-v6-storage.test.ts`

検証:

- `node --test --import tsx scripts/tests/memory-v6-storage.test.ts scripts/tests/memory-v6-contract.test.ts scripts/tests/memory-v6-response-contract.test.ts scripts/tests/database-schema-v6.test.ts scripts/tests/app-database-v6-bootstrap.test.ts`

## Phase 3: Application Service

Status: 完了

候補path:

```text
src-electron/memory-v6-service.ts
src-electron/memory-v6-context-resolver.ts
src-electron/memory-v6-permission.ts
scripts/tests/memory-v6-service.test.ts
```

内容:

- principal resolution
- explicit target resolution
- permission gate
- request orchestration
- deterministic preview fallback
- audit redaction

完了条件:

- agent payloadをそのままSQLへ流さない。
- owner / scope accessをserviceで再検証する。
- `memory.forget`は単一target requestとしてstorage transaction / idempotencyへ委譲する。

実装:

- `src-electron/memory-v6-service.ts`
- `src-electron/memory-v6-context-resolver.ts`
- `src-electron/memory-v6-permission.ts`
- `scripts/tests/memory-v6-service.test.ts`

検証:

- `node --test --import tsx scripts/tests/memory-v6-service.test.ts scripts/tests/memory-v6-storage.test.ts scripts/tests/memory-v6-contract.test.ts scripts/tests/memory-v6-response-contract.test.ts`
- `npx tsc --noEmit --pretty false`
- `npx tsc -p tsconfig.electron.json --noEmit --pretty false`

## Phase 4: Localhost API And CLI

Status: localhost API transport、CLI discovery thin client、app起動配線、runtime discovery file publish、app-internal API guardは完了。binding runtimeは未完了。

候補path:

```text
src-electron/memory-v6-http-server.ts
scripts/withmate-memory.ts
scripts/tests/memory-v6-http-server.test.ts
scripts/tests/withmate-memory-cli.test.ts
```

内容:

- loopback-only server - 完了
- runtime discovery - 完了。CLI defaultはruntime directoryのdiscovery fileを読む。永続userData pathは既定にしない。
- app起動配線 - 完了。app ready時にV6 DBをbest-effortでbootstrapし、localhost APIを起動してruntime discovery fileをpublishする。
- app shutdown cleanup - 完了。quit時にdiscovery fileをbest-effortで削除し、server / storageを停止する。
- app-internal API guard - 完了。runtime APIは短命secretとruntimeInstanceIdを要求し、CLIはsecret/body送信前にnonce challengeでruntime identityを検証してからheaderを送る。
- WithMate起動中チェック - CLI側の`WITHMATE_NOT_RUNNING`は完了
- body / timeout / concurrency limits - 完了
- JSON CLI - 完了
- stable exit codes - 完了

完了条件:

- LAN bindしない。localhost API transportでは`127.0.0.1` default bindとremote address guardで固定済み。
- browser-origin requestを拒否し、POSTは`application/json`だけを受ける。
- CLIはWithMate未起動時に`WITHMATE_NOT_RUNNING`を返す。
- CLIはinvalid `--api-url` / `WITHMATE_MEMORY_API_URL`をdiscovery fallbackせずusage errorにし、HTTP redirectを追従しない。
- runtime endpoint / app-internal secretをlogに出さない。
- idempotency retryで二重appendしない。

実装:

- `src-electron/memory-v6-http-server.ts`
- `src-electron/memory-v6-runtime.ts`
- `src/memory-v6/memory-discovery.ts`
- `scripts/withmate-memory.ts`
- `scripts/tests/memory-v6-http-server.test.ts`
- `scripts/tests/memory-v6-runtime.test.ts`
- `scripts/tests/withmate-memory-cli.test.ts`

検証:

- `node --test --import tsx scripts/tests/memory-v6-http-server.test.ts scripts/tests/memory-v6-service.test.ts scripts/tests/memory-v6-storage.test.ts scripts/tests/memory-v6-contract.test.ts scripts/tests/memory-v6-response-contract.test.ts`
- `node --test --import tsx scripts/tests/memory-v6-runtime.test.ts scripts/tests/withmate-memory-cli.test.ts scripts/tests/memory-v6-http-server.test.ts`
- `node --test --import tsx scripts/tests/withmate-memory-cli.test.ts scripts/tests/memory-v6-http-server.test.ts scripts/tests/memory-v6-service.test.ts`
- `npx tsc --noEmit --pretty false`
- `npx tsc -p tsconfig.electron.json --noEmit --pretty false`

## Phase 5: Provider Binding Spike

Status: 完了。Codex / GitHub Copilot CLI はどちらも env injection を採用する。`context_file` はfallback transportとして型予約し、未確認 provider は `unsupported` とする。

Codex / Copilotで別々に確認する。
このspikeは実装branchと混ぜず、Phase 0/1と並行して早期に行う。CLI contract確定後に最終検証するが、turnごとのenv injection / session-local context file / unsupportedの見通しはstorage実装前に固定する。

確認項目:

- provider process / agent shell childへturnごとの環境変数を注入できるか
- agentに環境変数を読ませず、CLI内部だけでbindingを自動解決できるか
- env injection不可の場合にsession-local context fileでfallbackできるか
- resume / retry / cache挙動
- parallel session isolation
- packaged binary挙動
- sandbox / permissionとの関係

成果物:

- capability matrix更新 - 完了
- provider別strategy決定 - 完了。Codex / GitHub Copilot CLI は env injection
- unsupported時のfallback - 完了。`ProviderMemoryBindingTransport`で`context_file`と`unsupported`を予約

実装:

- `src-electron/provider-memory-binding.ts`
- `src-electron/provider-runtime.ts`
- `src-electron/session-runtime-service.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/copilot-adapter.ts`
- `src-electron/provider-support.ts`
- `scripts/tests/provider-memory-binding.test.ts`

検証:

- `node --test --import tsx scripts/tests/provider-memory-binding.test.ts scripts/tests/provider-support.test.ts scripts/tests/copilot-adapter.test.ts scripts/tests/session-runtime-service.test.ts`

## Phase 6: Binding Runtime

Status: 前半完了。main process memoryのbinding registry、CLIのbinding reference header送信、runtime APIのprincipal解決、turn終了 / session delete / app quit相当の失効を接続した。provider別専用binding moduleとcontext_file transport実体は未実装。

候補path:

```text
src-electron/memory-binding-registry.ts
src-electron/provider-memory-binding.ts
src-electron/memory-v6-runtime.ts
src-electron/memory-v6-http-server.ts
scripts/withmate-memory.ts
```

完了条件:

- 1 sessionのbindingを別sessionから使えない - 前半完了
- revoke後は即時拒否する - 前半完了
- app quit / session deleteで失効する - 前半完了

後続:

- provider execution invalidationとの専用接続を確認する。
- `context_file` transportを実際に使うproviderが出た時点で専用moduleを追加する。
- runtime binding必須capabilityのUI/diagnostics露出はPhase 8へ回す。

検証:

- `node --test --import tsx scripts/tests/memory-binding-registry.test.ts scripts/tests/memory-v6-http-server.test.ts scripts/tests/memory-v6-runtime.test.ts scripts/tests/withmate-memory-cli.test.ts scripts/tests/session-runtime-service.test.ts`
- `npm run typecheck`

## Phase 7: Global Skill

Status: 完了。設定済み provider skill root へ app 管理の `withmate-memory` Skill を同期し、未設定 provider は skip、同名 user Skill は上書きせず collision として記録する。Skill内にcurrent raw JSON CLI contract用のstandalone helper scriptを同梱する。

候補:

```text
resources/skills/withmate-memory/SKILL.md
src-electron/managed-memory-skill-service.ts
```

内容:

- install / update / version
- collision handling
- CLI usage
- runtime binding / explicit target selection
- no duplicate MCP

完了条件:

- user Skillを無断上書きしない。完了。managed marker がある `withmate-memory` だけ更新し、非管理同名Skillは `skipped-collision` にする。
- binding情報をSkill本文へ書かない。完了。Skill本文はCLI利用方針とtarget selectionだけを説明し、secret / binding reference / discovery detailは書かない。

実装:

- `resources/skills/withmate-memory/SKILL.md`
- `resources/skills/withmate-memory/reference/cli.md`
- `resources/skills/withmate-memory/bin/withmate-memory.mjs`
- `resources/skills/withmate-memory/bin/withmate-memory.cmd`
- `src-electron/managed-memory-skill-service.ts`
- `scripts/tests/managed-memory-skill-service.test.ts`

検証:

- `node --test --import tsx scripts/tests/managed-memory-skill-service.test.ts scripts/tests/skill-discovery.test.ts scripts/tests/main-query-service.test.ts`
- `npm run typecheck`

## Phase 8: Diagnostics

- endpoint状態
- binding capability
- Skill install状態
- last error summary
- secret redaction

## Verification

実行commandはcurrent `package.json`を確認してから使う。

最低限:

```bash
npm run typecheck
npm test
npm run build
```

Electron manual:

- Codex session A / Bを同時起動してcross-session searchできない。
- Copilot session A / Bも同様。
- Character A / Bでownerが混ざらない。
- projectを変えるとproject search結果が分離される。
- app終了後に旧bindingが使えない。
- Skill無し / CLI無し / server停止で通常turnが継続する。

## Rollback

- feature flagでagent-facing entrypointを無効化できるようにする。
- V6 DBは既存runtime DBと分離し、旧DBはV6 runtimeの正本にしない。backup renameするか、そのまま残して無視するかはrelease packagingで決めてよい。
- global Skillはmanaged markerを確認してuninstall可能にする。
- V5 Character prompt pathは変更前のまま維持する。
