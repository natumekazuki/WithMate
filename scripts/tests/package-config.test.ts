import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  BUNDLED_MEMORY_CLI_PACKAGED_RELATIVE_PATH,
  BUNDLED_MEMORY_CLI_REPOSITORY_RELATIVE_PATH,
} from "../build-withmate-memory-cli.js";

describe("package build config", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "Windows launcherとinstaller aliasはSkill catalog外のcanonical Memory CLI artifactを参照する"
  // oracle = { type = "adr", ref = "ADR-024 CLI artifact canonical path" }
  // failure_mode = "配布launcherが旧Skill directoryを参照し、Skill停止後にCLIまたはMCP serverを起動できない"
  // scope = "withmate-memory-windows-packaging"
  // lifecycle = "permanent"
  // @end-test-value
  it("Windows installer exposes withmate-memory without editing the user Path value", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      build?: {
        files?: string[];
        extraFiles?: Array<{ from?: string; to?: string }>;
        nsis?: { include?: string };
      };
    };

    assert.ok(packageJson.build?.files?.includes("build/icon.ico"));
    assert.deepEqual(
      packageJson.build?.extraFiles?.find((entry) => entry.to === "withmate-memory.cmd"),
      { from: "build/cli/withmate-memory.cmd", to: "withmate-memory.cmd" },
    );
    assert.deepEqual(
      packageJson.build?.extraFiles?.find((entry) => entry.to === "withmate-session.cmd"),
      { from: "build/cli/withmate-session.cmd", to: "withmate-session.cmd" },
    );
    assert.equal(packageJson.build?.nsis?.include, "build/installer.nsh");

    const installerScript = await readFile("build/installer.nsh", "utf8");
    const windowsLauncher = await readFile("build/cli/withmate-memory.cmd", "utf8");
    assert.equal(BUNDLED_MEMORY_CLI_REPOSITORY_RELATIVE_PATH, "resources/cli/withmate-memory.mjs");
    assert.equal(BUNDLED_MEMORY_CLI_PACKAGED_RELATIVE_PATH, "resources/resources/cli/withmate-memory.mjs");
    await assert.rejects(() => access("resources/skills/withmate-memory"));
    assert.match(installerScript, /Microsoft\\WindowsApps/);
    assert.match(installerScript, /withmate-memory\.cmd/);
    assert.doesNotMatch(installerScript, /WITHMATE_SESSION_ALIAS/);
    assert.doesNotMatch(installerScript, /WindowsApps[^\n]*withmate-session\.cmd/);
    assert.match(installerScript, /resources\\resources\\cli\\withmate-memory\.mjs/);
    assert.doesNotMatch(installerScript, /skills\\withmate-memory/);
    assert.match(windowsLauncher, /resources\\resources\\cli\\withmate-memory\.mjs/);
    assert.doesNotMatch(windowsLauncher, /skills\\withmate-memory/);
    assert.doesNotMatch(installerScript, /ReadRegStr\s+\$\d+\s+HKCU\s+"Environment"\s+"Path"/);
    assert.doesNotMatch(installerScript, /WriteRegExpandStr\s+HKCU\s+"Environment"\s+"Path"/);
  });
});
