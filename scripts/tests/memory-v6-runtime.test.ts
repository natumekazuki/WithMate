import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildWithMateMemoryDiscoveryGenerationFileName,
  resolveDefaultWithMateMemoryDiscoveryFilePath,
  WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
} from "../../src/memory-v6/memory-discovery.js";
import {
  publishMemoryV6DiscoveryFile,
  startMemoryV6RuntimeApi,
} from "../../src-electron/memory-v6-runtime.js";
import {
  callWithMateMemoryRuntime,
  discoverWithMateMemoryApi,
  WithMateMemoryRuntimeExchangeError,
} from "../withmate-memory-runtime-client.js";

async function readDiscoveryProjection(pointerFilePath: string, adapter: "cli" | "mcp" = "cli") {
  const pointer = JSON.parse(await readFile(pointerFilePath, "utf8"));
  assert.equal(pointer.schemaVersion, WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION);
  const generationFilePath = path.join(
    path.dirname(pointerFilePath),
    buildWithMateMemoryDiscoveryGenerationFileName(adapter, pointer.runtimeInstanceId),
  );
  return {
    pointer,
    generationFilePath,
    document: JSON.parse(await readFile(generationFilePath, "utf8")),
  };
}

const TEST_DISCOVERY_SECRETS = {
  apiSecret: "test-api-secret",
  operatorApiSecret: "test-operator-secret",
  mcpApiSecret: "test-mcp-secret",
};
const TEST_APPLICATION_INSTANCE_A = "11111111-1111-4111-8111-111111111111";
const TEST_APPLICATION_INSTANCE_B = "22222222-2222-4222-8222-222222222222";

