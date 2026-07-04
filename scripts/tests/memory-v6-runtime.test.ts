import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
        apiSecret: "test-api-secret",
        runtimeInstanceId: "test-runtime-instance",
        runtimeDirectoryPath,
      });
      const document = JSON.parse(await readFile(published.discoveryFilePath, "utf8"));

      assert.equal(document.schemaVersion, WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION);
      assert.equal(document.baseUrl, "http://127.0.0.1:12345");
      assert.equal(document.apiSecret, "test-api-secret");
      assert.equal(document.runtimeInstanceId, "test-runtime-instance");
      assert.equal(typeof document.publishedAt, "string");
      assert.equal(path.dirname(published.discoveryFilePath), runtimeDirectoryPath);
      assert.equal((await stat(published.discoveryFilePath)).isFile(), true);

      await published.cleanup();
      await assert.rejects(() => stat(published.discoveryFilePath));
    } finally {
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  it("cleanupは自分がpublishしたdiscovery fileだけを削除する", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    try {
      const first = await publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:11111",
        runtimeInstanceId: "first-runtime",
        runtimeDirectoryPath,
      });
      const second = await publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:22222",
        runtimeInstanceId: "second-runtime",
        runtimeDirectoryPath,
      });

      await first.cleanup();
      const remaining = JSON.parse(await readFile(second.discoveryFilePath, "utf8"));
      assert.equal(remaining.runtimeInstanceId, "second-runtime");
      assert.equal(remaining.baseUrl, "http://127.0.0.1:22222");

      await second.cleanup();
      await assert.rejects(() => stat(second.discoveryFilePath));
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

  it("POSIXではsymlinkのruntime directoryを拒否する", { skip: process.platform === "win32" }, async () => {
    const parentPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-parent-"));
    const targetPath = path.join(parentPath, "target");
    const runtimeDirectoryPath = path.join(parentPath, "runtime-link");
    try {
      await mkdir(targetPath);
      await symlink(targetPath, runtimeDirectoryPath, "dir");

      await assert.rejects(
        () => publishMemoryV6DiscoveryFile({
          baseUrl: "http://127.0.0.1:12345",
          runtimeDirectoryPath,
        }),
        /real directory/,
      );
      await assert.rejects(() => stat(path.join(runtimeDirectoryPath, "memory-v6-api.json")));
    } finally {
      await rm(parentPath, { recursive: true, force: true });
    }
  });

  it("default discovery file pathはCLIと同じruntime directory contractを使う", () => {
    assert.equal(
      resolveDefaultWithMateMemoryDiscoveryFilePath({ WITHMATE_MEMORY_RUNTIME_DIR: "C:/tmp/withmate-runtime" }),
      path.resolve("C:/tmp/withmate-runtime", "memory-v6-api.json"),
    );
  });

  it("V6 DBをbootstrapし、status endpointとlocal user APIをdiscovery file経由で公開する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const workspacePath = path.join(userDataPath, "repo");
    try {
      await mkdir(path.join(workspacePath, ".git"), { recursive: true });
      const runtime = await startMemoryV6RuntimeApi({ userDataPath, runtimeDirectoryPath });
      try {
        const discovery = JSON.parse(await readFile(runtime.discoveryFilePath, "utf8"));
        assert.equal(discovery.schemaVersion, WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION);
        assert.equal(discovery.baseUrl, runtime.baseUrl);
        assert.equal(typeof discovery.apiSecret, "string");
        assert.equal(discovery.apiSecret.length > 20, true);
        assert.equal(typeof discovery.runtimeInstanceId, "string");
        assert.equal(runtime.dbPath, path.join(userDataPath, "withmate-v6.db"));

        const status = await fetch(`${runtime.baseUrl}/v1/status`);
        assert.equal(status.status, 200);
        assert.deepEqual(await status.json(), { ok: true, runtimeInstanceId: discovery.runtimeInstanceId });

        const nonce = "runtime-nonce";
        const challengedStatus = await fetch(`${runtime.baseUrl}/v1/status?nonce=${nonce}`);
        assert.equal(challengedStatus.status, 200);
        assert.deepEqual(await challengedStatus.json(), {
          ok: true,
          runtimeInstanceId: discovery.runtimeInstanceId,
          challenge: {
            nonce,
            hmacSha256: createHmac("sha256", discovery.apiSecret).update(nonce, "utf8").digest("base64url"),
          },
        });

        const append = await fetch(`${runtime.baseUrl}/v1/append`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
          },
          body: JSON.stringify({
            schemaVersion: "withmate-memory-v1",
            target: {
              owner: "project",
              scope: "project",
              project: { type: "path", path: workspacePath },
            },
            kind: "note",
            title: "Runtime project path",
            body: "Explicit project path works through the runtime API.",
            preview: "Explicit project path works.",
            tags: [{ type: "topic", value: "runtime" }],
          }),
        });
        assert.equal(append.status, 200);
        const appendJson = await append.json();

        const context = await fetch(`${runtime.baseUrl}/v1/context`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
          },
          body: JSON.stringify({ schemaVersion: "withmate-memory-v1" }),
        });
        assert.equal(context.status, 404);
        assert.equal((await context.json()).error.code, "MEMORY_ROUTE_NOT_FOUND");

        const characters = await fetch(`${runtime.baseUrl}/v1/characters`, {
          headers: {
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
          },
        });
        assert.equal(characters.status, 200);
        assert.deepEqual(await characters.json(), {
          schemaVersion: "withmate-memory-v1",
          characters: [],
        });

        const detail = await fetch(`${runtime.baseUrl}/v1/get_entry`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
          },
          body: JSON.stringify({
            schemaVersion: "withmate-memory-v1",
            entryId: appendJson.entry.id,
            target: {
              owner: "project",
              scope: "project",
              project: { type: "path", path: workspacePath },
            },
          }),
        });
        assert.equal(detail.status, 200);
        assert.equal((await detail.json()).entry.source.providerId, "local-user");
      } finally {
        await runtime.stop();
      }

      await assert.rejects(() => stat(path.join(runtimeDirectoryPath, "memory-v6-api.json")));
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  it("別runtimeが同じdirectoryへpublishした後に先行runtimeを停止してもdiscovery fileを残す", async () => {
    const firstUserDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const secondUserDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    let firstRuntime: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    let secondRuntime: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    try {
      firstRuntime = await startMemoryV6RuntimeApi({ userDataPath: firstUserDataPath, runtimeDirectoryPath });
      const firstDiscovery = JSON.parse(await readFile(firstRuntime.discoveryFilePath, "utf8"));
      secondRuntime = await startMemoryV6RuntimeApi({ userDataPath: secondUserDataPath, runtimeDirectoryPath });
      const secondDiscovery = JSON.parse(await readFile(secondRuntime.discoveryFilePath, "utf8"));

      assert.notEqual(firstDiscovery.runtimeInstanceId, secondDiscovery.runtimeInstanceId);
      assert.equal(secondDiscovery.baseUrl, secondRuntime.baseUrl);

      await firstRuntime.stop();
      firstRuntime = null;
      const remaining = JSON.parse(await readFile(secondRuntime.discoveryFilePath, "utf8"));
      assert.equal(remaining.runtimeInstanceId, secondDiscovery.runtimeInstanceId);
      assert.equal(remaining.baseUrl, secondRuntime.baseUrl);
    } finally {
      await firstRuntime?.stop().catch(() => undefined);
      await secondRuntime?.stop().catch(() => undefined);
      await rm(firstUserDataPath, { recursive: true, force: true });
      await rm(secondUserDataPath, { recursive: true, force: true });
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
