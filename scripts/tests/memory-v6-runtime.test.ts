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
  buildRuntimeDiscoveryCredentialFileName,
} from "../../src/runtime-discovery/runtime-discovery-contract.js";
import {
  listRuntimeDiscoveryRegistryEntries,
  resolveRuntimeDiscoveryMutationLockFilePath,
} from "../../src/runtime-discovery/runtime-discovery-registry.js";
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
const TEST_APPLICATION_INSTANCE_C = "33333333-3333-4333-8333-333333333333";

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

      await assert.rejects(() => stat(path.join(runtimeDirectoryPath, "memory-v6.current.json")));
      await assert.rejects(() => stat(path.join(
        runtimeDirectoryPath,
        buildWithMateMemoryDiscoveryGenerationFileName("cli", runtime.runtimeGenerationId),
      )));
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "compatibility"
  // claim = "複数active runtimeの間はlegacy pointerを公開せず、一方の正常終了で一意になったruntimeだけを再投影する"
  // oracle = { type = "adr", ref = "ADR-023 legacy pointer ambiguity" }
  // failure_mode = "A稼働中にBを起動するとlegacy pointerがBへlast-writer更新され、旧CLIがBへ暗黙接続する"
  // scope = "memory-legacy-projection-publish"
  // lifecycle = "permanent"
  // @end-test-value
  it("複数runtime起動中はlegacy pointerを削除し一意へ収束後に残存runtimeを再投影する", async () => {
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
      const firstGeneration = firstRuntime.runtimeGenerationId;
      secondRuntime = await startMemoryV6RuntimeApi({
        userDataPath: secondUserDataPath,
        applicationInstanceId: TEST_APPLICATION_INSTANCE_B,
        buildChannel: "visual-check",
        registryDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
        runtimeDirectoryPath,
      });
      const secondGeneration = secondRuntime.runtimeGenerationId;

      assert.notEqual(firstGeneration, secondGeneration);
      await assert.rejects(() => stat(secondRuntime!.discoveryFilePath));
      await stat(path.join(
        runtimeDirectoryPath,
        buildWithMateMemoryDiscoveryGenerationFileName("cli", firstGeneration),
      ));
      await stat(path.join(
        runtimeDirectoryPath,
        buildWithMateMemoryDiscoveryGenerationFileName("cli", secondGeneration),
      ));

      await firstRuntime.stop();
      firstRuntime = null;
      const remaining = (await readDiscoveryProjection(secondRuntime.discoveryFilePath)).document;
      assert.equal(remaining.runtimeInstanceId, secondGeneration);
      assert.equal(remaining.baseUrl, secondRuntime.baseUrl);
      assert.equal(firstDiscovery.runtimeInstanceId, firstGeneration);
    } finally {
      await firstRuntime?.stop().catch(() => undefined);
      await secondRuntime?.stop().catch(() => undefined);
      await rm(firstUserDataPath, { recursive: true, force: true });
      await rm(secondUserDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "compatibility"
  // claim = "後発runtimeの正常終了でactive集合が先発runtime一件へ収束すると、legacy pointerをそのruntimeへ再投影してから後発generationを削除する"
  // oracle = { type = "adr", ref = "ADR-023 legacy pointer owner-aware handoff" }
  // failure_mode = "A、Bの稼働中に非公開となったpointerがB終了後も復旧せず、稼働中Aを旧CLI/MCPが発見できない"
  // scope = "memory-legacy-projection-owner-cleanup"
  // lifecycle = "permanent"
  // distinction = "先発ownerを先に終了する既存testと逆の終了順で、pointerのhandoffと後発generation削除を同時に観測する"
  // @end-test-value
  it("後発runtimeを先に停止するとlegacy pointerを一意な先発runtimeへhandoffする", async () => {
    const firstUserDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const secondUserDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    let firstRuntime: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    let secondRuntime: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    try {
      firstRuntime = await startMemoryV6RuntimeApi({
        userDataPath: firstUserDataPath,
        applicationInstanceId: TEST_APPLICATION_INSTANCE_A,
        buildChannel: "installed",
        registryDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
        runtimeDirectoryPath,
      });
      const firstCliDiscovery = (await readDiscoveryProjection(
        firstRuntime.discoveryFilePath,
        "cli",
      )).document;
      secondRuntime = await startMemoryV6RuntimeApi({
        userDataPath: secondUserDataPath,
        applicationInstanceId: TEST_APPLICATION_INSTANCE_B,
        buildChannel: "development",
        registryDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
        runtimeDirectoryPath,
      });
      const secondRuntimeGenerationId = secondRuntime.runtimeGenerationId;

      await secondRuntime.stop();
      secondRuntime = null;

      const remainingCli = (await readDiscoveryProjection(
        firstRuntime.discoveryFilePath,
        "cli",
      )).document;
      const remainingMcp = (await readDiscoveryProjection(
        firstRuntime.discoveryFilePath,
        "mcp",
      )).document;
      assert.equal(remainingCli.applicationInstanceId, TEST_APPLICATION_INSTANCE_A);
      assert.equal(remainingCli.runtimeGenerationId, firstCliDiscovery.runtimeGenerationId);
      assert.equal(remainingCli.baseUrl, firstRuntime.baseUrl);
      assert.equal(remainingMcp.applicationInstanceId, TEST_APPLICATION_INSTANCE_A);
      assert.equal(remainingMcp.runtimeGenerationId, firstCliDiscovery.runtimeGenerationId);
      await assert.rejects(() => stat(path.join(
        runtimeDirectoryPath,
        buildWithMateMemoryDiscoveryGenerationFileName(
          "cli",
          secondRuntimeGenerationId,
        ),
      )));
      await assert.rejects(() => stat(path.join(
        runtimeDirectoryPath,
        buildWithMateMemoryDiscoveryGenerationFileName(
          "mcp",
          secondRuntimeGenerationId,
        ),
      )));
    } finally {
      await secondRuntime?.stop().catch(() => undefined);
      await firstRuntime?.stop().catch(() => undefined);
      await rm(firstUserDataPath, { recursive: true, force: true });
      await rm(secondUserDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "compatibility"
  // claim = "cleanup後のactive legacy候補が複数ならpointerを公開せず、後続cleanupで一意になった時だけchallenge済みruntimeへ再投影する"
  // oracle = { type = "adr", ref = "ADR-023 legacy pointer ambiguity" }
  // failure_mode = "legacy cleanupが起動順やlast writerで複数候補から一つを暗黙選択する、または一意へ収束後もpointerを復旧しない"
  // scope = "memory-legacy-projection-owner-cleanup"
  // lifecycle = "permanent"
  // distinction = "二つのruntime間のhandoffではなく、三runtimeから曖昧、次に一意へ変わるactive集合を観測する"
  // @end-test-value
  it("legacy pointerは複数候補を暗黙選択せず一意へ収束後に再投影する", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const userDataPaths = await Promise.all([0, 1, 2].map(() => (
      mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"))
    )));
    const runtimes: Array<Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null> = [];
    try {
      for (const [index, applicationInstanceId] of [
        TEST_APPLICATION_INSTANCE_A,
        TEST_APPLICATION_INSTANCE_C,
        TEST_APPLICATION_INSTANCE_B,
      ].entries()) {
        runtimes.push(await startMemoryV6RuntimeApi({
          userDataPath: userDataPaths[index],
          applicationInstanceId,
          buildChannel: index === 0 ? "installed" : "development",
          registryDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
          runtimeDirectoryPath,
        }));
      }
      const runtimeAGeneration = runtimes[0]!.runtimeGenerationId;
      const runtimeCGeneration = runtimes[1]!.runtimeGenerationId;

      await runtimes[2]!.stop();
      runtimes[2] = null;
      await assert.rejects(() => stat(path.join(
        runtimeDirectoryPath,
        "memory-v6.current.json",
      )));
      await stat(path.join(
        runtimeDirectoryPath,
        buildWithMateMemoryDiscoveryGenerationFileName("cli", runtimeAGeneration),
      ));
      await stat(path.join(
        runtimeDirectoryPath,
        buildWithMateMemoryDiscoveryGenerationFileName("cli", runtimeCGeneration),
      ));

      await runtimes[0]!.stop();
      runtimes[0] = null;
      const remaining = (await readDiscoveryProjection(
        runtimes[1]!.discoveryFilePath,
        "cli",
      )).document;
      assert.equal(remaining.applicationInstanceId, TEST_APPLICATION_INSTANCE_C);
      assert.equal(remaining.runtimeGenerationId, runtimeCGeneration);
    } finally {
      for (const runtime of runtimes) {
        await runtime?.stop().catch(() => undefined);
      }
      await Promise.all(userDataPaths.map((userDataPath) => (
        rm(userDataPath, { recursive: true, force: true })
      )));
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "legacy pointerのpublication集合検証からcommitまでregistry mutationを排他し、別runtimeを割り込ませない"
  // oracle = { type = "adr", ref = "ADR-023 legacy pointer ambiguity" }
  // failure_mode = "Bが集合検証後にCをpublishさせ、BとCがactiveなのにBのpointerをlast-writer公開する"
  // scope = "memory-legacy-projection-publish"
  // lifecycle = "permanent"
  // distinction = "集合変更後の再検証ではなく、検証完了からpointer commitまでのcross-process lock境界を直接観測する"
  // @end-test-value
  it("legacy pointer commit中は別runtimeのregistry publishを割り込ませない", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const registryDirectoryPath = path.join(runtimeDirectoryPath, "registry");
    const userDataPaths = await Promise.all([0, 1, 2].map(() => (
      mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"))
    )));
    const runtimes: Array<Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null> = [null, null, null];
    let releaseRuntimeBPointerCommit = () => undefined;
    let markRuntimeBPointerCommitReady = () => undefined;
    const runtimeBPointerCommitReady = new Promise<void>((resolve) => {
      markRuntimeBPointerCommitReady = resolve;
    });
    const runtimeBPointerCommitBarrier = new Promise<void>((resolve) => {
      releaseRuntimeBPointerCommit = resolve;
    });
    let markRuntimeCRegistryLockAttempted = () => undefined;
    const runtimeCRegistryLockAttempted = new Promise<void>((resolve) => {
      markRuntimeCRegistryLockAttempted = resolve;
    });
    let runtimeCRegistryCommitStarted = false;
    try {
      runtimes[0] = await startMemoryV6RuntimeApi({
        userDataPath: userDataPaths[0],
        applicationInstanceId: TEST_APPLICATION_INSTANCE_A,
        buildChannel: "installed",
        registryDirectoryPath,
        runtimeDirectoryPath,
        runtimePathSecurity: async () => undefined,
      });
      const runtimeBStart = startMemoryV6RuntimeApi({
        userDataPath: userDataPaths[1],
        applicationInstanceId: TEST_APPLICATION_INSTANCE_B,
        buildChannel: "development",
        registryDirectoryPath,
        runtimeDirectoryPath,
        runtimePathSecurity: async () => undefined,
        beforeLegacyPointerCommit: async () => {
          markRuntimeBPointerCommitReady();
          await runtimeBPointerCommitBarrier;
        },
      });
      await runtimeBPointerCommitReady;
      const runtimeCStart = startMemoryV6RuntimeApi({
        userDataPath: userDataPaths[2],
        applicationInstanceId: TEST_APPLICATION_INSTANCE_C,
        buildChannel: "development",
        registryDirectoryPath,
        runtimeDirectoryPath,
        runtimePathSecurity: async () => undefined,
        beforeRuntimeRegistryPublicationLock: async () => {
          markRuntimeCRegistryLockAttempted();
        },
        beforeRuntimeRegistryPublicationCommit: async () => {
          runtimeCRegistryCommitStarted = true;
        },
      });
      await runtimeCRegistryLockAttempted;
      assert.equal(runtimeCRegistryCommitStarted, false);

      releaseRuntimeBPointerCommit();
      runtimes[1] = await runtimeBStart;
      runtimes[2] = await runtimeCStart;
      assert.equal(runtimeCRegistryCommitStarted, true);
      await assert.rejects(() => stat(path.join(runtimeDirectoryPath, "memory-v6.current.json")));
    } finally {
      releaseRuntimeBPointerCommit();
      for (const runtime of runtimes.reverse()) {
        await runtime?.stop().catch(() => undefined);
      }
      await Promise.all(userDataPaths.map((userDataPath) => (
        rm(userDataPath, { recursive: true, force: true })
      )));
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "compatibility"
  // claim = "新runtimeのregistry publicationがpointer非公開化後に失敗しても、既存の一意runtimeへlegacy pointerをrollbackする"
  // oracle = { type = "adr", ref = "ADR-023 legacy pointer compatibility" }
  // failure_mode = "Bのentry publish失敗がAの正常なlegacy CLI/MCP discovery経路を失わせる"
  // scope = "memory-legacy-projection-publication-rollback"
  // lifecycle = "permanent"
  // distinction = "credential準備前の失敗ではなく、registry lock内でpointerを非公開化した後のentry commit失敗を注入する"
  // @end-test-value
  it("registry publication失敗時は既存runtimeのlegacy pointerを復元する", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const registryDirectoryPath = path.join(runtimeDirectoryPath, "registry");
    const userDataPaths = await Promise.all([0, 1].map(() => (
      mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"))
    )));
    let runtimeA: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    try {
      runtimeA = await startMemoryV6RuntimeApi({
        userDataPath: userDataPaths[0],
        applicationInstanceId: TEST_APPLICATION_INSTANCE_A,
        buildChannel: "installed",
        registryDirectoryPath,
        runtimeDirectoryPath,
        runtimePathSecurity: async () => undefined,
      });
      const runtimeAGeneration = runtimeA.runtimeGenerationId;
      await assert.rejects(() => startMemoryV6RuntimeApi({
        userDataPath: userDataPaths[1],
        applicationInstanceId: TEST_APPLICATION_INSTANCE_B,
        buildChannel: "development",
        registryDirectoryPath,
        runtimeDirectoryPath,
        runtimePathSecurity: async () => undefined,
        beforeRuntimeRegistryPublicationCommit: async () => {
          throw new Error("injected registry publication failure");
        },
      }));

      const restored = (await readDiscoveryProjection(runtimeA.discoveryFilePath)).document;
      assert.equal(restored.applicationInstanceId, TEST_APPLICATION_INSTANCE_A);
      assert.equal(restored.runtimeGenerationId, runtimeAGeneration);
      const snapshot = await listRuntimeDiscoveryRegistryEntries(registryDirectoryPath);
      assert.deepEqual(
        snapshot.records.map((record) => record.entry.applicationInstanceId),
        [TEST_APPLICATION_INSTANCE_A],
      );
    } finally {
      await runtimeA?.stop().catch(() => undefined);
      await Promise.all(userDataPaths.map((userDataPath) => (
        rm(userDataPath, { recursive: true, force: true })
      )));
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "regression"
  // claim = "Memory entry commit後にregistry lock解放が失敗しても、失敗runtimeのentryをrollbackして直前の一意なlegacy pointerを復元する"
  // oracle = { type = "adr", ref = "ADR-023 publication commit-unknown recovery" }
  // failure_mode = "Bのstartが失敗を返した後もBのfresh entryまたはBを指すpointerが残り、Aのlegacy CLI/MCP経路を無効化する"
  // scope = "memory-runtime-publication-recovery"
  // lifecycle = "permanent"
  // distinction = "entry commit前のpublication failureではなく、entry read-back完了後のregistry lock releaseだけを失敗させる"
  // @end-test-value
  it("registry lock解放失敗時はcommit済みentryをrollbackしてlegacy pointerを復元する", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const registryDirectoryPath = path.join(runtimeDirectoryPath, "registry");
    const registryLockPath = resolveRuntimeDiscoveryMutationLockFilePath(registryDirectoryPath);
    const lockBlockerPath = path.join(registryLockPath, "release-blocker");
    const userDataPaths = await Promise.all([0, 1].map(() => (
      mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"))
    )));
    let runtimeA: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    try {
      runtimeA = await startMemoryV6RuntimeApi({
        userDataPath: userDataPaths[0],
        applicationInstanceId: TEST_APPLICATION_INSTANCE_A,
        buildChannel: "installed",
        registryDirectoryPath,
        runtimeDirectoryPath,
        runtimePathSecurity: async () => undefined,
      });
      const runtimeAGeneration = runtimeA.runtimeGenerationId;
      await assert.rejects(
        () => startMemoryV6RuntimeApi({
          userDataPath: userDataPaths[1],
          applicationInstanceId: TEST_APPLICATION_INSTANCE_B,
          buildChannel: "development",
          registryDirectoryPath,
          runtimeDirectoryPath,
          runtimePathSecurity: async () => undefined,
          beforeRuntimeRegistryPublicationCommit: async () => {
            await writeFile(lockBlockerPath, "block release\n", "utf8");
          },
        }),
        (error: unknown) => (
          (error as NodeJS.ErrnoException)?.code === "ENOTEMPTY"
          || (error as NodeJS.ErrnoException)?.code === "EEXIST"
        ),
      );

      const restored = (await readDiscoveryProjection(runtimeA.discoveryFilePath)).document;
      assert.equal(restored.applicationInstanceId, TEST_APPLICATION_INSTANCE_A);
      assert.equal(restored.runtimeGenerationId, runtimeAGeneration);
      const snapshot = await listRuntimeDiscoveryRegistryEntries(registryDirectoryPath);
      assert.deepEqual(
        snapshot.records.map((record) => record.entry.applicationInstanceId),
        [TEST_APPLICATION_INSTANCE_A],
      );
    } finally {
      await rm(registryLockPath, { recursive: true, force: true });
      await runtimeA?.stop().catch(() => undefined);
      await Promise.all(userDataPaths.map((userDataPath) => (
        rm(userDataPath, { recursive: true, force: true })
      )));
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "registry publication failureのrollbackとpointer復元は同じmutation lock内で完了し、別runtimeを割り込ませない"
  // oracle = { type = "adr", ref = "ADR-023 legacy pointer publication rollback" }
  // failure_mode = "Bのpublish失敗後、pointer Aの復元前にCがpublishされ、AとCがactiveなのにpointer Aを公開する"
  // scope = "memory-legacy-projection-publication-rollback"
  // lifecycle = "permanent"
  // distinction = "単独failureの復元ではなく、rollback中に別publisherがlock取得を試みる競合を同期点で観測する"
  // @end-test-value
  it("registry publication rollback中は別runtimeを割り込ませない", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const registryDirectoryPath = path.join(runtimeDirectoryPath, "registry");
    const userDataPaths = await Promise.all([0, 1, 2].map(() => (
      mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"))
    )));
    let runtimeA: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    let runtimeC: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    let releaseRuntimeBRollback = () => undefined;
    let markRuntimeBRollbackReady = () => undefined;
    const runtimeBRollbackReady = new Promise<void>((resolve) => {
      markRuntimeBRollbackReady = resolve;
    });
    const runtimeBRollbackBarrier = new Promise<void>((resolve) => {
      releaseRuntimeBRollback = resolve;
    });
    let markRuntimeCLockAttempted = () => undefined;
    const runtimeCLockAttempted = new Promise<void>((resolve) => {
      markRuntimeCLockAttempted = resolve;
    });
    let runtimeCCommitStarted = false;
    try {
      runtimeA = await startMemoryV6RuntimeApi({
        userDataPath: userDataPaths[0],
        applicationInstanceId: TEST_APPLICATION_INSTANCE_A,
        buildChannel: "installed",
        registryDirectoryPath,
        runtimeDirectoryPath,
        runtimePathSecurity: async () => undefined,
      });
      const runtimeBStart = startMemoryV6RuntimeApi({
        userDataPath: userDataPaths[1],
        applicationInstanceId: TEST_APPLICATION_INSTANCE_B,
        buildChannel: "development",
        registryDirectoryPath,
        runtimeDirectoryPath,
        runtimePathSecurity: async () => undefined,
        beforeRuntimeRegistryPublicationCommit: async () => {
          throw new Error("injected registry publication failure");
        },
        beforeRuntimeRegistryPublicationRollback: async () => {
          markRuntimeBRollbackReady();
          await runtimeBRollbackBarrier;
        },
      });
      await runtimeBRollbackReady;
      const runtimeCStart = startMemoryV6RuntimeApi({
        userDataPath: userDataPaths[2],
        applicationInstanceId: TEST_APPLICATION_INSTANCE_C,
        buildChannel: "development",
        registryDirectoryPath,
        runtimeDirectoryPath,
        runtimePathSecurity: async () => undefined,
        beforeRuntimeRegistryPublicationLock: async () => {
          markRuntimeCLockAttempted();
        },
        beforeRuntimeRegistryPublicationCommit: async () => {
          runtimeCCommitStarted = true;
        },
      });
      await runtimeCLockAttempted;
      assert.equal(runtimeCCommitStarted, false);

      releaseRuntimeBRollback();
      await assert.rejects(() => runtimeBStart);
      runtimeC = await runtimeCStart;
      assert.equal(runtimeCCommitStarted, true);
      await assert.rejects(() => stat(path.join(runtimeDirectoryPath, "memory-v6.current.json")));
      const snapshot = await listRuntimeDiscoveryRegistryEntries(registryDirectoryPath);
      assert.deepEqual(
        snapshot.records.map((record) => record.entry.applicationInstanceId).sort(),
        [TEST_APPLICATION_INSTANCE_A, TEST_APPLICATION_INSTANCE_C].sort(),
      );
    } finally {
      releaseRuntimeBRollback();
      await runtimeC?.stop().catch(() => undefined);
      await runtimeA?.stop().catch(() => undefined);
      await Promise.all(userDataPaths.map((userDataPath) => (
        rm(userDataPath, { recursive: true, force: true })
      )));
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "compatibility"
  // claim = "legacy handoffはfreshな候補をregistry credential状態にかかわらずactive集合へ含め、複数ならpointerを公開しない"
  // oracle = { type = "adr", ref = "ADR-023 legacy pointer ambiguity" }
  // failure_mode = "freshなCのregistry credentialが不正なためCを除外し、AとCがactiveなのにAへpointerをhandoffする"
  // scope = "memory-legacy-projection-owner-cleanup"
  // lifecycle = "permanent"
  // distinction = "operator resolverのcardinalityではなく、正常終了cleanup時のlegacy pointer handoff集合を観測する"
  // @end-test-value
  it("legacy handoffはcredential不正でもfreshな候補を曖昧集合へ含める", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const registryDirectoryPath = path.join(runtimeDirectoryPath, "registry");
    const userDataPaths = await Promise.all([0, 1, 2].map(() => (
      mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"))
    )));
    const runtimes: Array<Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null> = [];
    try {
      for (const [index, applicationInstanceId] of [
        TEST_APPLICATION_INSTANCE_A,
        TEST_APPLICATION_INSTANCE_B,
        TEST_APPLICATION_INSTANCE_C,
      ].entries()) {
        runtimes.push(await startMemoryV6RuntimeApi({
          userDataPath: userDataPaths[index]!,
          applicationInstanceId,
          buildChannel: index === 0 ? "installed" : "development",
          registryDirectoryPath,
          runtimeDirectoryPath,
          runtimePathSecurity: async () => undefined,
        }));
      }
      const snapshot = await listRuntimeDiscoveryRegistryEntries(registryDirectoryPath);
      const runtimeCRecord = snapshot.records.find(
        (record) => record.entry.applicationInstanceId === TEST_APPLICATION_INSTANCE_C,
      );
      assert.ok(runtimeCRecord);
      await writeFile(
        path.join(
          runtimeCRecord.slotDirectoryPath,
          buildRuntimeDiscoveryCredentialFileName("cli"),
        ),
        "{}\n",
      );

      await runtimes[1]!.stop();
      runtimes[1] = null;
      await assert.rejects(() => stat(path.join(runtimeDirectoryPath, "memory-v6.current.json")));
    } finally {
      for (const runtime of runtimes.reverse()) {
        await runtime?.stop().catch(() => undefined);
      }
      await Promise.all(userDataPaths.map((userDataPath) => (
        rm(userDataPath, { recursive: true, force: true })
      )));
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "compatibility"
  // claim = "legacy handoffはreplacement解決後にMemory publication集合が変わった場合、選択済みruntimeへpointerをcommitしない"
  // oracle = { type = "adr", ref = "ADR-023 legacy pointer ambiguity" }
  // failure_mode = "BのcleanupがAを選択した後にCがpublishされ、AとCがactiveなのにAへpointerを暗黙handoffする"
  // scope = "memory-legacy-projection-owner-cleanup"
  // lifecycle = "permanent"
  // distinction = "cleanup開始時から複数候補がある場合ではなく、replacement解決後からpointer commit直前までに候補が増える競合を観測する"
  // @end-test-value
  it("replacement解決後に新runtimeがpublishされた場合はlegacy handoffをcommitしない", async () => {
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const userDataPaths = await Promise.all([0, 1, 2].map(() => (
      mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"))
    )));
    let runtimeA: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    let runtimeB: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    let runtimeC: Awaited<ReturnType<typeof startMemoryV6RuntimeApi>> | null = null;
    let runtimeCStart: Promise<Awaited<ReturnType<typeof startMemoryV6RuntimeApi>>> | null = null;
    let blockRuntimeBCleanupPointer = false;
    let releaseRuntimeBCleanupPointer = () => undefined;
    let markRuntimeBCleanupPointerReady = () => undefined;
    const runtimeBCleanupPointerReady = new Promise<void>((resolve) => {
      markRuntimeBCleanupPointerReady = resolve;
    });
    const runtimeBCleanupPointerBarrier = new Promise<void>((resolve) => {
      releaseRuntimeBCleanupPointer = resolve;
    });
    let releaseRuntimeCPointer = () => undefined;
    let markRuntimeCPointerReady = () => undefined;
    const runtimeCPointerReady = new Promise<void>((resolve) => {
      markRuntimeCPointerReady = resolve;
    });
    const runtimeCPointerBarrier = new Promise<void>((resolve) => {
      releaseRuntimeCPointer = resolve;
    });
    const isPointerTemporaryFile = (targetPath: string) => (
      path.basename(targetPath).startsWith("memory-v6.current.json.")
      && targetPath.endsWith(".tmp")
    );
    try {
      runtimeA = await startMemoryV6RuntimeApi({
        userDataPath: userDataPaths[0],
        applicationInstanceId: TEST_APPLICATION_INSTANCE_A,
        buildChannel: "installed",
        registryDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
        runtimeDirectoryPath,
        runtimePathSecurity: async () => undefined,
      });
      runtimeB = await startMemoryV6RuntimeApi({
        userDataPath: userDataPaths[1],
        applicationInstanceId: TEST_APPLICATION_INSTANCE_B,
        buildChannel: "development",
        registryDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
        runtimeDirectoryPath,
        runtimePathSecurity: async (targetPath) => {
          if (blockRuntimeBCleanupPointer && isPointerTemporaryFile(targetPath)) {
            markRuntimeBCleanupPointerReady();
            await runtimeBCleanupPointerBarrier;
          }
        },
      });

      blockRuntimeBCleanupPointer = true;
      const runtimeBStop = runtimeB.stop();
      await runtimeBCleanupPointerReady;
      runtimeCStart = startMemoryV6RuntimeApi({
        userDataPath: userDataPaths[2],
        applicationInstanceId: TEST_APPLICATION_INSTANCE_C,
        buildChannel: "development",
        registryDirectoryPath: path.join(runtimeDirectoryPath, "registry"),
        runtimeDirectoryPath,
        runtimePathSecurity: async (targetPath) => {
          if (isPointerTemporaryFile(targetPath)) {
            markRuntimeCPointerReady();
            await runtimeCPointerBarrier;
          }
        },
      });
      await runtimeCPointerReady;

      releaseRuntimeBCleanupPointer();
      await runtimeBStop;
      runtimeB = null;
      await assert.rejects(() => stat(path.join(runtimeDirectoryPath, "memory-v6.current.json")));

      releaseRuntimeCPointer();
      runtimeC = await runtimeCStart;
      runtimeCStart = null;
      await assert.rejects(() => stat(path.join(runtimeDirectoryPath, "memory-v6.current.json")));

      await runtimeA.stop();
      runtimeA = null;
      const current = (await readDiscoveryProjection(runtimeC.discoveryFilePath, "cli")).document;
      assert.equal(current.applicationInstanceId, TEST_APPLICATION_INSTANCE_C);
      assert.equal(current.runtimeGenerationId, runtimeC.runtimeGenerationId);
    } finally {
      releaseRuntimeBCleanupPointer();
      releaseRuntimeCPointer();
      if (runtimeCStart) {
        runtimeC = await runtimeCStart.catch(() => null);
      }
      await runtimeB?.stop().catch(() => undefined);
      await runtimeC?.stop().catch(() => undefined);
      await runtimeA?.stop().catch(() => undefined);
      await Promise.all(userDataPaths.map((userDataPath) => (
        rm(userDataPath, { recursive: true, force: true })
      )));
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
