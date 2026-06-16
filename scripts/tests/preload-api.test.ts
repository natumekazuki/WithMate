import assert from "node:assert/strict";
import test from "node:test";

import { createWithMateWindowApi } from "../../src-electron/preload-api.js";
import type { WithMateWindowApi } from "../../src/withmate-window-api.js";

type Listener = (...args: unknown[]) => void;

function createIpcRendererStub() {
  const listeners = new Map<string, Listener>();

  return {
    listeners,
    ipcRenderer: {
      invoke(channel: string, ...args: unknown[]) {
        return Promise.resolve({ channel, args });
      },
      on(channel: string, listener: Listener) {
        listeners.set(channel, listener);
      },
      removeListener(channel: string) {
        listeners.delete(channel);
      },
      send() {},
    },
  };
}

test("createWithMateWindowApi は invoke 系 API を domain ごとに束ねる", async () => {
  const { ipcRenderer } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);

  assert.deepEqual(await api.openSession("session-1"), {
    channel: "withmate:open-session",
    args: ["session-1"],
  });
  assert.deepEqual(await api.getAppBootStatus(), {
    channel: "withmate:get-app-boot-status",
    args: [],
  });
  assert.deepEqual(await api.openCharacterEditorWindow("char-1"), {
    channel: "withmate:open-character-editor-window",
    args: ["char-1"],
  });
  assert.deepEqual(await api.openCharacterEditorWindow(), {
    channel: "withmate:open-character-editor-window",
    args: [null],
  });
  assert.deepEqual(await api.resetAppDatabase({ targets: ["appSettings"] }), {
    channel: "withmate:reset-app-database",
    args: [{ targets: ["appSettings"] }],
  });
  assert.deepEqual(await api.getMateState(), {
    channel: "withmate:get-mate-state",
    args: [],
  });
  assert.deepEqual(await api.getMateProfile(), {
    channel: "withmate:get-mate-profile",
    args: [],
  });
  assert.deepEqual(await api.createMate({ displayName: "Buddy" }), {
    channel: "withmate:create-mate",
    args: [{ displayName: "Buddy" }],
  });
  assert.deepEqual(await api.updateMate({ displayName: "Buddy 2" }), {
    channel: "withmate:update-mate",
    args: [{ displayName: "Buddy 2" }],
  });
  assert.deepEqual(await api.setMateAvatar({ avatarFilePath: "C:/avatar.png" }), {
    channel: "withmate:set-mate-avatar",
    args: [{ avatarFilePath: "C:/avatar.png" }],
  });
  assert.deepEqual(await api.resetMate(), {
    channel: "withmate:reset-mate",
    args: [],
  });
  assert.deepEqual(await api.listCharacters({ includeArchived: true }), {
    channel: "withmate:list-characters",
    args: [{ includeArchived: true }],
  });
  assert.deepEqual(await api.getCharacter("char-1"), {
    channel: "withmate:get-character",
    args: ["char-1"],
  });
  assert.deepEqual(await api.createCharacter({ name: "Mia" }), {
    channel: "withmate:create-character",
    args: [{ name: "Mia" }],
  });
  assert.deepEqual(await api.updateCharacterMetadata({ characterId: "char-1", name: "Mia 2" }), {
    channel: "withmate:update-character-metadata",
    args: [{ characterId: "char-1", name: "Mia 2" }],
  });
  assert.deepEqual(await api.updateCharacterDefinition({
    characterId: "char-1",
    definitionMarkdown: "definition",
  }), {
    channel: "withmate:update-character-definition",
    args: [{
      characterId: "char-1",
      definitionMarkdown: "definition",
    }],
  });
  assert.deepEqual(await api.archiveCharacter("char-1"), {
    channel: "withmate:archive-character",
    args: ["char-1"],
  });
  assert.deepEqual(await api.setDefaultCharacter("char-1"), {
    channel: "withmate:set-default-character",
    args: ["char-1"],
  });
  assert.deepEqual(await api.resolveLaunchCharacter({ characterId: "char-1" }), {
    channel: "withmate:resolve-launch-character",
    args: [{ characterId: "char-1" }],
  });
  assert.deepEqual(await api.startCharacterAuthoringSession({ mode: "improve", characterId: "char-1", name: "Mia" }), {
    channel: "withmate:start-character-authoring-session",
    args: [{ mode: "improve", characterId: "char-1", name: "Mia" }],
  });
  assert.deepEqual(await api.getSessionBackgroundActivity("session-1", "memory-generation"), {
    channel: "withmate:get-session-background-activity",
    args: ["session-1", "memory-generation"],
  });
  assert.deepEqual(await api.listSessionSummaries(), {
    channel: "withmate:list-session-summaries",
    args: [],
  });
  assert.deepEqual(await api.listSessionAuditLogSummaryPage("session-1", { cursor: 50, limit: 25 }), {
    channel: "withmate:list-session-audit-log-summary-page",
    args: ["session-1", { cursor: 50, limit: 25 }],
  });
  assert.deepEqual(await api.syncCompanionTarget("companion-1"), {
    channel: "withmate:sync-companion-target",
    args: ["companion-1"],
  });
  assert.deepEqual(await api.copyFilesToSessionFiles("session-1", ["C:/note.txt"]), {
    channel: "withmate:copy-files-to-session-files",
    args: ["session-1", ["C:/note.txt"]],
  });
  assert.deepEqual(await api.pickFiles("C:/seed"), {
    channel: "withmate:pick-files",
    args: ["C:/seed"],
  });
  assert.deepEqual(await api.pickSessionFiles("session-1"), {
    channel: "withmate:pick-session-files",
    args: ["session-1"],
  });
  const pastedBuffer = new ArrayBuffer(3);
  assert.deepEqual(await api.savePastedSessionFile({
    sessionId: "session-1",
    fileName: "pasted.png",
    data: pastedBuffer,
  }), {
    channel: "withmate:save-pasted-session-file",
    args: [{
      sessionId: "session-1",
      fileName: "pasted.png",
      data: pastedBuffer,
    }],
  });
  assert.deepEqual(await api.openSessionFilesDirectory("companion-1"), {
    channel: "withmate:open-session-files-directory",
    args: ["companion-1"],
  });
  assert.deepEqual(await api.openSessionFilesTerminal("session-1"), {
    channel: "withmate:open-session-files-terminal",
    args: ["session-1"],
  });
  assert.deepEqual(await api.createAuxiliarySession({ parentSessionId: "session-1", provider: "copilot" }), {
    channel: "withmate:create-auxiliary-session",
    args: [{ parentSessionId: "session-1", provider: "copilot" }],
  });
  assert.deepEqual(await api.runAuxiliarySessionTurn("aux-1", { userMessage: "review" }), {
    channel: "withmate:run-auxiliary-session-turn",
    args: ["aux-1", { userMessage: "review" }],
  });
  assert.deepEqual(await api.cancelAuxiliarySessionRun("aux-1"), {
    channel: "withmate:cancel-auxiliary-session-run",
    args: ["aux-1"],
  });
});

