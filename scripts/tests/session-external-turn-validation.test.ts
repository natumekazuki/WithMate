import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession, type RunSessionTurnRequest, type Session } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import {
  SessionRuntimeService,
  type SessionRuntimeServiceDeps,
} from "../../src-electron/session-runtime-service.js";
import { SessionTurnValidationError } from "../../src-electron/session-turn-validation-error.js";

const request: RunSessionTurnRequest = {
  userMessage: "hello",
  model: "gpt-5.4",
  reasoningEffort: "high",
  approvalMode: "on-request",
  codexSandboxMode: "workspace-write",
};

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    ...buildNewSession({
      taskTitle: "External validation",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "character-1",
      character: "Character",
      characterIconPath: "",
      characterThemeColors: { main: "#000000", sub: "#111111" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

function createService(session: Session) {
  const calls = {
    composerScopes: [] as string[],
    catalogRevisions: [] as Array<number | null | undefined>,
    adapter: 0,
  };
  const service = new SessionRuntimeService({
    getSession: () => session,
    resolveComposerPreview: async (_session, _message, scope) => {
      calls.composerScopes.push(scope);
      return { attachments: [], errors: [] };
    },
    getAppSettings: () => normalizeAppSettings({}),
    resolveProviderCatalog(_providerId, revision) {
      calls.catalogRevisions.push(revision);
      const provider = {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high" as const,
        models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] as const }],
      };
      return {
        snapshot: { revision: 4, providers: [provider] },
        provider: { ...provider, models: provider.models.map((model) => ({ ...model, reasoningEfforts: [...model.reasoningEfforts] })) },
      };
    },
    getProviderCodingAdapter() {
      calls.adapter += 1;
      return {} as never;
    },
  } as SessionRuntimeServiceDeps);
  return { service, calls };
}

describe("external Session turn validation", () => {
  it("EXT-CATALOG-02: current revisionとmodel/reasoning tupleをexecution登録前に検証する", async () => {
    const fixture = createService(createSession());

    await fixture.service.validateExternalSessionTurn("session-1", 4, request);

    assert.deepEqual(fixture.calls.catalogRevisions, [null]);
    assert.deepEqual(fixture.calls.composerScopes, ["session-folder"]);
    assert.equal(fixture.calls.adapter, 1);

    await assert.rejects(
      fixture.service.validateExternalSessionTurn("session-1", 4, { ...request, model: "unknown" }),
      (error) => error instanceof SessionTurnValidationError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      fixture.service.validateExternalSessionTurn("session-1", 4, { ...request, reasoningEffort: "ultra" }),
      (error) => error instanceof SessionTurnValidationError && error.code === "INVALID_INPUT",
    );
  });

  it("EXT-CATALOG-02: stale catalog revisionを副作用前に拒否する", async () => {
    const fixture = createService(createSession());

    await assert.rejects(
      fixture.service.validateExternalSessionTurn("session-1", 3, request),
      (error) => error instanceof SessionTurnValidationError && error.code === "CATALOG_REVISION_STALE",
    );
    assert.deepEqual(fixture.calls.composerScopes, []);
    assert.equal(fixture.calls.adapter, 0);
  });

  it("EXT-SCOPE-03: Character Authoring Sessionをcomposer/provider副作用前に拒否する", async () => {
    const fixture = createService(createSession({ sessionKind: "character-authoring" }));

    await assert.rejects(
      fixture.service.validateExternalSessionTurn("session-1", 4, request),
      (error) => error instanceof SessionTurnValidationError && error.code === "SESSION_KIND_UNSUPPORTED",
    );
    assert.deepEqual(fixture.calls.catalogRevisions, []);
    assert.deepEqual(fixture.calls.composerScopes, []);
    assert.equal(fixture.calls.adapter, 0);
  });
});