describe("Memory V6 runtime API", () => {
  it("request生成時の同期失敗をpre-dispatch exchange errorへ正規化する", async () => {
    await assert.rejects(
      () => callWithMateMemoryRuntime({
        api: {
          baseUrl: "http://127.0.0.1:7777",
          apiSecret: "api-secret",
          runtimeInstanceId: "invalid\nruntime",
        },
        credential: { adapter: "cli", adapterSecret: "operator-secret" },
      }, {
        method: "POST",
        path: "/v1/character_memory/forget",
        body: { secret: "must-not-be-dispatched" },
      }, { signal: new AbortController().signal }),
      (error: unknown) => error instanceof WithMateMemoryRuntimeExchangeError && error.dispatched === false,
    );
  });

  it("runtime directoryへdiscovery fileをpublishしcleanupできる", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    try {
      const published = await publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:12345",
        ...TEST_DISCOVERY_SECRETS,
        runtimeInstanceId: "test-runtime-instance",
        runtimeDirectoryPath,
      });
      const { document, generationFilePath } = await readDiscoveryProjection(published.discoveryFilePath);

      assert.equal(document.schemaVersion, WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION);
      assert.equal(document.adapter, "cli");
      assert.equal(document.baseUrl, "http://127.0.0.1:12345");
      assert.equal(document.apiSecret, "test-api-secret");
      assert.equal(document.adapterSecret, "test-operator-secret");
      assert.equal(Object.hasOwn(document, "mcpApiSecret"), false);
      assert.equal(document.runtimeInstanceId, "test-runtime-instance");
      assert.equal(typeof document.publishedAt, "string");
      assert.equal(path.dirname(published.discoveryFilePath), runtimeDirectoryPath);
      assert.equal((await stat(published.discoveryFilePath)).isFile(), true);

      await published.cleanup();
      await assert.rejects(() => stat(generationFilePath));
    } finally {
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  it("cleanup中に新runtimeがpublishされてもcurrent pointerと新generationを削除しない", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    let releaseCleanup!: () => void;
    let cleanupStarted!: () => void;
    const cleanupStartedPromise = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const cleanupBarrier = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    try {
      const first = await publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:11111",
        ...TEST_DISCOVERY_SECRETS,
        runtimeInstanceId: "first-runtime",
        runtimeDirectoryPath,
        beforeCleanup: async () => {
          cleanupStarted();
          await cleanupBarrier;
        },
      });
      const firstCliProjection = await readDiscoveryProjection(first.discoveryFilePath);
      const firstMcpProjection = await readDiscoveryProjection(first.mcpDiscoveryFilePath, "mcp");
      const firstCleanup = first.cleanup();
      await cleanupStartedPromise;
      const second = await publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:22222",
        ...TEST_DISCOVERY_SECRETS,
        runtimeInstanceId: "second-runtime",
        runtimeDirectoryPath,
      });
      const secondCliProjection = await readDiscoveryProjection(second.discoveryFilePath);
      const secondMcpProjection = await readDiscoveryProjection(second.mcpDiscoveryFilePath, "mcp");
      releaseCleanup();
      await firstCleanup;
      const remainingCli = await readDiscoveryProjection(second.discoveryFilePath);
      const remainingMcp = await readDiscoveryProjection(second.mcpDiscoveryFilePath, "mcp");
      assert.equal(remainingCli.document.runtimeInstanceId, "second-runtime");
      assert.equal(remainingCli.document.baseUrl, "http://127.0.0.1:22222");
      assert.equal(remainingMcp.document.runtimeInstanceId, "second-runtime");
      assert.equal(remainingMcp.document.baseUrl, "http://127.0.0.1:22222");
      assert.equal((await stat(secondCliProjection.generationFilePath)).isFile(), true);
      assert.equal((await stat(secondMcpProjection.generationFilePath)).isFile(), true);
      await assert.rejects(() => stat(firstCliProjection.generationFilePath));
      await assert.rejects(() => stat(firstMcpProjection.generationFilePath));

      await second.cleanup();
      await assert.rejects(() => stat(secondCliProjection.generationFilePath));
      await assert.rejects(() => stat(secondMcpProjection.generationFilePath));
    } finally {
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  it("両projection準備後のpair commit失敗でも直前のdiscovery pairを維持する", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    let first: Awaited<ReturnType<typeof publishMemoryV6DiscoveryFile>> | null = null;
    try {
      first = await publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:11111",
        ...TEST_DISCOVERY_SECRETS,
        runtimeInstanceId: "first-runtime",
        runtimeDirectoryPath,
      });
      const firstCli = await readDiscoveryProjection(first.discoveryFilePath);
      const firstMcp = await readDiscoveryProjection(first.mcpDiscoveryFilePath, "mcp");
      const entriesBeforeFailedPublish = (await readdir(runtimeDirectoryPath)).sort();

      await assert.rejects(
        () => publishMemoryV6DiscoveryFile({
          baseUrl: "http://127.0.0.1:22222",
          ...TEST_DISCOVERY_SECRETS,
          runtimeInstanceId: "second-runtime",
          runtimeDirectoryPath,
          beforePairCommit: async () => {
            throw new Error("injected discovery pair commit failure");
          },
        }),
        /injected discovery pair commit failure/,
      );

      const remainingCli = await readDiscoveryProjection(first.discoveryFilePath);
      const remainingMcp = await readDiscoveryProjection(first.mcpDiscoveryFilePath, "mcp");
      assert.equal(remainingCli.document.runtimeInstanceId, "first-runtime");
      assert.equal(remainingMcp.document.runtimeInstanceId, "first-runtime");
      assert.equal(remainingCli.generationFilePath, firstCli.generationFilePath);
      assert.equal(remainingMcp.generationFilePath, firstMcp.generationFilePath);
      assert.equal((await stat(firstCli.generationFilePath)).isFile(), true);
      assert.equal((await stat(firstMcp.generationFilePath)).isFile(), true);
      assert.deepEqual((await readdir(runtimeDirectoryPath)).sort(), entriesBeforeFailedPublish);
    } finally {
      await first?.cleanup();
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  it("失敗runtimeのcommit待機中に新runtimeがpublishされても新しいpairを維持する", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    let releaseFailingCommit!: () => void;
    let failingCommitReady!: () => void;
    const failingCommitReadyPromise = new Promise<void>((resolve) => { failingCommitReady = resolve; });
    const failingCommitBarrier = new Promise<void>((resolve) => { releaseFailingCommit = resolve; });
    try {
      const first = await publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:11111",
        ...TEST_DISCOVERY_SECRETS,
        runtimeInstanceId: "first-runtime",
        runtimeDirectoryPath,
      });
      const failingPublish = publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:22222",
        ...TEST_DISCOVERY_SECRETS,
        runtimeInstanceId: "failing-runtime",
        runtimeDirectoryPath,
        beforePairCommit: async () => {
          failingCommitReady();
          await failingCommitBarrier;
          throw new Error("injected stale publisher failure");
        },
      });
      await failingCommitReadyPromise;
      const newer = await publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:33333",
        ...TEST_DISCOVERY_SECRETS,
        runtimeInstanceId: "newer-runtime",
        runtimeDirectoryPath,
      });
      releaseFailingCommit();
      await assert.rejects(() => failingPublish, /injected stale publisher failure/);

      const cli = await readDiscoveryProjection(newer.discoveryFilePath, "cli");
      const mcp = await readDiscoveryProjection(newer.mcpDiscoveryFilePath, "mcp");
      assert.equal(cli.document.runtimeInstanceId, "newer-runtime");
      assert.equal(mcp.document.runtimeInstanceId, "newer-runtime");
      await first.cleanup();
      await newer.cleanup();
    } finally {
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  it("成功runtimeが重なってもcurrent pointerは常に一つのgeneration pairを選ぶ", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    let releaseOlderCommit!: () => void;
    let olderCommitReady!: () => void;
    const olderCommitReadyPromise = new Promise<void>((resolve) => { olderCommitReady = resolve; });
    const olderCommitBarrier = new Promise<void>((resolve) => { releaseOlderCommit = resolve; });
    try {
      const olderPublish = publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:11111",
        ...TEST_DISCOVERY_SECRETS,
        runtimeInstanceId: "older-overlap",
        runtimeDirectoryPath,
        beforePairCommit: async () => {
          olderCommitReady();
          await olderCommitBarrier;
        },
      });
      await olderCommitReadyPromise;
      const newer = await publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:22222",
        ...TEST_DISCOVERY_SECRETS,
        runtimeInstanceId: "newer-overlap",
        runtimeDirectoryPath,
      });
      releaseOlderCommit();
      const older = await olderPublish;

      const cli = await readDiscoveryProjection(older.discoveryFilePath, "cli");
      const mcp = await readDiscoveryProjection(older.mcpDiscoveryFilePath, "mcp");
      assert.equal(cli.document.runtimeInstanceId, mcp.document.runtimeInstanceId);
      assert.equal(cli.document.runtimeInstanceId, "older-overlap");
      await newer.cleanup();
      await older.cleanup();
    } finally {
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  it("discovery file publish失敗時はtemporary fileを残さない", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    try {
      await mkdir(path.join(runtimeDirectoryPath, "memory-v6.current.json"));

      await assert.rejects(() => publishMemoryV6DiscoveryFile({
        baseUrl: "http://127.0.0.1:12345",
        ...TEST_DISCOVERY_SECRETS,
        runtimeDirectoryPath,
      }));

      const entries = await readdir(runtimeDirectoryPath);
      assert.deepEqual(entries, ["memory-v6.current.json"]);
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
          ...TEST_DISCOVERY_SECRETS,
          runtimeDirectoryPath,
        }),
        /real directory/,
      );
      await assert.rejects(() => stat(path.join(runtimeDirectoryPath, "memory-v6.current.json")));
    } finally {
      await rm(parentPath, { recursive: true, force: true });
    }
  });

  it("default discovery file pathはCLIと同じruntime directory contractを使う", () => {
    assert.equal(
      resolveDefaultWithMateMemoryDiscoveryFilePath({ WITHMATE_MEMORY_RUNTIME_DIR: "C:/tmp/withmate-runtime" }),
      path.resolve("C:/tmp/withmate-runtime", "memory-v6.current.json"),
    );
  });

