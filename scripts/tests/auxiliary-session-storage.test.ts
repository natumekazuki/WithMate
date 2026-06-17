import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import type { CompanionSession } from "../../src/companion-state.js";
import { companionSessionToAuxiliaryParentSession } from "../../src-electron/auxiliary-parent-session.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary-session-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary-session-storage.js";
import { CompanionStorage } from "../../src-electron/companion-storage.js";
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
      {
        id: "copilot",
        label: "Copilot",
        defaultModelId: "claude-sonnet-4.5",
        defaultReasoningEffort: "medium",
        models: [
          { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", reasoningEfforts: ["medium"] },
        ],
      },
    ],
  };
}

function buildCompanionSession(overrides: Partial<CompanionSession> = {}): CompanionSession {
  return {
    id: "companion-session-1",
    groupId: "group-1",
    taskTitle: "companion review",
    status: "active",
    repoRoot: "C:/workspace/WithMate",
    focusPath: "",
    targetBranch: "master",
    baseSnapshotRef: "master",
    baseSnapshotCommit: "abc123",
    companionBranch: "companion/test",
    worktreePath: "C:/workspace/WithMate-companion",
    selectedPaths: [],
    changedFiles: [],
    siblingWarnings: [],
    allowedAdditionalDirectories: ["C:/review-context"],
    runState: "idle",
    threadId: "companion-thread",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
    customAgentName: "reviewer",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write-network",
    characterId: "companion",
    character: "Companion",
    characterRoleMarkdown: "",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    createdAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z",
    messages: [{ role: "user", text: "review this" }],
    ...overrides,
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
  let companionStorage: CompanionStorage | null = null;

  try {
    sessionStorage = new SessionStorage(dbPath);
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    companionStorage = new CompanionStorage(dbPath);
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
      getParentSession: (parentSessionId) => sessionStorage?.getSession(parentSessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => activeModelCatalog,
    });

    const auxiliary = await service.createAuxiliarySession({ parentSessionId: parent.id, provider: parent.provider });
    assert.equal(auxiliary.parentSessionId, parent.id);
    assert.equal(auxiliary.status, "active");
    assert.equal(auxiliary.runState, "idle");
    assert.equal(auxiliary.provider, parent.provider);
    assert.equal(auxiliary.model, parent.model);
    assert.equal(auxiliary.reasoningEffort, parent.reasoningEffort);
    assert.equal(auxiliary.codexSandboxMode, "workspace-write-network");
    assert.deepEqual(auxiliary.allowedAdditionalDirectories, ["C:/shared"]);
    assert.equal(auxiliary.displayAfterMessageIndex, parent.messages.length - 1);

    const sameActive = await service.createAuxiliarySession({ parentSessionId: parent.id, provider: "copilot" });
    assert.equal(sameActive.id, auxiliary.id);

    const updated = service.updateAuxiliarySession({
      ...auxiliary,
      composerDraft: "review this diff",
      messages: [{ role: "assistant", text: "finding" }],
    });
    assert.equal(service.getActiveAuxiliarySession(parent.id)?.composerDraft, "review this diff");
    assert.equal(service.listAuxiliarySessions(parent.id)[0]?.id, updated.id);

    const movedDisplayAnchor = service.updateAuxiliarySession({
      ...updated,
      displayAfterMessageIndex: 3,
    });
    assert.equal(movedDisplayAnchor.displayAfterMessageIndex, 3);
    const staleDraftWithOldDisplayAnchor = service.updateAuxiliarySession({
      ...updated,
      composerDraft: "stale draft with old anchor",
    });
    assert.equal(staleDraftWithOldDisplayAnchor.displayAfterMessageIndex, 3);

    const runtimeSession = await service.getAuxiliaryRuntimeSession(movedDisplayAnchor.id);
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
    const orphanedAuxiliary = await service.createAuxiliarySession({
      parentSessionId: orphanedParent.id,
      provider: orphanedParent.provider,
    });
    assert.equal(service.listAuxiliarySessions(orphanedParent.id)[0]?.id, orphanedAuxiliary.id);
    const activeCompanion = buildCompanionSession({
      id: "companion-active-parent",
      groupId: "companion-group",
    });
    const mergedCompanion = buildCompanionSession({
      id: "companion-merged-parent",
      groupId: activeCompanion.groupId,
      status: "merged",
    });
    const discardedCompanion = buildCompanionSession({
      id: "companion-discarded-parent",
      groupId: activeCompanion.groupId,
      status: "discarded",
    });
    const recoveryRequiredCompanion = buildCompanionSession({
      id: "companion-recovery-parent",
      groupId: activeCompanion.groupId,
      status: "recovery-required",
    });
    const unknownStatusCompanion = buildCompanionSession({
      id: "companion-unknown-parent",
      groupId: activeCompanion.groupId,
      status: "unknown-status" as CompanionSession["status"],
    });
    companionStorage.ensureGroup({
      id: activeCompanion.groupId,
      repoRoot: activeCompanion.repoRoot,
      displayName: "Companion Group",
      createdAt: activeCompanion.createdAt,
      updatedAt: activeCompanion.updatedAt,
    });
    companionStorage.createSession(activeCompanion);
    companionStorage.createSession(recoveryRequiredCompanion);
    companionStorage.createSession(mergedCompanion);
    companionStorage.createSession(discardedCompanion);
    companionStorage.createSession(unknownStatusCompanion);
    auxiliaryStorage.upsertAuxiliarySession({
      ...orphanedAuxiliary,
      id: "aux-companion-parent",
      parentSessionId: activeCompanion.id,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });
    auxiliaryStorage.upsertAuxiliarySession({
      ...orphanedAuxiliary,
      id: "aux-recovery-companion-parent",
      parentSessionId: recoveryRequiredCompanion.id,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });
    auxiliaryStorage.upsertAuxiliarySession({
      ...orphanedAuxiliary,
      id: "aux-merged-companion-parent",
      parentSessionId: mergedCompanion.id,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });
    auxiliaryStorage.upsertAuxiliarySession({
      ...orphanedAuxiliary,
      id: "aux-discarded-companion-parent",
      parentSessionId: discardedCompanion.id,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });
    auxiliaryStorage.upsertAuxiliarySession({
      ...orphanedAuxiliary,
      id: "aux-unknown-status-companion-parent",
      parentSessionId: unknownStatusCompanion.id,
      createdAt: "2026-05-25T00:00:00.000Z",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });

    sessionStorage.replaceSessions([{ ...parent, taskTitle: "retained main task" }]);
    assert.equal(service.listAuxiliarySessions(parent.id).length, 1);
    assert.deepEqual(service.listAuxiliarySessions(orphanedParent.id), []);
    assert.equal(service.listAuxiliarySessions(activeCompanion.id)[0]?.id, "aux-companion-parent");
    assert.equal(service.listAuxiliarySessions(recoveryRequiredCompanion.id)[0]?.id, "aux-recovery-companion-parent");
    assert.deepEqual(service.listAuxiliarySessions(mergedCompanion.id), []);
    assert.deepEqual(service.listAuxiliarySessions(discardedCompanion.id), []);
    assert.equal(service.listAuxiliarySessions(unknownStatusCompanion.id)[0]?.id, "aux-unknown-status-companion-parent");

    sessionStorage.deleteSession(parent.id);
    assert.deepEqual(service.listAuxiliarySessions(parent.id), []);
  } finally {
    companionStorage?.close();
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

test("AuxiliarySessionService は通常起動と同じ選択済み model context で active session を作成する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-model-selection-"));
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
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high" as const,
      customAgentName: "parent-agent",
    };
    sessionStorage.upsertSession(parent);
    const activeModelCatalog = buildTestModelCatalogSnapshot(parent.catalogRevision);

    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) => sessionStorage?.getSession(parentSessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => activeModelCatalog,
    });

    const auxiliary = await service.createAuxiliarySession({
      parentSessionId: parent.id,
      provider: parent.provider,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      customAgentName: "last-used-agent",
    });

    assert.equal(auxiliary.provider, parent.provider);
    assert.equal(auxiliary.model, "gpt-5.4-mini");
    assert.equal(auxiliary.reasoningEffort, "medium");
    assert.equal(auxiliary.customAgentName, "last-used-agent");
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

