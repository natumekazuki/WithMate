import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentRuntimeBindingRegistry } from "../../src-electron/agent-runtime-binding.js";
import { updateAuxiliarySessionWithProviderRuntimeLifecycle } from "../../src-electron/auxiliary-provider-runtime-lifecycle.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";

function createAuxiliarySession(provider: string): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "session-1",
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider,
    catalogRevision: 1,
    model: provider === "codex" ? "gpt-5.4" : "claude-sonnet-4.5",
    reasoningEffort: "medium",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write-network",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    closedAt: "",
  };
}

describe("Auxiliary provider runtime lifecycle", () => {
  it("providerをA→B→Aと変更しても旧bindingと旧provider clientを再利用しない", async () => {
    const registry = new AgentRuntimeBindingRegistry();
    let current = createAuxiliarySession("codex");
    const invalidatedProviders: string[] = [];
    const firstCodexBinding = registry.issueOrReuse({
      actorSessionId: current.id,
      providerId: "codex",
      operationGrants: ["memory.search"],
    });

    const update = (session: AuxiliarySession) => updateAuxiliarySessionWithProviderRuntimeLifecycle({
      session,
      isRunInFlight: () => false,
      getAuxiliarySession: () => current,
      updateAuxiliarySession: (next) => {
        current = next;
        return next;
      },
      revokeSessionAgentRuntimeBindings: (sessionId) => registry.revokeSession(sessionId),
      invalidateProviderSessionThread: async (providerId) => {
        invalidatedProviders.push(providerId);
      },
    });

    await update(createAuxiliarySession("copilot"));
    assert.equal(registry.resolve(firstCodexBinding.bindingReference, "memory.search").ok, false);
    const copilotBinding = registry.issueOrReuse({
      actorSessionId: current.id,
      providerId: "copilot",
      operationGrants: ["memory.search"],
    });

    await update(createAuxiliarySession("codex"));
    assert.equal(registry.resolve(copilotBinding.bindingReference, "memory.search").ok, false);
    const nextCodexBinding = registry.issueOrReuse({
      actorSessionId: current.id,
      providerId: "codex",
      operationGrants: ["memory.search"],
    });
    assert.notEqual(nextCodexBinding.bindingReference, firstCodexBinding.bindingReference);
    assert.deepEqual(invalidatedProviders, ["codex", "copilot"]);
  });

  it("runtime identityが変わらない更新ではbindingとclientを維持する", async () => {
    let current = createAuxiliarySession("codex");
    let revoked = false;
    let invalidated = false;
    const updated = await updateAuxiliarySessionWithProviderRuntimeLifecycle({
      session: { ...current, title: "Renamed" },
      isRunInFlight: () => false,
      getAuxiliarySession: () => current,
      updateAuxiliarySession: (next) => {
        current = next;
        return next;
      },
      revokeSessionAgentRuntimeBindings: () => {
        revoked = true;
      },
      invalidateProviderSessionThread: async () => {
        invalidated = true;
      },
    });

    assert.equal(updated.title, "Renamed");
    assert.equal(revoked, false);
    assert.equal(invalidated, false);
  });

  it("composer preview中のstarting runではprovider更新をside effect前に拒否する", async () => {
    const current = createAuxiliarySession("codex");
    let updated = false;
    let revoked = false;
    let invalidated = false;

    await assert.rejects(
      () => updateAuxiliarySessionWithProviderRuntimeLifecycle({
        session: createAuxiliarySession("copilot"),
        isRunInFlight: () => true,
        getAuxiliarySession: () => current,
        updateAuxiliarySession: () => {
          updated = true;
          return current;
        },
        revokeSessionAgentRuntimeBindings: () => {
          revoked = true;
        },
        invalidateProviderSessionThread: async () => {
          invalidated = true;
        },
      }),
      /実行中の Auxiliary Session は更新できない/,
    );

    assert.equal(updated, false);
    assert.equal(revoked, false);
    assert.equal(invalidated, false);
  });
});
