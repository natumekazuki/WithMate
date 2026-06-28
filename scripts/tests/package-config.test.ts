import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("package build config", () => {
  it("Windows installer exposes withmate-memory without editing the user Path value", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      build?: {
        extraFiles?: Array<{ from?: string; to?: string }>;
        nsis?: { include?: string };
      };
    };

    assert.deepEqual(
      packageJson.build?.extraFiles?.find((entry) => entry.to === "withmate-memory.cmd"),
      { from: "build/cli/withmate-memory.cmd", to: "withmate-memory.cmd" },
    );
    assert.equal(packageJson.build?.nsis?.include, "build/installer.nsh");

    const installerScript = await readFile("build/installer.nsh", "utf8");
    assert.match(installerScript, /Microsoft\\WindowsApps/);
    assert.match(installerScript, /withmate-memory\.cmd/);
    assert.doesNotMatch(installerScript, /ReadRegStr\s+\$\d+\s+HKCU\s+"Environment"\s+"Path"/);
    assert.doesNotMatch(installerScript, /WriteRegExpandStr\s+HKCU\s+"Environment"\s+"Path"/);
  });
});
