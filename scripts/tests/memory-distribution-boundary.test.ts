import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  projectMemoryV6Diagnostics,
  type MemoryV6Diagnostics,
} from "../../src/memory-v6/memory-diagnostics-state.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import {
  ManagedSkillDistributionService,
  WITHMATE_GLOSSARY_SKILL_NAME,
} from "../../src-electron/managed-skill-distribution-service.js";

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

    const providerRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-memory-non-touch-"));
    const skillRoot = path.join(providerRoot, "skills");
    const legacyMemorySkill = path.join(skillRoot, "withmate-memory");
    const sentinelPath = path.join(legacyMemorySkill, "SKILL.md");
    try {
      await mkdir(legacyMemorySkill, { recursive: true });
      await writeFile(sentinelPath, "user-owned legacy skill\n", "utf8");
      const before = await stat(sentinelPath);
      const settings = createDefaultAppSettings();
      settings.codingProviderSettings.codex = {
        enabled: true,
        apiKey: "",
        skillRootPath: providerRoot,
        skillRelativePath: "skills",
        instructionRelativePath: "",
      };
      const service = new ManagedSkillDistributionService({
        getAppSettings: () => settings,
        getAppVersion: () => "test",
        isPackagedApp: () => true,
        platform: "linux",
      });
      await service.syncConfiguredProviderSkills({
        skillName: WITHMATE_GLOSSARY_SKILL_NAME,
        bundledSkillPath: path.resolve("resources", "skills", WITHMATE_GLOSSARY_SKILL_NAME),
        documentationRelativePaths: ["SKILL.md", "agents"],
      });
      const after = await stat(sentinelPath);
      assert.equal(await readFile(sentinelPath, "utf8"), "user-owned legacy skill\n");
      assert.equal(after.mtimeMs, before.mtimeMs);
      await assert.rejects(() => access(path.join(legacyMemorySkill, ".withmate-managed-skill.json")));
    } finally {
      await rm(providerRoot, { recursive: true, force: true });
    }
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

    const projectionInput: MemoryV6Diagnostics & {
      skillSync: { status: string };
      providerSupported: boolean;
    } = {
      generatedAt: "2026-09-03T00:00:00.000Z",
      runtime: {
        status: "running",
        applicationInstanceId: "application-a",
        runtimeGenerationId: "generation-a",
        buildChannel: "development",
        discoveryPublished: true,
      },
      cliShim: {
        platform: "win32",
        commandName: "withmate-memory",
        supported: true,
        status: "managed-by-installer",
        pathContainsShimDirectory: true,
      },
      lastErrors: [],
      skillSync: { status: "installed" },
      providerSupported: true,
    };
    const projected = projectMemoryV6Diagnostics(projectionInput);
    assert.deepEqual(Object.keys(projected).sort(), ["cliShim", "generatedAt", "lastErrors", "runtime"]);
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
