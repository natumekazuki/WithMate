import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION } from "../../src/memory-v6/memory-contract.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { createMemoryV6HttpServer, isLoopbackListenHost, isLoopbackRemoteAddress, type MemoryV6HttpServer } from "../../src-electron/memory-v6-http-server.js";
import { MemoryV6Service } from "../../src-electron/memory-v6-service.js";
import { MemoryV6Storage } from "../../src-electron/memory-v6-storage.js";

const TEST_API_SECRET = "test-secret";
const TEST_RUNTIME_INSTANCE_ID = "test-runtime";

async function withMemoryApi<T>(
  runner: (input: { baseUrl: string; storage: MemoryV6Storage; server: MemoryV6HttpServer }) => T | Promise<T>,
): Promise<T> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-v6-http-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
  const storage = new MemoryV6Storage(dbPath);
  const service = new MemoryV6Service({
    storage,
    listCharacters: () => [{
      id: "mika",
      name: "Mika",
      description: "Guitar",
      iconFilePath: "",
      theme: { main: "#111111", sub: "#222222" },
      state: "active",
      isDefault: true,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      archivedAt: null,
    }],
    resolveProjectById: (id) => ({ id, displayName: id }),
    resolveProjectByPath: (projectPath) => projectPath === "C:/workspace/project-a"
      ? { id: "project-a", displayName: "Project A" }
      : null,
  });
  const server = createMemoryV6HttpServer({
    service,
    apiSecret: TEST_API_SECRET,
    runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID,
    maxBodyBytes: 512,
  });

  try {
    await server.start();
    const address = server.address();
    assert.ok(address);
    return await runner({ baseUrl: `http://127.0.0.1:${address.port}`, storage, server });
  } finally {
    await server.stop();
    storage.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function postJson(baseUrl: string, path: string, body: unknown, apiSecret = TEST_API_SECRET): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-WithMate-Memory-Api-Secret": apiSecret,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: await response.json(),
  };
}

function appendRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    target: {
      owner: "project",
      scope: "project",
      project: { type: "path", path: "C:/workspace/project-a" },
    },
    kind: "decision",
    title: "localhost API方針",
    body: "Memory localhost APIはservice境界を薄く包む。",
    preview: "localhost APIはservice境界を薄く包む。",
    tags: [{ type: "topic", value: "memory-api" }],
    ...overrides,
  };
}