test("createWithMateWindowApi は current public API の key を揃えて expose する", () => {
  const { ipcRenderer } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);

  const keys = Object.keys(api).sort();
  const expectedKeys = [
    "cancelCompanionSessionRun",
    "cancelAuxiliarySessionRun",
    "cancelSessionRun",
    "closeAuxiliarySession",
    "copyFilesToSessionFiles",
    "archiveCharacter",
    "createMate",
    "createAuxiliarySession",
    "createCharacter",
    "createCompanionSession",
    "createSession",
    "deleteSession",
    "discardCompanionSession",
    "dropCompanionTargetStash",
    "exportModelCatalog",
    "exportModelCatalogFile",
    "getActiveAuxiliarySession",
    "getAppDatabaseDiagnostics",
    "getAppBootStatus",
    "getAppSettings",
    "getAuxiliarySession",
    "getCharacter",
    "getCompanionAuditLogDetail",
    "getCompanionAuditLogDetailSection",
    "getCompanionAuditLogOperationDetail",
    "getCompanionMessageArtifact",
    "getCompanionReviewSnapshot",
    "getCompanionSession",
    "getDiffPreview",
    "getLiveSessionRun",
    "getModelCatalog",
    "getProviderQuotaTelemetry",
    "getSession",
    "getSessionAuditLogDetail",
    "getSessionAuditLogDetailSection",
    "getSessionAuditLogOperationDetail",
    "getMateProfile",
    "getMateState",
    "getSessionBackgroundActivity",
    "getSessionContextTelemetry",
    "getSessionMessageArtifact",
    "importModelCatalog",
    "importModelCatalogFile",
    "listAuxiliarySessions",
    "listCharacters",
    "listCompanionAuditLogSummaries",
    "listCompanionAuditLogSummaryPage",
    "listCompanionAuditLogs",
    "listCompanionSessionSummaries",
    "listOpenCompanionReviewWindowIds",
    "listOpenSessionWindowIds",
    "listSessionAuditLogSummaryPage",
    "listSessionAuditLogSummaries",
    "listSessionAuditLogs",
    "listSessionCustomAgents",
    "listSessionSkills",
    "listSessionSummaries",
    "listWorkspaceCustomAgents",
    "listWorkspaceSkills",
    "mergeCompanionSelectedFiles",
    "openCompanionMergeWindow",
    "openCompanionReviewWindow",
    "openCharacterEditorWindow",
    "openDiffWindow",
    "openHomeWindow",
    "openAppLogFolder",
    "openCrashDumpFolder",
    "openPath",
    "openSession",
    "openSessionFilesDirectory",
    "openSessionFilesTerminal",
    "openSessionMonitorWindow",
    "openSessionTerminal",
    "openSettingsWindow",
    "openTerminalAtPath",
    "pickDirectory",
    "pickFile",
    "pickFiles",
    "pickSessionFiles",
    "pickImageFile",
    "resetMate",
    "previewCompanionComposerInput",
    "previewComposerInput",
    "reportRendererLog",
    "resetAppDatabase",
    "restoreCompanionTargetStash",
    "resolveLiveApproval",
    "resolveLiveElicitation",
    "resolveLaunchCharacter",
    "runAuxiliarySessionTurn",
    "runCompanionSessionTurn",
    "runSessionTurn",
    "savePastedSessionFile",
    "searchCompanionWorkspaceFiles",
    "searchWorkspaceFiles",
    "setMateAvatar",
    "setDefaultCharacter",
    "startCharacterAuthoringSession",
    "stashCompanionTargetChanges",
    "subscribeAppSettings",
    "subscribeAppBootStatus",
    "subscribeCompanionSessionSummaries",
    "subscribeLiveSessionRun",
    "subscribeModelCatalog",
    "subscribeOpenCompanionReviewWindowIds",
    "subscribeOpenSessionWindowIds",
    "subscribeProviderQuotaTelemetry",
    "subscribeSessionInvalidation",
    "subscribeSessionSummaries",
    "subscribeSessionBackgroundActivity",
    "subscribeSessionContextTelemetry",
    "syncCompanionTarget",
    "updateAppSettings",
    "updateAuxiliarySession",
    "updateCharacterDefinition",
    "updateCharacterMetadata",
    "updateCompanionSession",
    "updateMate",
    "updateSession",
  ] satisfies Array<keyof WithMateWindowApi>;

  assert.deepEqual(keys, [...expectedKeys].sort());
  const removedKeys = [
    "applyPendingGrowth",
    "correctMateGrowthEvent",
    "deleteProjectMemoryEntry",
    "deleteSessionMemory",
    "disableMateGrowthEvent",
    "forgetMateGrowthEvent",
    "forgetMateProfileItem",
    "getMateEmbeddingSettings",
    "getMateGrowthSettings",
    "getMemoryManagementPage",
    "getMemoryManagementSnapshot",
    "listMateGrowthEvents",
    "listProviderInstructionTargets",
    "openMateTalkWindow",
    "openMemoryManagementWindow",
    "runMateTalkTurn",
    "startMateEmbeddingDownload",
    "updateMateGrowthSettings",
    "upsertProviderInstructionTarget",
  ];
  for (const key of removedKeys) {
    assert.equal(key in api, false);
  }
});

