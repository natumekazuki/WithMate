import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { MemoryCliShimService } from "../../src-electron/memory-cli-shim-service.js";

describe("MemoryCliShimService", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "POSIX shimはcanonical packaged CLI pathを呼び出し、管理metadataに基づいてinstallとuninstallを行う"
  // oracle = { type = "adr", ref = "ADR-024 canonical CLI artifact path" }
  // failure_mode = "shimが旧Skill artifactを参照するか、管理外fileを削除する"
  // scope = "memory-cli-shim"
  // lifecycle = "permanent"
  // @end-test-value
  it("macOS/Linux では ~/.local/bin shim の PATH 状態を診断して install/uninstall できる", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "withmate-cli-shim-home-"));
    try {
      const shimDirectory = path.join(homeDirectory, ".local", "bin");
      const service = new MemoryCliShimService({
        appExecutablePath: "/Applications/WithMate.app/Contents/MacOS/WithMate",
        bundledCliScriptPath: "/Applications/WithMate.app/Contents/Resources/resources/cli/withmate-memory.mjs",
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

  // @test-value v1
  // kind = "contract"
  // claim = "canonical CLI shimをinstallしてもshim directoryがPATH外ならdiagnosticsで区別する"
  // oracle = { type = "contract", ref = "Memory CLI shim diagnostics" }
  // failure_mode = "PATH外のshimを利用可能として報告する"
  // scope = "memory-cli-shim-diagnostics"
  // lifecycle = "permanent"
  // @end-test-value
  it("PATH に ~/.local/bin が無い場合は installed-path-missing として診断する", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "withmate-cli-shim-home-"));
    try {
      const service = new MemoryCliShimService({
        appExecutablePath: "/opt/WithMate/withmate",
        bundledCliScriptPath: "/opt/WithMate/resources/cli/withmate-memory.mjs",
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

  // @test-value v1
  // kind = "security"
  // claim = "管理metadataのない既存shimはmarker文字列があっても利用者所有として上書き・削除しない"
  // oracle = { type = "contract", ref = "Memory CLI shim ownership boundary" }
  // failure_mode = "利用者所有shimの内容をWithMate管理物と誤認して破壊する"
  // scope = "memory-cli-shim-ownership"
  // lifecycle = "permanent"
  // @end-test-value
  it("marker 文字列を含む既存のユーザー所有 shim も上書きも削除もしない", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "withmate-cli-shim-home-"));
    try {
      const shimDirectory = path.join(homeDirectory, ".local", "bin");
      const shimPath = path.join(shimDirectory, "withmate-memory");
      await mkdir(shimDirectory, { recursive: true });
      await writeFile(shimPath, "#!/bin/sh\n# Managed by WithMate Memory CLI shim\necho user\n", "utf8");
      const service = new MemoryCliShimService({
        appExecutablePath: "/Applications/WithMate.app/Contents/MacOS/WithMate",
        bundledCliScriptPath: "/Applications/WithMate.app/Contents/Resources/resources/cli/withmate-memory.mjs",
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

  // @test-value v1
  // kind = "security"
  // claim = "生成内容が一致しても管理metadataを失ったshimは利用者所有として保護する"
  // oracle = { type = "contract", ref = "Memory CLI shim ownership boundary" }
  // failure_mode = "内容一致だけをauthorityとして管理外shimを上書き・削除する"
  // scope = "memory-cli-shim-ownership"
  // lifecycle = "permanent"
  // @end-test-value
  it("metadata が無い既存 shim は script 内容が一致しても非管理として保護する", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "withmate-cli-shim-home-"));
    try {
      const shimDirectory = path.join(homeDirectory, ".local", "bin");
      const shimPath = path.join(shimDirectory, "withmate-memory");
      await mkdir(shimDirectory, { recursive: true });
      const service = new MemoryCliShimService({
        appExecutablePath: "/Applications/WithMate.app/Contents/MacOS/WithMate",
        bundledCliScriptPath: "/Applications/WithMate.app/Contents/Resources/resources/cli/withmate-memory.mjs",
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

  // @test-value v1
  // kind = "contract"
  // claim = "WindowsのCLI commandはinstaller管理でありSettings shim操作の対象にしない"
  // oracle = { type = "adr", ref = "ADR-024 CLI distribution boundary" }
  // failure_mode = "WindowsでPOSIX shim操作を有効化しinstaller所有commandと競合する"
  // scope = "memory-cli-shim-platform"
  // lifecycle = "permanent"
  // @end-test-value
  it("Windows は installer 管理として診断し、UI install 対象にしない", async () => {
    const service = new MemoryCliShimService({
      appExecutablePath: "C:\\Program Files\\WithMate\\WithMate.exe",
      bundledCliScriptPath: "C:\\Program Files\\WithMate\\resources\\resources\\cli\\withmate-memory.mjs",
      homeDirectory: "C:\\Users\\test",
      pathEnv: "",
      platform: "win32",
    });

    const diagnostics = await service.getDiagnostics();
    assert.equal(diagnostics.supported, false);
    assert.equal(diagnostics.status, "managed-by-installer");
  });
});