describe("MemoryV6HttpServer", () => {
  it("loopback addressだけを許可対象にする", () => {
    assert.equal(isLoopbackRemoteAddress("127.0.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("127.12.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("::1"), true);
    assert.equal(isLoopbackRemoteAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackRemoteAddress("192.168.0.10"), false);
    assert.equal(isLoopbackRemoteAddress(undefined), false);
    assert.equal(isLoopbackListenHost("localhost"), true);
    assert.equal(isLoopbackListenHost("0.0.0.0"), false);
  });

  it("status とchallengeをJSONで返し、context routeは公開しない", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      const status = await fetch(`${baseUrl}/v1/status`);
      assert.equal(status.status, 200);
      assert.deepEqual(await status.json(), { ok: true, runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID });

      const nonce = "nonce-a";
      const challengedStatus = await fetch(`${baseUrl}/v1/status?nonce=${nonce}`);
      assert.equal(challengedStatus.status, 200);
      assert.deepEqual(await challengedStatus.json(), {
        ok: true,
        runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID,
        challenge: {
          nonce,
          hmacSha256: createHmac("sha256", TEST_API_SECRET).update(nonce, "utf8").digest("base64url"),
        },
      });

      const context = await postJson(baseUrl, "/v1/context", { schemaVersion: MEMORY_V6_SCHEMA_VERSION });
      assert.equal(context.status, 404);
      assert.equal(context.json.error.code, "MEMORY_ROUTE_NOT_FOUND");
    });
  });

  it("apiSecretなしではserverを作成できず、secretなしのrequestを拒否する", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      assert.throws(() => createMemoryV6HttpServer({
        service: {} as MemoryV6Service,
        apiSecret: "",
        runtimeInstanceId: TEST_RUNTIME_INSTANCE_ID,
      }), /apiSecret/);

      const missingSecret = await fetch(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schemaVersion: MEMORY_V6_SCHEMA_VERSION }),
      });
      assert.equal(missingSecret.status, 401);
      assert.equal((await missingSecret.json()).error.code, "MEMORY_UNAUTHORIZED");

      const wrongSecret = await postJson(baseUrl, "/v1/search", { schemaVersion: MEMORY_V6_SCHEMA_VERSION }, "wrong-secret");
      assert.equal(wrongSecret.status, 401);
      assert.equal(wrongSecret.json.error.code, "MEMORY_UNAUTHORIZED");
    });
  });

  it("append / search / get_entry / list_tags / forget をlocal_userとしてdispatchする", async () => {
    await withMemoryApi(async ({ baseUrl, storage }) => {
      const characters = await fetch(`${baseUrl}/v1/characters`, {
        headers: { "X-WithMate-Memory-Api-Secret": TEST_API_SECRET },
      });
      assert.equal(characters.status, 200);
      assert.deepEqual((await characters.json()).characters.map((character: { id: string }) => character.id), ["mika"]);

      const append = await postJson(baseUrl, "/v1/append", appendRequest({ idempotencyKey: "append-key-http" }));
      assert.equal(append.status, 200);
      assert.equal(append.json.created, true);
      assert.equal(append.json.entry.owner.id, "project-a");

      const search = await postJson(baseUrl, "/v1/search", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
        query: "localhost",
      });
      assert.equal(search.status, 200);
      assert.deepEqual(search.json.items.map((item: { id: string }) => item.id), [append.json.entry.id]);

      const detail = await postJson(baseUrl, "/v1/get_entry", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: append.json.entry.id,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      });
      assert.equal(detail.status, 200);
      assert.equal(detail.json.entry.source.providerId, "local-user");

      const tags = await postJson(baseUrl, "/v1/list_tags", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
      });
      assert.equal(tags.status, 200);
      assert.deepEqual(tags.json.tags, [{ type: "topic", value: "memory-api" }]);

      const forget = await postJson(baseUrl, "/v1/forget", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryIds: [append.json.entry.id],
        reason: "privacy",
      });
      assert.equal(forget.status, 200);
      assert.deepEqual(forget.json.results, [{ entryId: append.json.entry.id, status: "forgotten" }]);
      assert.equal(storage.getEntry(append.json.entry.id)?.state, "forgotten");
    });
  });

  it("invalid route / method / JSON / body sizeをtransport errorで返す", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      const missing = await fetch(`${baseUrl}/v1/missing`, {
        method: "POST",
        headers: { "X-WithMate-Memory-Api-Secret": TEST_API_SECRET },
        body: "{}",
      });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, "MEMORY_ROUTE_NOT_FOUND");

      const invalidMethod = await fetch(`${baseUrl}/v1/search`, {
        headers: { "X-WithMate-Memory-Api-Secret": TEST_API_SECRET },
      });
      assert.equal(invalidMethod.status, 405);
      assert.equal((await invalidMethod.json()).error.code, "MEMORY_METHOD_NOT_ALLOWED");

      const invalidJson = await fetch(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
        },
        body: "{",
      });
      assert.equal(invalidJson.status, 400);
      assert.equal((await invalidJson.json()).error.code, "MEMORY_INVALID_JSON");

      const tooLarge = await fetch(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WithMate-Memory-Api-Secret": TEST_API_SECRET,
        },
        body: JSON.stringify({ payload: "x".repeat(800) }),
      });
      assert.equal(tooLarge.status, 413);
      assert.equal((await tooLarge.json()).error.code, "MEMORY_REQUEST_TOO_LARGE");
    });
  });
});
