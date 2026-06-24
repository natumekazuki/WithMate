import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION, type MemoryPermission, type NormalizedMemoryTag } from "../../src/memory-v6/memory-contract.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { MemoryV6Service } from "../../src-electron/memory-v6-service.js";
import type { MemoryV6Principal } from "../../src-electron/memory-v6-permission.js";
import type { MemoryV6ResolvedTarget } from "../../src-electron/memory-v6-schema.js";
import { MemoryV6Storage } from "../../src-electron/memory-v6-storage.js";

const allPermissions: MemoryPermission[] = [
  "memory.search",
  "memory.append",
  "memory.forget",
  "memory.get_entry",
  "memory.list_tags",
  "memory.resolve_context",
];

const projectTarget = {
  owner: { type: "project", id: "project-a" },
  scope: { type: "project", id: "project-a" },
} satisfies MemoryV6ResolvedTarget;

const otherProjectTarget = {
  owner: { type: "project", id: "project-b" },
  scope: { type: "project", id: "project-b" },
} satisfies MemoryV6ResolvedTarget;

function tag(type: string, value: string): NormalizedMemoryTag {
  return {
    type,
    value,
    canonicalType: type.normalize("NFC").toLowerCase(),
    canonicalValue: value.normalize("NFC").toLowerCase(),
  };
}

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

async function withService<T>(runner: (input: { service: MemoryV6Service; storage: MemoryV6Storage }) => T | Promise<T>): Promise<T> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-v6-service-"));
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
  try {
    return await runner({ service, storage });
  } finally {
    storage.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
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

function appendRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: MEMORY_V6_SCHEMA_VERSION,
    target: {
      owner: "project",
      scope: "project",
      project: { type: "path", path: "C:/workspace/project-a" },
    },
    kind: "decision",
    title: "Runtime API方針",
    body: "Memory serviceはagent payloadを検証してからstorageへ渡す。",
    preview: "serviceで検証してstorageへ渡す。",
    tags: [{ type: "topic", value: "memory" }],
    ...overrides,
  };
}

