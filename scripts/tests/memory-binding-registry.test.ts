import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession, type CharacterProfile } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import type { Session } from "../../src/session-state.js";
import { MemoryBindingRegistry } from "../../src-electron/memory-binding-registry.js";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    ...buildNewSession({
      taskTitle: "Memory Binding Test",
      workspaceLabel: "Workspace A",
      workspacePath: "C:/workspace/a",
      branch: "main",
      characterId: "character-a",
      character: "Character A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

function createCharacter(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
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
    ...overrides,
  };
}

function createProvider(id = "codex"): ModelCatalogProvider {
  return {
    id,
    label: id,
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] }],
  };
}

describe("MemoryBindingRegistry", () => {
  it("binding reference から現在sessionのprincipalを解決し、別sessionとは混線しない", () => {
    const registry = new MemoryBindingRegistry({
      resolveProjectByPath: (projectPath) => {
        if (projectPath === "C:/workspace/a") {
          return { id: "project-a", displayName: "Workspace A" };
        }
        if (projectPath === "C:/workspace/b") {
          return { id: "project-b", displayName: "Workspace B" };
        }
        return null;
      },
    });
    const sessionA = createSession({ id: "session-a" });
    const sessionB = createSession({
      id: "session-b",
      workspaceLabel: "Workspace B",
      workspacePath: "C:/workspace/b",
      characterId: "character-b",
      character: "Character B",
    });
    const bindingA = registry.createBinding({
      session: sessionA,
      provider: createProvider("codex"),
      character: createCharacter({ id: "character-a", name: "Character A" }),
    });
    const bindingB = registry.createBinding({
      session: sessionB,
      provider: createProvider("copilot"),
      character: createCharacter({ id: "character-b", name: "Character B" }),
    });

    assert.ok(bindingA);
    assert.ok(bindingB);
    assert.notEqual(bindingA.bindingReference, bindingB.bindingReference);

    const principalA = registry.resolvePrincipal(bindingA.bindingReference);
    const principalB = registry.resolvePrincipal(bindingB.bindingReference);

    assert.equal(registry.getActiveBindingCount(), 2);
    assert.equal(principalA?.sessionId, "session-a");
    assert.equal(principalA?.providerId, "codex");
    assert.equal(principalA?.character?.id, "character-a");
    assert.equal(principalA?.sessionProject?.id, "project-a");
    assert.deepEqual(principalA?.accessibleProjectIds, ["project-a"]);
    assert.deepEqual(principalA?.accessibleProjects, [{ id: "project-a", displayName: "Workspace A" }]);
    assert.equal(principalB?.sessionId, "session-b");
    assert.equal(principalB?.providerId, "copilot");
    assert.equal(principalB?.character?.id, "character-b");
    assert.equal(principalB?.sessionProject?.id, "project-b");
  });

  it("revoke後と期限切れ後はbinding referenceをprincipalへ解決しない", () => {
    const registry = new MemoryBindingRegistry();
    const binding = registry.createBinding({
      session: createSession(),
      provider: createProvider("codex"),
      character: createCharacter(),
      expiresAt: "2026-06-27T00:01:00.000Z",
    });

    assert.ok(binding);
    assert.equal(registry.getActiveBindingCount(new Date("2026-06-27T00:00:30.000Z")), 1);
    assert.ok(registry.resolvePrincipal(binding.bindingReference, new Date("2026-06-27T00:00:30.000Z")));
    assert.equal(registry.resolvePrincipal(binding.bindingReference, new Date("2026-06-27T00:01:00.000Z")), null);
    assert.equal(registry.getActiveBindingCount(new Date("2026-06-27T00:01:00.000Z")), 0);

    const nextBinding = registry.createBinding({
      session: createSession({ id: "session-next" }),
      provider: createProvider("codex"),
      character: createCharacter(),
    });
    assert.ok(nextBinding);
    registry.revokeBinding(nextBinding);
    assert.equal(registry.resolvePrincipal(nextBinding.bindingReference), null);
  });

  it("session単位とapp終了相当でbindingを失効する", () => {
    const registry = new MemoryBindingRegistry();
    const sessionBinding = registry.createBinding({
      session: createSession({ id: "session-a" }),
      provider: createProvider("codex"),
      character: createCharacter(),
    });
    const otherBinding = registry.createBinding({
      session: createSession({ id: "session-b" }),
      provider: createProvider("codex"),
      character: createCharacter(),
    });

    assert.ok(sessionBinding);
    assert.ok(otherBinding);
    registry.revokeSessionBindings("session-a");
    assert.equal(registry.resolvePrincipal(sessionBinding.bindingReference), null);
    assert.ok(registry.resolvePrincipal(otherBinding.bindingReference));

    registry.revokeAll();
    assert.equal(registry.resolvePrincipal(otherBinding.bindingReference), null);
  });

  it("同一sessionで新しいbindingを作ると古いbindingを失効する", () => {
    const registry = new MemoryBindingRegistry();
    const session = createSession({ id: "session-a" });
    const firstBinding = registry.createBinding({
      session,
      provider: createProvider("codex"),
      character: createCharacter(),
      runId: "run-a",
    });
    const secondBinding = registry.createBinding({
      session,
      provider: createProvider("codex"),
      character: createCharacter(),
      runId: "run-b",
    });

    assert.ok(firstBinding);
    assert.ok(secondBinding);
    assert.notEqual(firstBinding.bindingReference, secondBinding.bindingReference);
    assert.equal(registry.resolvePrincipal(firstBinding.bindingReference), null);
    assert.equal(registry.resolvePrincipal(secondBinding.bindingReference)?.sessionId, "session-a");
  });

  it("binding未確認providerはunsupported projectionにしてprincipalを作らない", () => {
    const registry = new MemoryBindingRegistry();
    const session = createSession({ id: "session-a" });
    const staleBinding = registry.createBinding({
      session,
      provider: createProvider("codex"),
      character: createCharacter(),
    });
    const binding = registry.createBinding({
      session,
      provider: createProvider("unknown"),
      character: createCharacter(),
    });

    assert.ok(staleBinding);
    assert.ok(binding);
    assert.equal(binding.transport, "unsupported");
    assert.equal(binding.bindingReference, "");
    assert.equal(registry.resolvePrincipal(staleBinding.bindingReference), null);
    assert.equal(registry.resolvePrincipal(binding.bindingReference), null);
  });

  it("sessionの追加ディレクトリをGit project targetとして解決できる場合だけprincipalへ含める", () => {
    const registry = new MemoryBindingRegistry({
      resolveProjectByPath: (projectPath) => {
        if (projectPath === "C:/workspace/a") {
          return { id: "project-a", displayName: "Workspace A" };
        }
        if (projectPath === "D:/delivery/repo") {
          return { id: "project-delivery", displayName: "Delivery Repo" };
        }
        return null;
      },
    });
    const binding = registry.createBinding({
      session: createSession({
        allowedAdditionalDirectories: ["D:/delivery/repo", "E:/notes", "D:/delivery/repo"],
      }),
      provider: createProvider("codex"),
      character: createCharacter(),
    });

    assert.ok(binding);
    const principal = registry.resolvePrincipal(binding.bindingReference);
    assert.deepEqual(principal?.sessionProject, { id: "project-a", displayName: "Workspace A" });
    assert.deepEqual(principal?.accessibleProjectIds, ["project-a", "project-delivery"]);
    assert.deepEqual(principal?.accessibleProjects, [
      { id: "project-a", displayName: "Workspace A" },
      { id: "project-delivery", displayName: "Delivery Repo" },
    ]);
  });
});
