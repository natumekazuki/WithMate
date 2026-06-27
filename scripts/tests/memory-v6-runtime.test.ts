import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession, type CharacterProfile } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import {
  resolveDefaultWithMateMemoryDiscoveryFilePath,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
} from "../../src/memory-v6/memory-discovery.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import {
  publishMemoryV6DiscoveryFile,
  startMemoryV6RuntimeApi,
} from "../../src-electron/memory-v6-runtime.js";
import { MemoryBindingRegistry } from "../../src-electron/memory-binding-registry.js";
import { WITHMATE_MEMORY_BINDING_REFERENCE_HEADER } from "../../src-electron/provider-memory-binding.js";

function createProvider(id = "codex"): ModelCatalogProvider {
  return {
    id,
    label: id,
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] }],
  };
}

function createCharacter(): CharacterProfile {
  return {
    id: "character-a",
    name: "Character A",
    iconPath: "",
    description: "",
    roleMarkdown: "",
    notesMarkdown: "",
    updatedAt: "2026-06-27T00:00:00.000Z",
    themeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    sessionCopy: {
      pendingApproval: [],
      pendingWorking: [],
      pendingResponding: [],
      pendingPreparing: [],
      retryInterruptedTitle: [],
      retryFailedTitle: [],
      retryCanceledTitle: [],
      latestCommandWaiting: [],
      latestCommandEmpty: [],
      changedFilesEmpty: [],
      contextEmpty: [],
    },
  };
}

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

  it("V6 DBをbootstrapし、status endpointをdiscovery file経由で公開する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    try {
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

        const context = await fetch(`${runtime.baseUrl}/v1/context`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
          },
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

  it("runtime APIはregistry binding referenceをprincipalへ解決し、revoke後は拒否する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const bindingRegistry = new MemoryBindingRegistry();
    try {
      const runtime = await startMemoryV6RuntimeApi({ userDataPath, runtimeDirectoryPath, bindingRegistry });
      try {
        const discovery = JSON.parse(await readFile(runtime.discoveryFilePath, "utf8"));
        const binding = bindingRegistry.createBinding({
          session: buildNewSession({
            taskTitle: "Memory Binding Runtime",
            workspaceLabel: "Workspace A",
            workspacePath: "C:/workspace/a",
            branch: "main",
            characterId: "character-a",
            character: "Character A",
            characterIconPath: "",
            characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
            approvalMode: DEFAULT_APPROVAL_MODE,
          }),
          provider: createProvider("codex"),
          character: createCharacter(),
        });
        assert.ok(binding);

        const context = await fetch(`${runtime.baseUrl}/v1/context`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
            [WITHMATE_MEMORY_BINDING_REFERENCE_HEADER]: binding.bindingReference,
          },
          body: JSON.stringify({ schemaVersion: "withmate-memory-v1" }),
        });
        assert.equal(context.status, 200);
        const contextJson = await context.json();
        assert.equal(contextJson.schemaVersion, "withmate-memory-v1");
        assert.deepEqual(contextJson.session, { id: bindingRegistry.resolvePrincipal(binding.bindingReference)?.sessionId });
        assert.deepEqual(contextJson.character, { id: "character-a", name: "Character A" });
        assert.equal(contextJson.sessionProject.displayName, "Workspace A");
        assert.match(contextJson.sessionProject.id, /^project-/);
        assert.deepEqual(contextJson.permissions, [
          "memory.resolve_context",
          "memory.search",
          "memory.get_entry",
          "memory.list_tags",
          "memory.append",
          "memory.forget",
        ]);

        const append = await fetch(`${runtime.baseUrl}/v1/append`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
            [WITHMATE_MEMORY_BINDING_REFERENCE_HEADER]: binding.bindingReference,
          },
          body: JSON.stringify({
            schemaVersion: "withmate-memory-v1",
            target: {
              owner: "project",
              scope: "project",
              project: { type: "id", id: contextJson.sessionProject.id },
            },
            kind: "note",
            title: "Runtime binding project id",
            body: "context.sessionProject.id can be reused as a project target.",
            preview: "sessionProject.id is reusable.",
            tags: [{ type: "topic", value: "runtime" }],
          }),
        });
        assert.equal(append.status, 200);
        const appendJson = await append.json();
        assert.equal(appendJson.entry.owner.id, contextJson.sessionProject.id);

        const search = await fetch(`${runtime.baseUrl}/v1/search`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
            [WITHMATE_MEMORY_BINDING_REFERENCE_HEADER]: binding.bindingReference,
          },
          body: JSON.stringify({
            schemaVersion: "withmate-memory-v1",
            targets: [{
              owner: "project",
              scope: "project",
              project: { type: "id", id: contextJson.sessionProject.id },
            }],
            query: "reusable",
          }),
        });
        assert.equal(search.status, 200);
        const searchJson = await search.json();
        assert.equal(searchJson.items.length, 1);
        assert.equal(searchJson.items[0].id, appendJson.entry.id);

        assert.deepEqual({
          schemaVersion: "withmate-memory-v1",
          session: { id: bindingRegistry.resolvePrincipal(binding.bindingReference)?.sessionId },
          character: { id: "character-a", name: "Character A" },
          sessionProject: contextJson.sessionProject,
          permissions: [
            "memory.resolve_context",
            "memory.search",
            "memory.get_entry",
            "memory.list_tags",
            "memory.append",
            "memory.forget",
          ],
        }, contextJson);

        bindingRegistry.revokeBinding(binding);
        const revokedContext = await fetch(`${runtime.baseUrl}/v1/context`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-WithMate-Memory-Api-Secret": discovery.apiSecret,
            [WITHMATE_MEMORY_BINDING_REFERENCE_HEADER]: binding.bindingReference,
          },
          body: JSON.stringify({ schemaVersion: "withmate-memory-v1" }),
        });
        assert.equal(revokedContext.status, 401);
        assert.equal((await revokedContext.json()).error.code, "MEMORY_BINDING_REQUIRED");
      } finally {
        await runtime.stop();
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  it("runtime stopはregistry bindingを全失効する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const bindingRegistry = new MemoryBindingRegistry();
    try {
      const runtime = await startMemoryV6RuntimeApi({ userDataPath, runtimeDirectoryPath, bindingRegistry });
      const binding = bindingRegistry.createBinding({
        session: buildNewSession({
          taskTitle: "Memory Binding Runtime",
          workspaceLabel: "Workspace A",
          workspacePath: "C:/workspace/a",
          branch: "main",
          characterId: "character-a",
          character: "Character A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        provider: createProvider("codex"),
        character: createCharacter(),
      });
      assert.ok(binding);
      assert.ok(bindingRegistry.resolvePrincipal(binding.bindingReference));

      await runtime.stop();
      assert.equal(bindingRegistry.resolvePrincipal(binding.bindingReference), null);
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

  it("stale discovery fileがある状態でinvalid V6 DBの場合はstale fileも残さない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const discoveryFilePath = path.join(runtimeDirectoryPath, "memory-v6-api.json");
    try {
      await writeFile(path.join(userDataPath, "withmate-v6.db"), "not sqlite", "utf8");
      await writeFile(discoveryFilePath, JSON.stringify({
        schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
        baseUrl: "http://127.0.0.1:9",
        runtimeInstanceId: "stale-runtime",
      }), "utf8");

      await assert.rejects(
        () => startMemoryV6RuntimeApi({ userDataPath, runtimeDirectoryPath }),
        /does not match the V6 foundation schema/,
      );
      await assert.rejects(() => stat(discoveryFilePath));
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });

  it("stale discovery fileの外部URLには起動時確認を送らず削除する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-userdata-"));
    const runtimeDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-v6-runtime-"));
    const discoveryFilePath = path.join(runtimeDirectoryPath, "memory-v6-api.json");
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    try {
      await writeFile(path.join(userDataPath, "withmate-v6.db"), "not sqlite", "utf8");
      await writeFile(discoveryFilePath, JSON.stringify({
        schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
        baseUrl: "http://192.168.0.10:7777",
        apiSecret: "stale-secret",
        runtimeInstanceId: "stale-runtime",
      }), "utf8");
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("external URL should not be fetched");
      }) as typeof fetch;

      await assert.rejects(
        () => startMemoryV6RuntimeApi({ userDataPath, runtimeDirectoryPath }),
        /does not match the V6 foundation schema/,
      );
      assert.equal(fetchCalls, 0);
      await assert.rejects(() => stat(discoveryFilePath));
    } finally {
      globalThis.fetch = originalFetch;
      await rm(userDataPath, { recursive: true, force: true });
      await rm(runtimeDirectoryPath, { recursive: true, force: true });
    }
  });
});