describe("MemoryV6Service", () => {
  it("resolve_context はprincipalからsession / character / project / permissionsを返す", async () => {
    await withService(({ service }) => {
      const response = service.resolveContext(principal());

      assert.equal("error" in response, false);
      assert.deepEqual(response, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        session: { id: "session-a" },
        character: { id: "character-a", name: "Character A" },
        sessionProject: { id: "project-a", displayName: "Project A" },
        permissions: allPermissions,
      });
    });
  });

  it("append / search / get_entry / list_tags はvalidation済みtargetをstorageへ渡してresponse contractで返す", async () => {
    await withService(({ service }) => {
      const append = service.append(principal(), appendRequest({ idempotencyKey: "append-key-a", sourceMessageId: "provider-message-42" }));
      assert.equal("error" in append, false);
      assert.equal(append.created, true);
      assert.equal(append.entry.owner.id, "project-a");
      assert.equal(append.entry.state, "active");
      assert.equal("body" in append.entry, false);

      const search = service.search(principal(), {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "alias", alias: "main" } }],
        query: "検証",
      });
      assert.equal("error" in search, false);
      assert.equal(search.items.length, 1);
      assert.equal("body" in search.items[0], false);
      assert.equal("state" in search.items[0], false);

      const detail = service.getEntry(principal(), {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: append.entry.id,
      });
      assert.equal("error" in detail, false);
      assert.equal(detail.entry.body.includes("agent payload"), true);

      const tags = service.listTags(principal(), {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
      });
      assert.equal("error" in tags, false);
      assert.deepEqual(tags.tags, [tag("topic", "memory")].map(({ type, value }) => ({ type, value })));
    });
  });

  it("permission不足とtarget access違反をstorageへ渡す前に拒否する", async () => {
    await withService(({ service }) => {
      const unauthorized = service.search(principal({ permissions: ["memory.resolve_context"] }), {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
        query: "memory",
      });
      assert.equal("error" in unauthorized, true);
      assert.equal(unauthorized.error.code, "MEMORY_UNAUTHORIZED");

      const forbidden = service.append(principal(), appendRequest({
        target: {
          owner: "project",
          scope: "project",
          project: { type: "id", id: "project-b" },
        },
      }));
      assert.equal("error" in forbidden, true);
      assert.equal(forbidden.error.code, "MEMORY_FORBIDDEN");

      const missingCurrentCharacter = service.append(principal({ character: null }), appendRequest({
        target: {
          owner: "character",
          scope: "character",
          character: { type: "current" },
        },
      }));
      assert.equal("error" in missingCurrentCharacter, true);
      assert.equal(missingCurrentCharacter.error.code, "MEMORY_BINDING_REQUIRED");
    });
  });

  it("get_entry / forget はtarget外entryをnot_foundへ畳み存在確認oracleを作らない", async () => {
    await withService(({ service, storage }) => {
      storage.appendEntry({
        target: otherProjectTarget,
        id: "mem-other-project",
        kind: "decision",
        title: "別projectの方針",
        body: "別projectのbody",
        preview: "別project",
        tags: [tag("topic", "secret")],
        source: {
          type: "agent",
          sessionId: null,
          messageId: null,
          providerId: "codex",
        },
      });

      const detail = service.getEntry(principal(), {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "mem-other-project",
      });
      assert.equal("error" in detail, true);
      assert.equal(detail.error.code, "MEMORY_ENTRY_NOT_FOUND");

      const forget = service.forget(principal(), {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryIds: ["mem-other-project", "missing-entry"],
        reason: "privacy",
      });
      assert.equal("error" in forget, false);
      assert.deepEqual(forget.results, [
        { entryId: "mem-other-project", status: "not_found" },
        { entryId: "missing-entry", status: "not_found" },
      ]);
      assert.equal(storage.getEntry("mem-other-project")?.state, "active");
    });
  });

  it("forget はall-not-found resultもidempotentに保存してretryで新規mutationしない", async () => {
    await withService(({ service, storage }) => {
      const request = {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryIds: ["mem-created-after-not-found"],
        reason: "privacy",
        idempotencyKey: "forget-key-all-not-found",
      };

      const first = service.forget(principal(), request);
      assert.equal("error" in first, false);
      assert.deepEqual(first.results, [{ entryId: "mem-created-after-not-found", status: "not_found" }]);

      storage.appendEntry({
        target: projectTarget,
        id: "mem-created-after-not-found",
        kind: "decision",
        title: "後から作られたentry",
        body: "後から作られたbody",
        preview: "後から作られたentry",
        tags: [tag("topic", "retry")],
        source: {
          type: "agent",
          sessionId: null,
          messageId: null,
          providerId: "codex",
        },
      });

      const retry = service.forget(principal(), request);
      assert.equal("error" in retry, false);
      assert.deepEqual(retry.results, [{ entryId: "mem-created-after-not-found", status: "not_found" }]);
      assert.equal(storage.getEntry("mem-created-after-not-found")?.state, "active");
    });
  });

  it("resolverが明示的にnot-foundを返すproject / character targetは拒否する", async () => {
    await withService(({ storage }) => {
      const service = new MemoryV6Service({
        storage,
        resolveProjectById: (id) => id === "project-a" ? { id, displayName: "Project A" } : null,
        resolveProjectByPath: () => null,
        resolveProjectByAlias: () => null,
        resolveCharacterById: (id) => id === "character-a" ? { id, name: "Character A" } : null,
      });

      const missingProject = service.append(principal({ accessibleProjectIds: ["project-stale"] }), appendRequest({
        target: {
          owner: "project",
          scope: "project",
          project: { type: "id", id: "project-stale" },
        },
      }));
      assert.equal("error" in missingProject, true);
      assert.equal(missingProject.error.code, "MEMORY_TARGET_NOT_FOUND");
      assert.equal(missingProject.error.field, "target.project");

      const missingCharacter = service.append(principal({ accessibleCharacterIds: ["character-stale"] }), appendRequest({
        target: {
          owner: "character",
          scope: "character",
          character: { type: "id", id: "character-stale" },
        },
      }));
      assert.equal("error" in missingCharacter, true);
      assert.equal(missingCharacter.error.code, "MEMORY_TARGET_NOT_FOUND");
      assert.equal(missingCharacter.error.field, "target.character");
    });
  });

  it("storage idempotency conflictをmachine-readable errorへ変換する", async () => {
    await withService(({ service }) => {
      const first = service.append(principal(), appendRequest({ idempotencyKey: "append-key-conflict" }));
      assert.equal("error" in first, false);

      const conflict = service.append(principal(), appendRequest({
        idempotencyKey: "append-key-conflict",
        body: "同じkeyで違うbody",
      }));
      assert.equal("error" in conflict, true);
      assert.equal(conflict.error.code, "MEMORY_IDEMPOTENCY_CONFLICT");
    });
  });
});
