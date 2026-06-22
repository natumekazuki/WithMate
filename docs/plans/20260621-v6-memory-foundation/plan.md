# V6 Memory Foundation Plan

## 目的

V5 Character-first runtimeを維持したまま、Skill-first Memory accessの基盤を追加する。

## Source of Truth

- `AGENTS.md`
- `docs/design/documentation-map.md`
- `docs/design/v5-character-transition.md`
- `docs/design/character-storage.md`
- `docs/design/v6-memory-foundation.md`
- `docs/design/provider-adapter.md`
- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/database-schema.md`

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
- Memory Management Windowの同時復活
- background extraction / Growth / Monologueの同時実装
- SkillとMCPの同時公開
-無関係なprovider refactor

## Phase 0: Docs And Contract

成果物:

- `docs/design/v6-memory-foundation.md`
- documentation map更新
- API request / response schema
- owner / scope / state decision
- binding / security decision
- capability matrix更新案

完了条件:

- open questionが実装blockerとfollow-upに分類されている。
- legacy / V5 / V6の正本境界が明記されている。
- provider binding spikeをPhase 0/1と並行して開始し、CLI実装前にsupported / unsupportedの見通しを立てる。

## Phase 1: Shared Contract

候補path:

```text
src/memory-v6/memory-contract.ts
src/memory-v6/memory-state.ts
src/memory-v6/memory-validation.ts
scripts/tests/memory-v6-contract.test.ts
```

内容:

- versioned request / response
- refs / kind / state / tags
- machine-readable error
- normalization / validation

完了条件:

- invalid owner / scope combinationを拒否する。
- null byte / size / duplicate tagsを正規化する。
- contractにprovider固有型を含めない。

## Phase 2: Storage

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

## Phase 3: Application Service

候補path:

```text
src-electron/memory-v6-service.ts
src-electron/memory-v6-context-resolver.ts
src-electron/memory-v6-permission.ts
```

内容:

- context resolution
- permission gate
- request orchestration
- deterministic preview fallback
- audit redaction

完了条件:

- agent payloadをそのままSQLへ流さない。
- owner / scope accessをserviceで再検証する。

## Phase 4: Localhost API And CLI

候補path:

```text
src-electron/memory-v6-http-server.ts
scripts/withmate-memory.ts
scripts/tests/memory-v6-http-server.test.ts
scripts/tests/withmate-memory-cli.test.ts
```

内容:

- loopback-only server
- auth header
- body / timeout limits
- JSON CLI
- stable exit codes

完了条件:

- LAN bindしない。
- tokenをlogに出さない。
- idempotency retryで二重appendしない。

## Phase 5: Provider Binding Spike

Codex / Copilotで別々に確認する。
このspikeは実装branchと混ぜず、Phase 0/1と並行して早期に行う。CLI contract確定後に最終検証するが、env / context file / unsupportedの見通しはstorage実装前に固定する。

確認項目:

- provider process起動時のenv injection
- agent shell childへの継承
- resume / retry / cache挙動
- parallel session isolation
- packaged binary挙動
- sandbox / permissionとの関係

成果物:

- capability matrix更新
- provider別strategy決定
- unsupported時のfallback

## Phase 6: Binding Runtime

候補path:

```text
src-electron/memory-binding-registry.ts
src-electron/provider-memory-binding.ts
src-electron/codex-memory-binding.ts
src-electron/copilot-memory-binding.ts
```

完了条件:

- 1 sessionのbindingを別sessionから使えない。
- revoke後は即時拒否する。
- app quit / session deleteで失効する。

## Phase 7: Global Skill

候補:

```text
resources/skills/withmate-memory/SKILL.md
src-electron/managed-skill-service.ts
```

内容:

- install / update / version
- collision handling
- CLI usage
- bound / explicit mode
- no duplicate MCP

完了条件:

- user Skillを無断上書きしない。
- binding情報をSkill本文へ書かない。

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
- V6 tableは既存runtime tableと分離する。
- global Skillはmanaged markerを確認してuninstall可能にする。
- V5 Character prompt pathは変更前のまま維持する。
