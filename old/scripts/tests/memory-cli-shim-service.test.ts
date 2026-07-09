import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { MemoryCliShimService } from "../../src-electron/memory-cli-shim-service.js";

describe("MemoryCliShimService", () => {
  it("macOS/Linux では ~/.local/bin shim の PATH 状態を診断して install/uninstall できる", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "withmate-cli-shim-home-"));
    try {
      const shimDirectory = path.join(homeDirectory, ".local", "bin");
      const service = new MemoryCliShimService({
        appExecutablePath: "/Applications/WithMate.app/Contents/MacOS/WithMate",
        bundledCliScriptPath: "/Applications/WithMate.app/Contents/Resources/resources/skills/withmate-memory/bin/withmate-memory.mjs",
        homeDirectory,
        pathEnv: ["/usr/bin", shimDirectory].join(path.delimiter),
        platform: "darwin",
      });

      assert.equal((await service.getDiagnostics()).status, "not-installed");
      const installed = await service.install();
      assert.equal(installed.status, "installed");
      assert.equal(await service.isPathShimUsable(), true);

      const script = await readFile(path.join(shimDirectory, "withmate-memory"), "utf8");
      const metadata = JSON.parse(await readFile(path.join(shimDirectory, ".withmate-memory-shim.json"), "utf8")) as {
        managedBy?: unknown;
        commandName?: unknown;
        version?: unknown;
      };
      assert.match(script, /^#!\/bin\/sh/);
      assert.match(script, /Managed by WithMate Memory CLI shim/);
      assert.match(script, /ELECTRON_RUN_AS_NODE=1/);
      assert.match(script, /withmate-memory\.mjs'\s+"\$@"/);
      assert.deepEqual(metadata, {
        managedBy: "WithMate",
        commandName: "withmate-memory",
        version: 1,
      });

      const uninstalled = await service.uninstall();
      assert.equal(uninstalled.status, "not-installed");
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  it("PATH に ~/.local/bin が無い場合は installed-path-missing として診断する", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "withmate-cli-shim-home-"));
    try {
      const service = new MemoryCliShimService({
        appExecutablePath: "/opt/WithMate/withmate",
        bundledCliScriptPath: "/opt/WithMate/resources/skills/withmate-memory/bin/withmate-memory.mjs",
        homeDirectory,
        pathEnv: "/usr/bin",
        platform: "linux",
      });

      const installed = await service.install();
      assert.equal(installed.status, "installed-path-missing");
      assert.equal(await service.isPathShimUsable(), false);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  it("marker 文字列を含む既存のユーザー所有 shim も上書きも削除もしない", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "withmate-cli-shim-home-"));
    try {
      const shimDirectory = path.join(homeDirectory, ".local", "bin");
      const shimPath = path.join(shimDirectory, "withmate-memory");
      await mkdir(shimDirectory, { recursive: true });
      await writeFile(shimPath, "#!/bin/sh\n# Managed by WithMate Memory CLI shim\necho user\n", "utf8");
      const service = new MemoryCliShimService({
        appExecutablePath: "/Applications/WithMate.app/Contents/MacOS/WithMate",
        bundledCliScriptPath: "/Applications/WithMate.app/Contents/Resources/resources/skills/withmate-memory/bin/withmate-memory.mjs",
        homeDirectory,
        pathEnv: shimDirectory,
        platform: "darwin",
      });

      assert.equal((await service.getDiagnostics()).status, "blocked-existing");
      await assert.rejects(() => service.install(), /non-WithMate/);
      await assert.rejects(() => service.uninstall(), /non-WithMate/);
      assert.equal(await readFile(shimPath, "utf8"), "#!/bin/sh\n# Managed by WithMate Memory CLI shim\necho user\n");
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  it("metadata が無い既存 shim は script 内容が一致しても非管理として保護する", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "withmate-cli-shim-home-"));
    try {
      const shimDirectory = path.join(homeDirectory, ".local", "bin");
      const shimPath = path.join(shimDirectory, "withmate-memory");
      await mkdir(shimDirectory, { recursive: true });
      const service = new MemoryCliShimService({
        appExecutablePath: "/Applications/WithMate.app/Contents/MacOS/WithMate",
        bundledCliScriptPath: "/Applications/WithMate.app/Contents/Resources/resources/skills/withmate-memory/bin/withmate-memory.mjs",
        homeDirectory,
        pathEnv: shimDirectory,
        platform: "darwin",
      });
      await service.install();
      const generatedScript = await readFile(shimPath, "utf8");
      await rm(path.join(shimDirectory, ".withmate-memory-shim.json"), { force: true });

      assert.equal((await service.getDiagnostics()).status, "blocked-existing");
      await assert.rejects(() => service.install(), /non-WithMate/);
      await assert.rejects(() => service.uninstall(), /non-WithMate/);
      assert.equal(await readFile(shimPath, "utf8"), generatedScript);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  it("Windows は installer 管理として診断し、UI install 対象にしない", async () => {
    const service = new MemoryCliShimService({
      appExecutablePath: "C:\\Program Files\\WithMate\\WithMate.exe",
      bundledCliScriptPath: "C:\\Program Files\\WithMate\\resources\\resources\\skills\\withmate-memory\\bin\\withmate-memory.mjs",
      homeDirectory: "C:\\Users\\test",
      pathEnv: "",
      platform: "win32",
    });

    const diagnostics = await service.getDiagnostics();
    assert.equal(diagnostics.supported, false);
    assert.equal(diagnostics.status, "managed-by-installer");
  });
});
