import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import {
  ManagedSkillDistributionService,
  WITHMATE_GLOSSARY_SKILL_NAME,
  type ManagedSkillBundleDescriptor,
} from "../../src-electron/managed-skill-distribution-service.js";
import {
  BUNDLED_GLOSSARY_CLI_FILE_NAME,
  buildWithMateGlossaryCli,
} from "../build-withmate-memory-cli.js";

const bundlePath = path.resolve("resources", "skills", WITHMATE_GLOSSARY_SKILL_NAME);
const bundle: ManagedSkillBundleDescriptor = {
  skillName: WITHMATE_GLOSSARY_SKILL_NAME,
  bundledSkillPath: bundlePath,
  documentationRelativePaths: ["SKILL.md", "agents"],
};

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function createService(rootPath: string, platform: NodeJS.Platform) {
  const settings = createDefaultAppSettings();
  settings.codingProviderSettings.codex = {
    enabled: true,
    apiKey: "",
    skillRootPath: rootPath,
    skillRelativePath: "skills",
    instructionRelativePath: "",
  };
  return new ManagedSkillDistributionService({
    getAppSettings: () => settings,
    getAppVersion: () => "6.3.25-test",
    isPackagedApp: () => true,
    platform,
    shouldSyncDocumentationOnly: (descriptor) => descriptor.skillName !== WITHMATE_GLOSSARY_SKILL_NAME,
  });
}

describe("withmate-glossary managed distribution", () => {
  it("同じdescriptor ownerでprovider配置、version、digest、managed markerを適用する", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "withmate-glossary-skill-"));
    try {
      const service = createService(rootPath, "linux");
      const first = await service.syncConfiguredProviderSkills(bundle);
      const second = await service.syncConfiguredProviderSkills(bundle);
      const installedPath = path.join(rootPath, "skills", WITHMATE_GLOSSARY_SKILL_NAME);

      assert.equal(first[0].status, "installed");
      assert.equal(second[0].status, "unchanged");
      assert.equal(await pathExists(path.join(installedPath, "SKILL.md")), true);
      assert.equal(await pathExists(path.join(installedPath, "agents", "openai.yaml")), true);
      assert.equal(await pathExists(path.join(installedPath, "bin", BUNDLED_GLOSSARY_CLI_FILE_NAME)), true);
      const marker = JSON.parse(await readFile(path.join(installedPath, ".withmate-managed-skill.json"), "utf8"));
      assert.equal(marker.skillName, WITHMATE_GLOSSARY_SKILL_NAME);
      assert.match(marker.bundleDigest, /^[a-f0-9]{64}$/);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("user-created同名Skillは上書きせず、Windows documentation projectionはCLIを複製しない", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "withmate-glossary-skill-"));
    try {
      const userSkillPath = path.join(rootPath, "skills", WITHMATE_GLOSSARY_SKILL_NAME);
      await mkdir(userSkillPath, { recursive: true });
      await writeFile(path.join(userSkillPath, "SKILL.md"), "user-owned\n", "utf8");
      const service = createService(rootPath, "win32");
      const collision = await service.syncConfiguredProviderSkills(bundle);
      assert.equal(collision[0].status, "skipped-collision");
      assert.equal(await readFile(path.join(userSkillPath, "SKILL.md"), "utf8"), "user-owned\n");

      await rm(userSkillPath, { recursive: true, force: true });
      const installed = await service.syncConfiguredProviderSkills(bundle);
      assert.equal(installed[0].status, "installed");
      assert.equal(await pathExists(path.join(userSkillPath, "agents", "openai.yaml")), true);
      assert.equal(await pathExists(path.join(userSkillPath, "bin")), false);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});

describe("withmate-glossary managed bundle contract", () => {
  it("SkillはMCP-first、proactive条件、effect certaintyを定義し、用語内容やfallback件数を持たない", async () => {
    const skill = await readFile(path.join(bundlePath, "SKILL.md"), "utf8");
    assert.match(skill, /name: withmate-glossary/);
    assert.match(skill, /`withmate-glossary` MCP server/);
    assert.match(skill, /at most one proactive/);
    assert.match(skill, /do not guess, cache, or substitute a fallback limit/);
    assert.match(skill, /`effect: "unknown"`/);
    assert.doesNotMatch(skill, /current limit is|default limit is/i);
    assert.doesNotMatch(skill, /schemaVersion:\s*1\s*$/m);
  });

  it("bundled CLIはcanonical sourceから生成されたcurrent artifactである", async () => {
    const outputDirectoryPath = await mkdtemp(path.join(os.tmpdir(), "withmate-glossary-cli-build-"));
    try {
      const generatedPath = await buildWithMateGlossaryCli(outputDirectoryPath);
      const bundledPath = path.join(bundlePath, "bin", BUNDLED_GLOSSARY_CLI_FILE_NAME);
      assert.equal(await readFile(generatedPath, "utf8"), await readFile(bundledPath, "utf8"));
    } finally {
      await rm(outputDirectoryPath, { recursive: true, force: true });
    }
  });

  it("packagingはWindows command aliasをinstallとuninstallの両方へ含める", async () => {
    const packageDocument = JSON.parse(await readFile("package.json", "utf8")) as {
      build: { extraFiles: Array<{ from: string; to: string }> };
    };
    assert.ok(packageDocument.build.extraFiles.some((entry) =>
      entry.from === "build/cli/withmate-glossary.cmd" && entry.to === "withmate-glossary.cmd"));

    const installer = await readFile(path.join("build", "installer.nsh"), "utf8");
    assert.match(installer, /WITHMATE_GLOSSARY_ALIAS/);
    assert.match(installer, /skills\\withmate-glossary\\bin\\withmate-glossary\.mjs/);
    assert.match(installer, /Delete "\$\{WITHMATE_GLOSSARY_ALIAS\}"/);
  });
});