test("AuxiliarySessionService は指定 Provider の既定 model で active session を作成する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-provider-"));
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
      provider: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high" as const,
    };
    sessionStorage.upsertSession(parent);
    const activeModelCatalog = buildTestModelCatalogSnapshot(parent.catalogRevision);

    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) => sessionStorage?.getSession(parentSessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => activeModelCatalog,
    });

    const auxiliary = await service.createAuxiliarySession({
      parentSessionId: parent.id,
      provider: "copilot",
    });

    assert.equal(auxiliary.parentSessionId, parent.id);
    assert.equal(auxiliary.provider, "copilot");
    assert.equal(auxiliary.catalogRevision, activeModelCatalog.revision);
    assert.equal(auxiliary.model, "claude-sonnet-4.5");
    assert.equal(auxiliary.reasoningEffort, "medium");
    assert.equal(auxiliary.approvalMode, parent.approvalMode);
    assert.equal(auxiliary.displayAfterMessageIndex, parent.messages.length - 1);
  } finally {
    auxiliaryStorage?.close();
    sessionStorage?.close();
    await removeDirectoryWithRetry(tempDirectory);
  }
});

test("AuxiliarySessionService は Companion 由来の parent runtime session から実行 context を継承する", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-companion-parent-"));
  const dbPath = path.join(tempDirectory, "withmate.db");
  let auxiliaryStorage: AuxiliarySessionStorage | null = null;

  try {
    auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
    const companion = buildCompanionSession();
    const activeModelCatalog = buildTestModelCatalogSnapshot(companion.catalogRevision);
    const service = new AuxiliarySessionService({
      getParentSession: (parentSessionId) =>
        parentSessionId === companion.id
          ? companionSessionToAuxiliaryParentSession(companion)
          : null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => activeModelCatalog,
    });

    const auxiliary = await service.createAuxiliarySession({
      parentSessionId: companion.id,
      provider: companion.provider,
    });

    assert.equal(auxiliary.parentSessionId, companion.id);
    assert.equal(auxiliary.approvalMode, companion.approvalMode);
    assert.equal(auxiliary.codexSandboxMode, companion.codexSandboxMode);
    assert.deepEqual(auxiliary.allowedAdditionalDirectories, ["C:/review-context"]);
    assert.equal(auxiliary.displayAfterMessageIndex, companion.messages.length - 1);

    const runtimeSession = await service.getAuxiliaryRuntimeSession(auxiliary.id);
    assert.ok(runtimeSession);
    assert.equal(runtimeSession.workspacePath, companion.worktreePath);
    assert.equal(runtimeSession.branch, companion.companionBranch);
    assert.equal(runtimeSession.threadId, "");
    assert.deepEqual(runtimeSession.messages, []);
    assert.ok(companionSessionToAuxiliaryParentSession({ ...companion, status: "recovery-required" }));
    assert.equal(companionSessionToAuxiliaryParentSession({ ...companion, status: "merged" }), null);
    assert.equal(companionSessionToAuxiliaryParentSession({ ...companion, status: "discarded" }), null);
    assert.equal(
      companionSessionToAuxiliaryParentSession({ ...companion, status: "unknown-status" as typeof companion.status }),
      null,
    );
  } finally {
    auxiliaryStorage?.close();
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
      getParentSession: (parentSessionId) => sessionStorage?.getSession(parentSessionId) ?? null,
      getStorage: () => auxiliaryStorage!,
      getModelCatalogSnapshot: () => buildTestModelCatalogSnapshot(parent.catalogRevision),
    });
    const auxiliary = await service.createAuxiliarySession({ parentSessionId: parent.id, provider: parent.provider });
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