test("createWithMateWindowApi は subscribe 系 API で payload を unwrap する", async () => {
  const { ipcRenderer, listeners } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);
  const received: unknown[] = [];

  const disposeSummaries = api.subscribeSessionSummaries((summaries) => {
    received.push({ kind: "summaries", summaries });
  });
  const disposeBoot = api.subscribeAppBootStatus((status) => {
    received.push({ kind: "boot", status });
  });
  const disposeInvalidation = api.subscribeSessionInvalidation((sessionIds) => {
    received.push({ kind: "invalidation", sessionIds });
  });
  const disposeLiveRun = api.subscribeLiveSessionRun((sessionId, state) => {
    received.push({ kind: "liveRun", sessionId, state });
  });

  listeners.get("withmate:sessions-changed")?.({}, [{ id: "session-1", taskTitle: "task" }]);
  listeners.get("withmate:app-boot-status")?.({}, { kind: "running", stage: "database", title: "DB" });
  listeners.get("withmate:sessions-invalidated")?.({}, ["session-1"]);
  listeners.get("withmate:live-session-run")?.({}, { sessionId: "session-1", state: { phase: "running" } });
  disposeSummaries();
  disposeBoot();
  disposeInvalidation();
  disposeLiveRun();

  assert.deepEqual(received, [
    { kind: "summaries", summaries: [{ id: "session-1", taskTitle: "task" }] },
    { kind: "boot", status: { kind: "running", stage: "database", title: "DB" } },
    { kind: "invalidation", sessionIds: ["session-1"] },
    { kind: "liveRun", sessionId: "session-1", state: { phase: "running" } },
  ]);
  assert.equal(listeners.has("withmate:live-session-run"), false);
  assert.equal(listeners.has("withmate:sessions-invalidated"), false);
  assert.equal(listeners.has("withmate:app-boot-status"), false);
  assert.equal(listeners.has("withmate:sessions-changed"), false);
});

test("createWithMateWindowApi は telemetry / background activity の payload も unwrap する", () => {
  const { ipcRenderer, listeners } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);
  const quotaReceived: unknown[] = [];
  const backgroundReceived: unknown[] = [];

  const disposeQuota = api.subscribeProviderQuotaTelemetry((providerId, telemetry) => {
    quotaReceived.push({ providerId, telemetry });
  });
  const disposeBackground = api.subscribeSessionBackgroundActivity((sessionId, kind, state) => {
    backgroundReceived.push({ sessionId, kind, state });
  });

  listeners.get("withmate:provider-quota-telemetry")?.({}, {
    providerId: "copilot",
    telemetry: { provider: "copilot", snapshots: [] },
  });
  listeners.get("withmate:session-background-activity")?.({}, {
    sessionId: "session-1",
    kind: "monologue",
    state: { kind: "monologue", status: "running" },
  });
  disposeQuota();
  disposeBackground();

  assert.deepEqual(quotaReceived, [{ providerId: "copilot", telemetry: { provider: "copilot", snapshots: [] } }]);
  assert.deepEqual(backgroundReceived, [
    { sessionId: "session-1", kind: "monologue", state: { kind: "monologue", status: "running" } },
  ]);
});
