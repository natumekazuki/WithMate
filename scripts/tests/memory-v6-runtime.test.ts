import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  resolveDefaultWithMateMemoryDiscoveryFilePath,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
} from "../../src/memory-v6/memory-discovery.js";
import {
  publishMemoryV6DiscoveryFile,
  startMemoryV6RuntimeApi,
} from "../../src-electron/memory-v6-runtime.js";

describe("Memory V6 runtime API", () => {
  it("runtime directoryへdiscovery fileをpublishしcleanupできる", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    try {
      const published = await publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:12345",
        runtimeDirectoryPath,
      });
      const document = JSON.parse(await readFile(published.discoveryFilePath, "utf8"));

      assert.deepEqual(document, {
        schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
        baseUrl: "http://127.0.0.1:12345",
      });
      assert.equal(path.dirname(published.discoveryFilePath), runtimeDirectoryPath);
      assert.equal((await stat(published.discoveryFilePath)).isFile(), true);

      await published.cleanup();
      await assert.rejects(() => stat(published.discoveryFilePath));
    } finally {
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  it("discovery file publish失敗時はtemporary fileを残さない", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    try {
      await mkdir(path.join(runtimeDirectoryPath, "memory-v6-api.json"));

      await assert.rejects(() => publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:12345",
        runtimeDirectoryPath,
      }));

      const entries = await readdir(runtimeDirectoryPath);
      assert.deepEqual(entries, ["memory-v6-api.json"]);
    } finally {
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  it("default discovery file pathはCLIと同じruntime directory contractを使う", () => {
    assert.equal(
      resolveDefaultWithMateMemoryDiscoveryFilePath({ WITHMATE_MEMORY_RUNTIME_DIR: "C:/tmp/withmate-runtime" }),
      path.resolve("C:/tmp/withmate-runtime", "memory-v6-api.json"),
    );
  });

  it("V6 DBをbootstrapし、status endpointをdiscovery file経由で公開する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    try {
      const runtime = await startMemoryV6RuntimeApi({ userDataPath, runtimeDirectoryPath });
      try {
        const discovery = JSON.parse(await readFile(runtime.discoveryFilePath, "utf8"));
        assert.equal(discovery.schemaVersion, WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION);
        assert.equal(discovery.baseUrl, runtime.baseUrl);
        assert.equal(runtime.dbPath, path.join(userDataPath, "withmate-v6.db"));

        const status = await fetch(`${runtime.baseUrl}/v1/status`);
        assert.equal(status.status, 200);
        assert.deepEqual(await status.json(), { ok: true });

        const context = await fetch(`${runtime.baseUrl}/v1/context`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ schemaVersion: "withmate-memory-v1" }),
        });
        assert.equal(context.status, 401);
        assert.equal((await context.json()).error.code, "MEMORY_BINDING_REQUIRED");
      } finally {
        await runtime.stop();
      }

      await assert.rejects(() => stat(path.join(runtimeDirectoryPath, "memory-v6-api.json")));
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  it("invalid V6 DBがある場合は起動せずdiscovery fileを残さない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    try {
      await writeFile(path.join(userDataPath, "withmate-v6.db"), "not sqlite", "utf8");

      await assert.rejects(
        () => startMemoryV6RuntimeApi({ userDataPath, runtimeDirectoryPath }),
        /does not match the V6 foundation schema/,
      );
      await assert.rejects(() => stat(path.join(runtimeDirectoryPath, "memory-v6-api.json")));
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });
});
