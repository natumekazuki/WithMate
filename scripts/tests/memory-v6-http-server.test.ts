import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION, type MemoryPermission } from "../../src/memory-v6/memory-contract.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { createMemoryV6HttpServer, isLoopbackListenHost, isLoopbackRemoteAddress, type MemoryV6HttpServer } from "../../src-electron/memory-v6-http-server.js";
import type { MemoryV6Principal } from "../../src-electron/memory-v6-permission.js";
import { MemoryV6Service } from "../../src-electron/memory-v6-service.js";
import { MemoryV6Storage } from "../../src-electron/memory-v6-storage.js";

const allPermissions: MemoryPermission[] = [
  "memory.search",
  "memory.append",
  "memory.forget",
  "memory.get_entry",
  "memory.list_tags",
  "memory.resolve_context",
];

function principal(overrides: Partial<MemoryV6Principal> = {}): MemoryV6Principal {
  return {
    bindingIdHash: "binding-hash-a",
    sessionId: "session-a",
    providerId: "codex",
    permissions: allPermissions,
    character: { id: "character-a", name: "Character A" },
    sessionProject: { id: "project-a", displayName: "Project A" },
    ...overrides,
  };
}

function seedRuntimeContext(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO project_scopes_v6 (
        id,
        project_type,
        project_key,
        workspace_path,
        display_name,
        created_at,
        updated_at
      ) VALUES (?, 'directory', ?, ?, ?, ?, ?)
    `).run("project-a", "directory:C:/workspace/project-a", "C:/workspace/project-a", "Project A", "2026-06-24T00:00:00.000Z", "2026-06-24T00:00:00.000Z");
    db.prepare(`
      INSERT INTO sessions_v6 (
        id,
        title,
        state,
        provider_id,
        catalog_revision,
        model_id,
        approval_mode,
        project_scope_id,
        workspace_path,
        created_at,
        updated_at,
        last_active_at
      ) VALUES (?, 'Session A', 'active', 'codex', 1, 'gpt-5', 'default', ?, ?, ?, ?, ?)
    `).run("session-a", "project-a", "C:/workspace/project-a", "2026-06-24T00:00:00.000Z", "2026-06-24T00:00:00.000Z", "2026-06-24T00:00:00.000Z");
  } finally {
    db.close();
  }
}

async function withMemoryApi<T>(
  runner: (input: { baseUrl: string; storage: MemoryV6Storage; server: MemoryV6HttpServer }) => T | Promise<T>,
  principalOverride: MemoryV6Principal | null = principal(),
  serverOptions: {
    maxConcurrentRequests?: number;
    resolvePrincipal?: (request: IncomingMessage) => MemoryV6Principal | null | Promise<MemoryV6Principal | null>;
  } = {},
): Promise<T> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-v6-http-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
  seedRuntimeContext(dbPath);
  const storage = new MemoryV6Storage(dbPath);
  const service = new MemoryV6Service({
    storage,
    resolveProjectById: (id) => ({ id, displayName: id }),
    resolveProjectByPath: (projectPath) => projectPath === "C:/workspace/project-a" ? { id: "project-a", displayName: "Project A" } : null,
    resolveProjectByAlias: (alias) => alias === "main" ? { id: "project-a", displayName: "Project A" } : null,
    resolveCharacterById: (id) => id === "character-a" ? { id, name: "Character A" } : null,
  });
  const server = createMemoryV6HttpServer({
    service,
    maxBodyBytes: 512,
    maxConcurrentRequests: serverOptions.maxConcurrentRequests,
    resolvePrincipal: serverOptions.resolvePrincipal ?? (() => principalOverride),
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

async function postJson(baseUrl: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    assert.equal(isLoopbackRemoteAddress("10.0.0.5"), false);
    assert.equal(isLoopbackRemoteAddress(undefined), false);
    assert.equal(isLoopbackListenHost("localhost"), true);
    assert.equal(isLoopbackListenHost("0.0.0.0"), false);
  });

  it("loopback以外のhostではlistenしない", async () => {
    await withMemoryApi(async ({ server, storage }) => {
      const service = new MemoryV6Service({ storage });
      const unsafeServer = createMemoryV6HttpServer({
        host: "0.0.0.0",
        service,
        resolvePrincipal: () => principal(),
      });

      await assert.rejects(() => unsafeServer.start(), /loopback/);
      await unsafeServer.stop();
      assert.ok(server.address());
    });
  });

  it("status と context をJSONで返す", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      const status = await fetch(`${baseUrl}/v1/status`);
      assert.equal(status.status, 200);
      assert.deepEqual(await status.json(), { ok: true });

      const context = await postJson(baseUrl, "/v1/context", { schemaVersion: MEMORY_V6_SCHEMA_VERSION });
      assert.equal(context.status, 200);
      assert.deepEqual(context.json, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        session: { id: "session-a" },
        character: { id: "character-a", name: "Character A" },
        sessionProject: { id: "project-a", displayName: "Project A" },
        permissions: allPermissions,
      });
    });
  });

  it("context requestのschemaVersion不一致を422で返す", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      const context = await postJson(baseUrl, "/v1/context", {});

      assert.equal(context.status, 422);
      assert.equal(context.json.error.code, "MEMORY_INVALID_SCHEMA_VERSION");
    });
  });

  it("append / search / get_entry / list_tags / forget をserviceへdispatchする", async () => {
    await withMemoryApi(async ({ baseUrl, storage }) => {
      const append = await postJson(baseUrl, "/v1/append", appendRequest({ idempotencyKey: "append-key-http" }));
      assert.equal(append.status, 200);
      assert.equal(append.json.created, true);
      assert.equal(append.json.entry.owner.id, "project-a");
      assert.equal("body" in append.json.entry, false);

      const search = await postJson(baseUrl, "/v1/search", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "alias", alias: "main" } }],
        query: "localhost",
      });
      assert.equal(search.status, 200);
      assert.equal(search.json.items.length, 1);
      assert.equal(search.json.items[0].id, append.json.entry.id);

      const detail = await postJson(baseUrl, "/v1/get_entry", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: append.json.entry.id,
      });
      assert.equal(detail.status, 200);
      assert.equal(detail.json.entry.body, "Memory localhost APIはservice境界を薄く包む。");

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

  it("bindingなしのservice errorをHTTP statusへ写像する", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      const response = await postJson(baseUrl, "/v1/search", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
        query: "memory",
      });
      assert.equal(response.status, 401);
      assert.equal(response.json.error.code, "MEMORY_BINDING_REQUIRED");
    }, null);
  });

  it("invalid route / method / JSON / body sizeをtransport errorで返す", async () => {
    await withMemoryApi(async ({ baseUrl }) => {
      const missing = await fetch(`${baseUrl}/v1/missing`, { method: "POST", body: "{}" });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, "MEMORY_ROUTE_NOT_FOUND");

      const invalidMethod = await fetch(`${baseUrl}/v1/search`);
      assert.equal(invalidMethod.status, 405);
      assert.equal((await invalidMethod.json()).error.code, "MEMORY_METHOD_NOT_ALLOWED");

      const invalidJson = await fetch(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      assert.equal(invalidJson.status, 400);
      assert.equal((await invalidJson.json()).error.code, "MEMORY_INVALID_JSON");

      const tooLarge = await fetch(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: "x".repeat(800) }),
      });
      assert.equal(tooLarge.status, 413);
      assert.equal((await tooLarge.json()).error.code, "MEMORY_REQUEST_TOO_LARGE");
    });
  });

  it("browser-origin request とJSON以外のPOSTをservice到達前に拒否する", async () => {
    let resolverCalls = 0;
    await withMemoryApi(async ({ baseUrl }) => {
      const browserRequest = await fetch(`${baseUrl}/v1/append`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Origin": "https://example.invalid",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify(appendRequest()),
      });
      assert.equal(browserRequest.status, 403);
      assert.equal((await browserRequest.json()).error.code, "MEMORY_BROWSER_REQUEST_FORBIDDEN");
      assert.equal(resolverCalls, 0);

      const nullOriginRequest = await fetch(`${baseUrl}/v1/context`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "null",
        },
        body: "{}",
      });
      assert.equal(nullOriginRequest.status, 403);
      assert.equal((await nullOriginRequest.json()).error.code, "MEMORY_BROWSER_REQUEST_FORBIDDEN");
      assert.equal(resolverCalls, 0);

      const unsupportedMediaType = await fetch(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({
          schemaVersion: MEMORY_V6_SCHEMA_VERSION,
          targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
          query: "memory",
        }),
      });
      assert.equal(unsupportedMediaType.status, 415);
      assert.equal((await unsupportedMediaType.json()).error.code, "MEMORY_UNSUPPORTED_MEDIA_TYPE");
      assert.equal(resolverCalls, 0);
    }, principal(), {
      resolvePrincipal: () => {
        resolverCalls += 1;
        return principal();
      },
    });
  });

  it("同時実行上限を超えたrequestはresolverへ到達しない", async () => {
    let releaseFirstRequest!: () => void;
    const firstRequestGate = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let resolverCalls = 0;

    await withMemoryApi(async ({ baseUrl }) => {
      const firstRequest = postJson(baseUrl, "/v1/context", { schemaVersion: MEMORY_V6_SCHEMA_VERSION });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      const rejected = await postJson(baseUrl, "/v1/search", {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
        query: "memory",
      });
      assert.equal(rejected.status, 429);
      assert.equal(rejected.json.error.code, "MEMORY_TOO_MANY_REQUESTS");
      assert.equal(resolverCalls, 1);

      releaseFirstRequest();
      const firstResponse = await firstRequest;
      assert.equal(firstResponse.status, 200);
      assert.equal(firstResponse.json.session.id, "session-a");
    }, principal(), {
      maxConcurrentRequests: 1,
      resolvePrincipal: async () => {
        resolverCalls += 1;
        await firstRequestGate;
        return principal();
      },
    });
  });
});
