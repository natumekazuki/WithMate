import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("Memory distribution boundary", () => {
  // @test-value v1
  // kind = "invariant"
  // claim = "WithMateの起動とSettings経路はMemory Skill catalogを所有せず、managed distributionはGlossaryだけを扱う"
  // oracle = { type = "adr", ref = "ADR-024 distribution boundary" }
  // failure_mode = "upgradeまたはSettings操作がprovider側の既存withmate-memory Skill directoryを検査、更新、削除する"
  // scope = "withmate-memory-distribution-stop"
  // lifecycle = "permanent"
  // @end-test-value
  it("Memory Skill catalogとmanaged sync入口をrepositoryから除外する", async () => {
    const mainSource = await readFile("src-electron/main.ts", "utf8");
    const distributionSource = await readFile("src-electron/managed-skill-distribution-service.ts", "utf8");

    await assert.rejects(() => access("resources/skills/withmate-memory"));
    assert.doesNotMatch(mainSource, /MANAGED_MEMORY_SKILL|syncManagedMemorySkill|memory-v6\.skill\.sync/);
    assert.match(mainSource, /MANAGED_GLOSSARY_SKILL_BUNDLE/);
    assert.match(mainSource, /syncManagedGlossarySkillBestEffort/);
    assert.doesNotMatch(distributionSource, /withmate-memory|ManagedMemory/);
  });

  // @test-value v1
  // kind = "contract"
  // claim = "Memory diagnosticsはgeneratedAt、runtime、cliShim、lastErrorsだけを投影し、SettingsはSkill同期とprovider sampleを表示しない"
  // oracle = { type = "adr", ref = "ADR-024 diagnostics projection" }
  // failure_mode = "managed Skill停止後もprovider状態、Skill同期結果、Memory provider instructionがrendererへ公開される"
  // scope = "memory-diagnostics-public-projection"
  // lifecycle = "permanent"
  // @end-test-value
  it("diagnosticsとSettingsからmanaged Skill projectionを除外する", async () => {
    const diagnosticsSource = await readFile("src/memory-v6/memory-diagnostics-state.ts", "utf8");
    const settingsSource = await readFile("src/settings/SettingsContent.tsx", "utf8");

    assert.doesNotMatch(diagnosticsSource, /skillSync|providerSupported|skillRootConfigured/);
    assert.doesNotMatch(settingsSource, /Managed Skill|Provider Instruction Sample|Copy Sample/);
    await assert.rejects(() => access("src/memory-v6/provider-instruction-sample.ts"));
  });

  // @test-value v1
  // kind = "security"
  // claim = "application wiringはactor Session authority、共通turn coordinator、canonical CLI artifact pathをruntimeへ接続する"
  // oracle = { type = "adr", ref = "ADR-024 runtime binding and canonical artifact owners" }
  // failure_mode = "main wiringが旧Skill path、caller identity、またはMemory専用turn mapへ戻りauthority境界が迂回される"
  // scope = "provider-common-memory-main-wiring"
  // lifecycle = "permanent"
  // @end-test-value
  it("mainはcanonical authorityと共有turn coordinatorを配線する", async () => {
    const mainSource = await readFile("src-electron/main.ts", "utf8");

    assert.match(mainSource, /buildProviderAgentRuntimeAuthoritySnapshot/);
    assert.match(mainSource, /resolveMemoryV6ProjectCandidate/);
    assert.match(mainSource, /providerAgentRuntimeTurns,/);
    assert.match(mainSource, /resolveBundledMemoryCliScriptPath/);
    assert.doesNotMatch(mainSource, /bundledMemorySkillPath|resources[\\/]+skills[\\/]+withmate-memory/);
  });
});