// @test-value v1
// kind = "invariant"
// claim = "Memory runtimeはapplication instanceと固有generationをregistryとlegacy projectionへ公開し、owner challenge後にoperationを実行する"
// oracle = { type = "adr", ref = "ADR-023 multi-instance-runtime-discovery" }
// failure_mode = "registry credential、legacy projection、HTTP identityが異なるowner tupleを示し、別runtimeへoperationが到達する"
// scope = "memory-runtime-publication-and-exchange"
// lifecycle = "permanent"
// @end-test-value
it("V6 DBをbootstrapし、owner-bound statusとlocal user APIを公開する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const workspacePath = path.join(userDataPath, "repo");
    try {
      await mkdir(path.join(workspacePath, ".git"), { recursive: true });
      const runtime = await startMemoryV6RuntimeApi({
        userDataPath,
        applicationInstanceId: TEST_APPLICATION_INSTANCE_A,
        buildChannel: "development",
        registryDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
        runtimeDirectoryPath,
        listCharacters: () => [{
          id: "character-a",
          name: "Character A",
          description: "Runtime test character",
          iconFilePath: "",
          theme: { main: "#111111", sub: "#222222" },
          state: "active",
          createdAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:00:00.000Z",
          archivedAt: null,
        }],
        resolveCharacterById: (id) => ["character-a", "archived-character"].includes(id)
          ? { id, name: id === "character-a" ? "Character A" : "Archived Character" }
          : null,
      });
      try {
        const discovery = (await readDiscoveryProjection(runtime.discoveryFilePath)).document;
        const mcpDiscovery = (await readDiscoveryProjection(runtime.mcpDiscoveryFilePath, "mcp")).document;
        assert.equal(discovery.schemaVersion, WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION);
        assert.equal(discovery.baseUrl, runtime.baseUrl);
        assert.equal(typeof discovery.apiSecret, "string");
        assert.equal(discovery.apiSecret.length > 20, true);
        assert.equal(discovery.adapter, "cli");
        assert.equal(typeof discovery.adapterSecret, "string");
        assert.equal(discovery.adapterSecret.length > 20, true);
        assert.equal(mcpDiscovery.adapter, "mcp");
        assert.equal(typeof mcpDiscovery.adapterSecret, "string");
        assert.equal(mcpDiscovery.adapterSecret.length > 20, true);
        assert.equal(Object.hasOwn(mcpDiscovery, "operatorApiSecret"), false);
        assert.equal(Object.hasOwn(mcpDiscovery, "mcpApiSecret"), false);
        assert.equal(JSON.stringify(mcpDiscovery).includes(discovery.adapterSecret), false);
        const mcpConnection = await discoverWithMateMemoryApi({
          adapter: "mcp",
          env: {},
          discoveryFilePath: runtime.mcpDiscoveryFilePath,
        });
        assert.ok(mcpConnection);
        const unknownCharacter = await callWithMateMemoryRuntime(mcpConnection, {
          method: "POST",
          path: "/v1/append",
          body: {
            schemaVersion: "withmate-memory-v1",
            target: {
              owner: "character",
              scope: "character",
              character: { type: "id", id: "missing-character" },
            },
            kind: "note",
            title: "Unknown Character",
            body: "This write must not be accepted.",
            preview: "Must not be accepted.",
            tags: [],
            idempotencyKey: "unknown-character-target",
          },
        }, { signal: new AbortController().signal });
        assert.equal(unknownCharacter.status, 404);
        assert.equal((unknownCharacter.value as { error: { code: string } }).error.code, "MEMORY_TARGET_NOT_FOUND");
        const archivedAppend = await callWithMateMemoryRuntime(mcpConnection, {
          method: "POST",
          path: "/v1/append",
          body: {
            schemaVersion: "withmate-memory-v1",
            target: {
              owner: "character",
              scope: "character",
              character: { type: "id", id: "archived-character" },
            },
            kind: "note",
            title: "Archived Character Memory",
            body: "Archived identity remains a valid Memory target.",
            preview: "Archived target remains valid.",
            tags: [],
            idempotencyKey: "archived-character-target",
          },
        }, { signal: new AbortController().signal });
        assert.equal(archivedAppend.status, 200);
        const archivedEntryId = (archivedAppend.value as { entry: { id: string } }).entry.id;
        const archivedForget = await callWithMateMemoryRuntime(mcpConnection, {
          method: "POST",
          path: "/v1/forget",
          body: {
            schemaVersion: "withmate-memory-v1",
            target: {
              owner: "character",
              scope: "character",
              character: { type: "id", id: "archived-character" },
            },
            entryIds: [archivedEntryId],
            reason: "user_request",
            idempotencyKey: "archived-character-forget",
          },
        }, { signal: new AbortController().signal });
        assert.equal(archivedForget.status, 200);
        assert.equal((archivedForget.value as { results: Array<{ status: string }> }).results[0]?.status, "forgotten");
        assert.ok(mcpConnection);
        assert.equal(mcpConnection.credential.adapter, "mcp");
        assert.equal(Object.hasOwn(mcpConnection, "operatorApiSecret"), false);
        assert.equal(Object.hasOwn(mcpConnection.api, "operatorApiSecret"), false);
        assert.equal(JSON.stringify(mcpConnection).includes(discovery.adapterSecret), false);
        assert.equal(typeof discovery.runtimeInstanceId, "string");
        assert.equal(discovery.applicationInstanceId, TEST_APPLICATION_INSTANCE_A);
        assert.equal(discovery.runtimeGenerationId, runtime.runtimeGenerationId);
        assert.equal(runtime.dbPath, path.join(userDataPath, "withmate-v6.db"));

        const status = await fetch(`${runtime.baseUrl}/v1/status`);
        assert.equal(status.status, 200);
        assert.deepEqual(await status.json(), {
          ok: true,
          applicationInstanceId: TEST_APPLICATION_INSTANCE_A,
          runtimeGenerationId: runtime.runtimeGenerationId,
          runtimeInstanceId: runtime.runtimeGenerationId,
          buildChannel: "development",
        });

        const nonce = "runtime-nonce";
        const challengedStatus = await fetch(`${runtime.baseUrl}/v1/status?nonce=${nonce}`);
        assert.equal(challengedStatus.status, 200);
        assert.deepEqual(await challengedStatus.json(), {
          ok: true,
          applicationInstanceId: TEST_APPLICATION_INSTANCE_A,
          runtimeGenerationId: runtime.runtimeGenerationId,
          runtimeInstanceId: discovery.runtimeInstanceId,
          buildChannel: "development",
          challenge: {
            nonce,
            hmacSha256: createHmac("sha256", discovery.apiSecret).update(nonce, "utf8").digest("base64url"),
            ownerHmacSha256: createHmac("sha256", discovery.apiSecret)
              .update(`${TEST_APPLICATION_INSTANCE_A}\n${runtime.runtimeGenerationId}\n${nonce}`, "utf8")
              .digest("base64url"),
          },
        });

        const cliConnection = await discoverWithMateMemoryApi({
          adapter: "cli",
          env: {},
          discoveryFilePath: runtime.discoveryFilePath,
        });
        assert.ok(cliConnection);
        const exchangeAbort = new AbortController();
        const exchangeStatus = await callWithMateMemoryRuntime(cliConnection, {
          method: "GET",
          path: "/v1/status",
          body: {},
        }, { signal: exchangeAbort.signal });
        assert.equal(exchangeStatus.ok, true);
        assert.equal(exchangeStatus.status, 200);

        const appendBody = {
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
          idempotencyKey: "runtime-mcp-append",
        };

        const mcpDirectAppend = await fetch(`${runtime.baseUrl}/v1/append`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": mcpDiscovery.apiSecret,
            "X-WithMate-Memory-Mcp-Api-Secret": mcpDiscovery.adapterSecret,
          },
          body: JSON.stringify(appendBody),
        });
        assert.equal(mcpDirectAppend.status, 200);
        assert.equal((await mcpDirectAppend.json()).created, true);

        const mcpExchangeAppend = await callWithMateMemoryRuntime(mcpConnection, {
          method: "POST",
          path: "/v1/append",
          body: appendBody,
        }, { signal: new AbortController().signal });
        assert.equal(mcpExchangeAppend.ok, true);
        assert.equal(mcpExchangeAppend.status, 200);
        assert.equal((mcpExchangeAppend.value as { replayed?: true }).replayed, true);

        const mcpAppendReadBack = await callWithMateMemoryRuntime(cliConnection, {
          method: "POST",
          path: "/v1/search",
          body: {
            schemaVersion: "withmate-memory-v1",
            targets: [{
              owner: "project",
              scope: "project",
              project: { type: "path", path: workspacePath },
            }],
            query: "Runtime project path",
          },
        }, { signal: new AbortController().signal });
        assert.equal(mcpAppendReadBack.ok, true);
        assert.equal((mcpAppendReadBack.value as { items: unknown[] }).items.length, 1);

        const append = await fetch(`${runtime.baseUrl}/v1/append`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
            "X-WithMate-Memory-Operator-Api-Secret": discovery.adapterSecret,
          },
          body: JSON.stringify({ ...appendBody, idempotencyKey: "runtime-operator-append" }),
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

        const spoofedCli = await fetch(`${runtime.baseUrl}/v1/character_context/get`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
            "x-withmate-client": "cli",
          },
          body: JSON.stringify({
            schemaVersion: "withmate-character-context-v1",
            characterId: "missing-character",
            sessionId: "missing-session",
          }),
        });
        assert.equal(spoofedCli.status, 403);
        assert.equal((await spoofedCli.json()).error.code, "authority_denied");

        const authenticatedCli = await fetch(`${runtime.baseUrl}/v1/character_context/get`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
            "x-withmate-memory-operator-api-secret": discovery.adapterSecret,
          },
          body: JSON.stringify({
            schemaVersion: "withmate-character-context-v1",
            characterId: "missing-character",
            sessionId: "missing-session",
          }),
        });
        assert.equal(authenticatedCli.status, 403);
        const authenticatedCliError = await authenticatedCli.json();
        assert.equal(authenticatedCliError.error.code, "authority_denied");
        assert.equal(authenticatedCliError.error.details.bindingFailure, "SESSION_BINDING_REQUIRED");

        const characters = await fetch(`${runtime.baseUrl}/v1/characters`, {
          headers: {
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
            "X-WithMate-Memory-Operator-Api-Secret": discovery.adapterSecret,
          },
        });
        assert.equal(characters.status, 200);
        assert.deepEqual(await characters.json(), {
          schemaVersion: "withmate-memory-v1",
          characters: [{
            id: "character-a",
            name: "Character A",
            description: "Runtime test character",
          }],
        });

        const detail = await fetch(`${runtime.baseUrl}/v1/get_entry`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
            "X-WithMate-Memory-Operator-Api-Secret": discovery.adapterSecret,
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

      const currentPointer = JSON.parse(await readFile(path.join(runtimeDirectoryPath, "memory-v6.current.json"), "utf8"));
      await assert.rejects(() => stat(path.join(
        runtimeDirectoryPath,
        buildWithMateMemoryDiscoveryGenerationFileName("cli", currentPointer.runtimeInstanceId),
      )));
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

// @test-value v1
// kind = "compatibility"
// claim = "legacy pointer projectionが後発runtimeを指す場合、先発runtimeのowner cleanupは後発generationを削除しない"
// oracle = { type = "adr", ref = "ADR-023 legacy pointer compatibility" }
// failure_mode = "先発runtimeのcleanupがpointer ownerでない後発runtimeのgenerationを削除する"
// scope = "memory-legacy-projection-owner-cleanup"
// lifecycle = "permanent"
// @end-test-value
it("別runtimeが同じlegacy directoryへpublishした後に先行runtimeを停止しても後発generationを残す", async () => {
    const firstUserDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const secondUserDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    let firstRuntime: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    let secondRuntime: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    try {
      firstRuntime = await startMemoryV6RuntimeApi({
        userDataPath: firstUserDataPath,
        applicationInstanceId: TEST_APPLICATION_INSTANCE_A,
        buildChannel: "development",
        registryDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
        runtimeDirectoryPath,
      });
      const firstDiscovery = (await readDiscoveryProjection(firstRuntime.discoveryFilePath)).document;
      secondRuntime = await startMemoryV6RuntimeApi({
        userDataPath: secondUserDataPath,
        applicationInstanceId: TEST_APPLICATION_INSTANCE_B,
        buildChannel: "visual-check",
        registryDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
        runtimeDirectoryPath,
      });
      const secondDiscovery = (await readDiscoveryProjection(secondRuntime.discoveryFilePath)).document;

      assert.notEqual(firstDiscovery.runtimeInstanceId, secondDiscovery.runtimeInstanceId);
      assert.equal(secondDiscovery.baseUrl, secondRuntime.baseUrl);

      await firstRuntime.stop();
      firstRuntime = null;
      const remaining = (await readDiscoveryProjection(secondRuntime.discoveryFilePath)).document;
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

// @test-value v1
// kind = "security"
// claim = "DB bootstrap失敗時はlistener credential registry entry legacy generationのいずれも公開しない"
// oracle = { type = "adr", ref = "ADR-023 publication failure timing" }
// failure_mode = "runtime初期化失敗後に利用不能なcredentialまたはentryがactive候補として残る"
// scope = "memory-runtime-prepublish-failure"
// lifecycle = "permanent"
// @end-test-value
it("invalid V6 DBがある場合は起動せずregistry entryとlegacy projectionを残さない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    try {
      await writeFile(path.join(userDataPath, "withmate-v6.db"), "not sqlite", "utf8");

      await assert.rejects(
        () => startMemoryV6RuntimeApi({
          userDataPath,
          applicationInstanceId: TEST_APPLICATION_INSTANCE_A,
          buildChannel: "development",
          registryDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
          runtimeDirectoryPath,
        }),
        /does not match the V6 foundation schema/,
      );
      await assert.rejects(() => stat(path.join(runtimeDirectoryPath, "memory-v6.current.json")));
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });
});
