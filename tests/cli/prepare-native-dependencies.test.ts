import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import type { RebuildOptions } from "@electron/rebuild";
import { prepareNativeDependencies } from "../../scripts/build/prepare-native-dependencies.js";

const artifacts = [
  "conpty.node", "conpty_console_list.node", "pty.node", "winpty.dll", "winpty-agent.exe",
  "conpty/conpty.dll", "conpty/OpenConsole.exe",
];

async function createApp(arch = "x64") {
  const appDir = await mkdtemp(path.join(os.tmpdir(), "withmate-native-packaging-"));
  const ptyRoot = path.join(appDir, "node_modules/node-pty");
  const prebuildDirectory = path.join(ptyRoot, "prebuilds", `win32-${arch}`);
  await mkdir(path.join(prebuildDirectory, "conpty"), { recursive: true });
  await writeFile(path.join(appDir, "package.json"), JSON.stringify({ dependencies: { "node-pty": "1.1.0" } }));
  await writeFile(path.join(ptyRoot, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }));
  await mkdir(path.join(appDir, "node_modules/electron"), { recursive: true });
  await writeFile(path.join(appDir, "node_modules/electron/package.json"), JSON.stringify({ version: "44.1.1" }));
  for (const file of artifacts) await writeFile(path.join(prebuildDirectory, file), "fixture");
  return { appDir, prebuildDirectory };
}

// @test-value v2
// kind = "contract"
// claim = "Windowsはtarget architectureのprebuildを確認後、node-ptyだけを除外して他のnative依存のrebuildを委譲する"
// oracle = { type = "contract", ref = "docs/design/distribution-packaging.md#build-boundary" }
// fault = "全native依存のrebuildを省略するか、host側のarchitecture・Electron版でrebuildする"
// observable = "rebuild APIへ渡された対象除外とtarget設定、およびelectron-builderへの完了応答"
// observation_boundary = "component-behavior"
// scope = "windows-native-packaging"
// lifecycle = "permanent"
// impact = "他native依存のABI不一致やnode-pty再コンパイルにより配布物を生成・起動できない"
// distinction = "単一hostのinstaller smokeでは別architectureとElectron版overrideの委譲を検出できない"
// @end-test-value
it("rebuilds other dependencies for the Windows target using supplied or installed Electron version", async () => {
  for (const arch of ["x64", "arm64"]) {
    const { appDir } = await createApp(arch);
    try {
      const calls: RebuildOptions[] = [];
      const electronVersion = arch === "arm64" ? "44.1.2" : undefined;
      const result = await prepareNativeDependencies(
        { appDir, platform: { nodeName: "win32" }, arch, electronVersion },
        async (options) => { calls.push(options); },
      );
      assert.equal(result, false);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].ignoreModules, ["node-pty"]);
      assert.equal(calls[0].onlyModules, undefined);
      assert.equal(calls[0].buildPath, appDir);
      assert.equal(calls[0].platform, "win32");
      assert.equal(calls[0].arch, arch);
      assert.equal(calls[0].electronVersion, electronVersion ?? "44.1.1");
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Windows target用のnativeファイル・DLL・host executableが欠損または空ならpackagingを拒否する"
// oracle = { type = "contract", ref = "docs/design/distribution-packaging.md#build-boundary" }
// fault = "欠けた付随ファイルや別architectureのprebuildを有効として受け入れる"
// observable = "欠損対象pathを含むrejectとrebuild未呼出し"
// observation_boundary = "component-behavior"
// scope = "windows-native-packaging-preflight"
// lifecycle = "permanent"
// impact = "生成に成功したartifactでTerminal起動・終了時にnative loadが失敗する"
// distinction = "正常なnode_modulesを使う通常buildでは欠損入力の拒否は観測できない"
// @end-test-value
it("rejects missing and empty native artifacts and unavailable target architectures", async () => {
  const { appDir, prebuildDirectory } = await createApp();
  try {
    let rebuildCalls = 0;
    const run = (arch = "x64") => prepareNativeDependencies(
      { appDir, platform: { nodeName: "win32" }, arch },
      async () => { rebuildCalls += 1; },
    );
    for (const file of artifacts) {
      const target = path.join(prebuildDirectory, file);
      await rm(target);
      await assert.rejects(run(), (error: Error) => error.message.includes(target));
      await writeFile(target, "");
      await assert.rejects(run(), (error: Error) => error.message.includes(target));
      await writeFile(target, "fixture");
    }
    await assert.rejects(run("ia32"), /win32-ia32/);
    assert.equal(rebuildCalls, 0);
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Windows以外はWindows prebuildを要求せずelectron-builderの既定native処理へ委譲する"
// oracle = { type = "contract", ref = "docs/design/distribution-packaging.md#build-boundary" }
// fault = "全platformへWindows用の除外を適用してmacOSのnative rebuildを止める"
// observable = "hookのtrue応答とcustom rebuild未呼出し"
// observation_boundary = "component-behavior"
// scope = "non-windows-native-packaging"
// lifecycle = "permanent"
// distinction = "Windows installer smokeでは非Windowsのhook分岐を通らない"
// @end-test-value
it("leaves non-Windows dependency handling to electron-builder", async () => {
  for (const nodeName of ["darwin", "linux"]) {
    let called = false;
    assert.equal(await prepareNativeDependencies(
      { appDir: "unused", platform: { nodeName }, arch: "arm64" },
      async () => { called = true; },
    ), true);
    assert.equal(called, false);
  }
});

// @test-value v2
// kind = "contract"
// claim = "node-pty以外のnative rebuildの失敗をpackaging成功へ変換しない"
// oracle = { type = "contract", ref = "docs/design/distribution-packaging.md#build-boundary" }
// fault = "rebuild例外を握り潰してelectron-builderへ処理完了を返す"
// observable = "rebuild APIの失敗がhook callerへrejectとして伝わる"
// observation_boundary = "component-behavior"
// scope = "windows-native-packaging-errors"
// lifecycle = "permanent"
// distinction = "正常な依存のbuildではnative rebuild失敗経路を通らない"
// @end-test-value
it("propagates other native rebuild failures", async () => {
  const { appDir } = await createApp();
  try {
    const failure = new Error("native rebuild failed");
    await assert.rejects(prepareNativeDependencies(
      { appDir, platform: { nodeName: "win32" }, arch: "x64" },
      async () => { throw failure; },
    ), (error) => error === failure);
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});
