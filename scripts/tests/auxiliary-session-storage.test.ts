import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary-session-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary-session-storage.js";
import { appendSessionFilesDirectoryForSessionId, resolveSessionFilesDirectory } from "../../src-electron/session-files.js";
import { SessionStorage } from "../../src-electron/session-storage.js";

function buildTestModelCatalogSnapshot(revision: number): ModelCatalogSnapshot {
  return {
    revision,
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", reasoningEfforts: ["medium"] },
        ],
      },
    ],
  };
}

async function removeDirectoryWithRetry(targetPath: string, attempts = 5): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const isBusyError = typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY";
      if (!isBusyError || index === attempts - 1) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 50 * (index + 1)));
    }
  }
}

test("AuxiliarySessionService は親 session から実行 context を継承して active session を復元する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-session-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let sessionStorage: SessionStorage | null = null;
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    sessionStorage = new SessionStorage(dbPath);
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    const parent = {
      ...buildNewSession({
        taskTitle: "main task",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
        allowedAdditionalDirectories: ["C:/shared"],
      }),
      id: "session-main",
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high" as const,
      codexSandboxMode: "workspace-write-network" as const,
    };
    sessionStorage.upsertSession(parent);
    let activeModelCatalog = buildTestModelCatalogSnapshot(parent.catalogRevision);

    const service = new AuxiliarySessionService({
      getSession: (sessionId) => sessionStorage?.getSession(sessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => activeModelCatalog,
    });

    const auxiliary = service.createAuxiliarySession(parent.id);
    assert.equal(auxiliary.parentSessionId, parent.id);
    assert.equal(auxiliary.status, "active");
    assert.equal(auxiliary.runState, "idle");
    assert.equal(auxiliary.provider, parent.provider);
    assert.equal(auxiliary.model, parent.model);
    assert.equal(auxiliary.codexSandboxMode, "workspace-write-network");
    assert.deepEqual(auxiliary.allowedAdditionalDirectories, ["C:/shared"]);
    assert.equal(auxiliary.displayAfterMessageIndex, parent.messages.length - 1);

    const sameActive = service.createAuxiliarySession(parent.id);
    assert.equal(sameActive.id, auxiliary.id);

    const updated = service.updateAuxiliarySession({
      ...auxiliary,
      composerDraft: "review this diff",
      messages: [{ role: "assistant", text: "finding" }],
    });
    assert.equal(service.getActiveAuxiliarySession(parent.id)?.composerDraft, "review this diff");
    assert.equal(service.listAuxiliarySessions(parent.id)[0]?.id, updated.id);

    const runtimeSession = service.getAuxiliaryRuntimeSession(updated.id);
    assert.ok(runtimeSession);
    const persistedRuntime = service.upsertAuxiliaryRuntimeSession({
      ...runtimeSession,
      messages: [...runtimeSession.messages, { role: "assistant", text: "done" }],
      updatedAt: "2026-05-24T00:00:00.000Z",
    });
    assert.equal(persistedRuntime.composerDraft, "");
    assert.equal(persistedRuntime.codexSandboxMode, "workspace-write-network");
    const staleDraftUpdate = service.updateAuxiliarySession({
      ...updated,
      composerDraft: "review this diff",
    });
    assert.equal(staleDraftUpdate.composerDraft, "");
    assert.equal(staleDraftUpdate.messages.length, persistedRuntime.messages.length);

    const migratedAuxiliary = auxiliaryStorage.upsertAuxiliarySession({
      ...staleDraftUpdate,
      catalogRevision: staleDraftUpdate.catalogRevision + 1,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      threadId: "",
    });
    activeModelCatalog = buildTestModelCatalogSnapshot(migratedAuxiliary.catalogRevision);
    const staleRendererSave = service.updateAuxiliarySession({
      ...staleDraftUpdate,
      catalogRevision: auxiliary.catalogRevision,
      model: auxiliary.model,
      reasoningEffort: auxiliary.reasoningEffort,
      threadId: "",
      composerDraft: "draft after catalog reset",
    });
    assert.equal(staleRendererSave.catalogRevision, migratedAuxiliary.catalogRevision);
    assert.equal(staleRendererSave.model, "gpt-5.4-mini");
    assert.equal(staleRendererSave.reasoningEffort, "medium");
    assert.equal(staleRendererSave.threadId, "");
    assert.equal(staleRendererSave.composerDraft, "draft after catalog reset");

    const sessionBeforeCredentialReset = auxiliaryStorage.upsertAuxiliarySession({
      ...staleRendererSave,
      threadId: "aux-thread-before-reset",
    });
    const sessionAfterCredentialReset = auxiliaryStorage.upsertAuxiliarySession({
      ...sessionBeforeCredentialReset,
      threadId: "",
    });
    const staleThreadRendererSave = service.updateAuxiliarySession({
      ...sessionBeforeCredentialReset,
      composerDraft: "draft after credential reset",
    });
    assert.equal(staleThreadRendererSave.catalogRevision, sessionAfterCredentialReset.catalogRevision);
    assert.equal(staleThreadRendererSave.model, sessionAfterCredentialReset.model);
    assert.equal(staleThreadRendererSave.threadId, "");
    assert.equal(staleThreadRendererSave.composerDraft, "draft after credential reset");

    const olderCatalogAuxiliary = auxiliaryStorage.upsertAuxiliarySession({
      ...staleThreadRendererSave,
      catalogRevision: 1,
      model: "gpt-5.4",
      reasoningEffort: "high",
      threadId: "",
    });
    activeModelCatalog = buildTestModelCatalogSnapshot(3);
    const draftBeforeModelChange = service.updateAuxiliarySession({
      ...olderCatalogAuxiliary,
      composerDraft: "draft saved before model change",
    });
    const explicitModelChange = service.updateAuxiliarySession({
      ...draftBeforeModelChange,
      catalogRevision: 3,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
    });
    assert.equal(explicitModelChange.catalogRevision, 3);
    assert.equal(explicitModelChange.model, "gpt-5.4-mini");
    assert.equal(explicitModelChange.reasoningEffort, "medium");
    assert.equal(explicitModelChange.composerDraft, "draft saved before model change");

    const userChangedModelWithDraft = auxiliaryStorage.upsertAuxiliarySession({
      ...explicitModelChange,
      composerDraft: "current draft with skill snippet",
    });
    const staleDraftAfterModelChange = service.updateAuxiliarySession({
      ...draftBeforeModelChange,
      catalogRevision: userChangedModelWithDraft.catalogRevision,
      composerDraft: "stale draft before model change",
    });
    assert.equal(staleDraftAfterModelChange.catalogRevision, userChangedModelWithDraft.catalogRevision);
    assert.equal(staleDraftAfterModelChange.model, userChangedModelWithDraft.model);
    assert.equal(staleDraftAfterModelChange.reasoningEffort, userChangedModelWithDraft.reasoningEffort);
    assert.equal(staleDraftAfterModelChange.composerDraft, userChangedModelWithDraft.composerDraft);

    const resetMigratedAuxiliary = auxiliaryStorage.upsertAuxiliarySession({
      ...staleDraftAfterModelChange,
      catalogRevision: 2,
      model: "gpt-5.4",
      reasoningEffort: "high",
      threadId: "",
    });
    activeModelCatalog = buildTestModelCatalogSnapshot(resetMigratedAuxiliary.catalogRevision);
    const staleSaveAfterCatalogReset = service.updateAuxiliarySession({
      ...explicitModelChange,
      catalogRevision: 5,
      model: "removed-model",
      reasoningEffort: "xhigh",
      composerDraft: "draft after catalog reset to lower revision",
    });
    assert.equal(staleSaveAfterCatalogReset.catalogRevision, resetMigratedAuxiliary.catalogRevision);
    assert.equal(staleSaveAfterCatalogReset.model, resetMigratedAuxiliary.model);
    assert.equal(staleSaveAfterCatalogReset.reasoningEffort, resetMigratedAuxiliary.reasoningEffort);
    assert.equal(staleSaveAfterCatalogReset.threadId, "");
    assert.equal(staleSaveAfterCatalogReset.composerDraft, "draft after catalog reset to lower revision");

    const userConfiguredAuxiliary = auxiliaryStorage.upsertAuxiliarySession({
      ...staleSaveAfterCatalogReset,
      approvalMode: "on-request",
      codexSandboxMode: "workspace-write-network",
      customAgentName: "reviewer",
      allowedAdditionalDirectories: ["C:/shared", "C:/review-context"],
      composerDraft: "current visible draft",
    });
    const staleDraftAfterSettingsChange = service.updateAuxiliarySession({
      ...staleSaveAfterCatalogReset,
      composerDraft: "draft saved after settings change",
    });
    assert.equal(staleDraftAfterSettingsChange.approvalMode, userConfiguredAuxiliary.approvalMode);
    assert.equal(staleDraftAfterSettingsChange.codexSandboxMode, userConfiguredAuxiliary.codexSandboxMode);
    assert.equal(staleDraftAfterSettingsChange.customAgentName, userConfiguredAuxiliary.customAgentName);
    assert.deepEqual(staleDraftAfterSettingsChange.allowedAdditionalDirectories, userConfiguredAuxiliary.allowedAdditionalDirectories);
    assert.equal(staleDraftAfterSettingsChange.composerDraft, userConfiguredAuxiliary.composerDraft);

    auxiliaryStorage.upsertAuxiliarySession({ ...staleDraftAfterSettingsChange, runState: "running" });
    assert.throws(
      () => service.closeAuxiliarySession(auxiliary.id),
      /実行中の Auxiliary Session は終了できない/,
    );
    auxiliaryStorage.upsertAuxiliarySession(staleDraftAfterSettingsChange);

    const closed = service.closeAuxiliarySession(auxiliary.id);
    assert.equal(closed.status, "closed");
    assert.equal(closed.composerDraft, "");
    assert.equal(service.getActiveAuxiliarySession(parent.id), null);
    assert.equal(service.listAuxiliarySessions(parent.id).length, 1);

    sessionStorage.replaceSessions([{ ...parent, taskTitle: "renamed main task" }]);
    assert.equal(service.listAuxiliarySessions(parent.id).length, 1);

    const orphanedParent = { ...parent, id: "session-orphaned", taskTitle: "orphaned main task" };
    sessionStorage.upsertSession(orphanedParent);
    const orphanedAuxiliary = service.createAuxiliarySession(orphanedParent.id);
    assert.equal(service.listAuxiliarySessions(orphanedParent.id)[0]?.id, orphanedAuxiliary.id);

    sessionStorage.replaceSessions([{ ...parent, taskTitle: "retained main task" }]);
    assert.equal(service.listAuxiliarySessions(parent.id).length, 1);
    assert.deepEqual(service.listAuxiliarySessions(orphanedParent.id), []);

    sessionStorage.deleteSession(parent.id);
    assert.deepEqual(service.listAuxiliarySessions(parent.id), []);
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

test("AuxiliarySessionService は起動時に running active session を復旧可能な error 状態へ戻す", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-recover-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let sessionStorage: SessionStorage | null = null;
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    sessionStorage = new SessionStorage(dbPath);
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    const parent = {
      ...buildNewSession({
        taskTitle: "main task",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "mate",
        character: "Mate",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }),
      id: "session-main",
    };
    sessionStorage.upsertSession(parent);

    const service = new AuxiliarySessionService({
      getSession: (sessionId) => sessionStorage?.getSession(sessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
    });
    const auxiliary = service.createAuxiliarySession(parent.id);
    auxiliaryStorage.upsertAuxiliarySession({
      ...auxiliary,
      runState: "running",
      messages: [{ role: "user", text: "review" }],
    });

    service.recoverInterruptedSessions();

    const recovered = service.getAuxiliarySession(auxiliary.id);
    assert.equal(recovered?.runState, "error");
    assert.equal(recovered?.status, "active");
    assert.equal(recovered?.messages.at(-1)?.role, "assistant");
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

test("Auxiliary runtime session は parent の session files directory を追加許可できる", () => {
  const session = {
    id: "aux-1",
    allowedAdditionalDirectories: ["C:/shared"],
  };
  const withParentSessionFiles = appendSessionFilesDirectoryForSessionId("C:/user-data", session, "session-main");

  assert.equal(withParentSessionFiles.id, "aux-1");
  assert.deepEqual(withParentSessionFiles.allowedAdditionalDirectories, [
    "C:/shared",
    resolveSessionFilesDirectory("C:/user-data", "session-main"),
  ]);
});
