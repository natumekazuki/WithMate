import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @test-value v2
// kind = "contract"
// claim = "Windows配布のGlossary／Session CLI launcherとinstaller aliasが同梱artifactを参照し、user Path registryを変更しない"
// oracle = { type = "contract", ref = "docs/design/distribution-packaging.md" }
// fault = "CLIを同梱せず、aliasが異なるartifactを参照するかuser Pathを書き換える"
// observable = "package extraFiles、launcher本文、installerの登録先と参照artifact"
// observation_boundary = "declaration"
// scope = "windows-cli-packaging"
// lifecycle = "permanent"
// distinction = "型検査やCLI単体buildではWindows installerとlauncherの相互参照を確認できない"
// @end-test-value
/** Glossary／Session CLIの同梱とWindowsAppsへの登録を検査し、配布設定の参照ずれやuser Pathの直接編集を検出する。 */
test("Windows installer exposes the packaged CLIs without editing user Path", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const installer = await readFile("build/installer.nsh", "utf8");
  assert.equal(packageJson.build.nsis.include, "build/installer.nsh");
  // 各launcherとaliasが、そのCLIの配布先を指すことを確認する。
  for (const [name, artifact] of [
    ["session", "cli/withmate-session.mjs"],
    ["glossary", "skills/withmate-glossary/bin/withmate-glossary.mjs"],
  ]) {
    const command = `withmate-${name}.cmd`;
    assert.deepEqual(packageJson.build.extraFiles.find((entry: { to: string }) => entry.to === command),
      { from: `build/cli/${command}`, to: command });
    const launcher = await readFile(`build/cli/${command}`, "utf8");
    const packaged = `resources\\resources\\${artifact.replaceAll("/", "\\")}`;
    assert.ok(launcher.includes(packaged));
    assert.ok(installer.includes(packaged));
    assert.ok(installer.includes(command));
  }
  assert.match(installer, /Microsoft\\WindowsApps/);
  assert.doesNotMatch(installer, /ReadRegStr\s+\$\d+\s+HKCU\s+"Environment"\s+"Path"/);
  assert.doesNotMatch(installer, /WriteRegExpandStr\s+HKCU\s+"Environment"\s+"Path"/);
});
