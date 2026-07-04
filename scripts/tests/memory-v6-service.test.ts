import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { MEMORY_V6_SCHEMA_VERSION, type NormalizedMemoryTag } from "../../src/memory-v6/memory-contract.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { createMemoryV6ProjectResolver } from "../../src-electron/memory-v6-project-resolver.js";
import { createLocalUserMemoryPrincipal } from "../../src-electron/memory-v6-permission.js";
import type { MemoryV6ResolvedTarget } from "../../src-electron/memory-v6-schema.js";
import { MemoryV6Service } from "../../src-electron/memory-v6-service.js";
import { MemoryV6Storage } from "../../src-electron/memory-v6-storage.js";

const projectTarget = {
  owner: { type: "project", id: "project-a" },
  scope: { type: "project", id: "project-a" },
} satisfies MemoryV6ResolvedTarget;

function tag(type: string, value: string): NormalizedMemoryTag {
  return {
    type,
    value,
    canonicalType: type.normalize("NFC").toLowerCase(),
    canonicalValue: value.normalize("NFC").toLowerCase(),
  };
}

async function withService<T>(
  runner: (input: { service: MemoryV6Service; storage: MemoryV6Storage }) => T | Promise<T>,
): Promise<T> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-v6-service-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
  const storage = new MemoryV6Storage(dbPath);
  const service = new MemoryV6Service({
    storage,
    listCharacters: () => [{
      id: "character-a",
      name: "Character A",
      description: "Test character",
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
    resolveCharacterById: (id) => id === "character-a" ? { id, name: "Character A" } : null,
  });
  try {
    return await runner({ service, storage });
  } finally {
    storage.close();
    await rm(tempDirectory, { recursive: true, force: true });
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
  it("local_user は明示project targetでappend / search / get-entry / list-tags / forgetを扱う", async () => {
    await withService(({ service }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = service.append(principal, appendRequest({
        idempotencyKey: "local-user-project-append",
        sourceMessageId: "external-message-1",
      }));
      assert.equal("error" in append, false);
      assert.equal(append.entry.owner.id, "project-a");
      assert.equal(append.entry.state, "active");

      const search = service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "path", path: "C:/workspace/project-a" } }],
        query: "agent payload",
      });
      assert.equal("error" in search, false);
      assert.deepEqual(search.items.map((item) => item.id), [append.entry.id]);

      const detail = service.getEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: append.entry.id,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      });
      assert.equal("error" in detail, false);
      assert.equal(detail.entry.source.sessionId, null);
      assert.equal(detail.entry.source.providerId, "local-user");

      const tags = service.listTags(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "id", id: "project-a" } }],
      });
      assert.equal("error" in tags, false);
      assert.deepEqual(tags.tags, [{ type: "topic", value: "memory" }]);

      const characters = service.listCharacters(principal);
      assert.equal("error" in characters, false);
      assert.deepEqual(characters.characters, [{
        id: "character-a",
        name: "Character A",
        description: "Test character",
        isDefault: true,
      }]);
      assert.equal("iconFilePath" in characters.characters[0], false);
      assert.equal("theme" in characters.characters[0], false);

      const forget = service.forget(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
        entryIds: [append.entry.id],
        reason: "user_request",
      });
      assert.equal("error" in forget, false);
      assert.deepEqual(forget.results, [{ entryId: append.entry.id, status: "forgotten" }]);
    });
  });

  it("get-entry は必ず明示targetを要求し、target外entryを返さない", async () => {
    await withService(({ service, storage }) => {
      const principal = createLocalUserMemoryPrincipal();
      storage.appendEntry({
        id: "mem-project-a",
        target: projectTarget,
        kind: "note",
        title: "Project A",
        body: "Project A body",
        preview: "Project A",
        tags: [tag("topic", "memory")],
        source: {
          type: "agent",
          sessionId: null,
          messageId: null,
          providerId: "local-user",
        },
      });

      const missingTarget = service.getEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "mem-project-a",
      });
      assert.equal("error" in missingTarget, true);
      assert.equal(missingTarget.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(missingTarget.error.field, "target");

      const mismatchTarget = service.getEntry(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        entryId: "mem-project-a",
        target: { owner: "project", scope: "project", project: { type: "id", id: "project-b" } },
      });
      assert.equal("error" in mismatchTarget, true);
      assert.equal(mismatchTarget.error.code, "MEMORY_ENTRY_NOT_FOUND");
    });
  });

  it("explicit character ID targetを扱い、character.currentはvalidationで拒否する", async () => {
    await withService(({ service }) => {
      const principal = createLocalUserMemoryPrincipal();
      const append = service.append(principal, appendRequest({
        target: {
          owner: "character",
          scope: "character",
          character: { type: "id", id: "character-a" },
        },
        idempotencyKey: "character-id-append",
      }));
      assert.equal("error" in append, false);
      assert.equal(append.entry.owner.type, "character");
      assert.equal(append.entry.owner.id, "character-a");

      const currentCharacter = service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "character", scope: "character", character: { type: "current" } }],
        query: "memory",
      });
      assert.equal("error" in currentCharacter, true);
      assert.equal(currentCharacter.error.code, "MEMORY_INVALID_FIELD");
      assert.equal(currentCharacter.error.field, "targets[0].character.type");
    });
  });

  it("runtime project resolver はproject.pathからV6 project scopeを作成して解決する", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "withmate-memory-v6-project-resolver-"));
    const workspacePath = join(tempDirectory, "repo");
    await mkdir(join(workspacePath, ".git"), { recursive: true });
    const { dbPath } = await createOrVerifyV6FreshDatabase(tempDirectory);
    const storage = new MemoryV6Storage(dbPath);
    const service = new MemoryV6Service({
      storage,
      ...createMemoryV6ProjectResolver(dbPath),
    });
    try {
      const principal = createLocalUserMemoryPrincipal();
      const append = service.append(principal, appendRequest({
        target: {
          owner: "project",
          scope: "project",
          project: { type: "path", path: workspacePath },
        },
      }));
      assert.equal("error" in append, false);

      const search = service.search(principal, {
        schemaVersion: MEMORY_V6_SCHEMA_VERSION,
        targets: [{ owner: "project", scope: "project", project: { type: "path", path: workspacePath } }],
        query: "agent payload",
      });
      assert.equal("error" in search, false);
      assert.deepEqual(search.items.map((item) => item.id), [append.entry.id]);
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
