import assert from "node:assert/strict";
import test from "node:test";

import { createWithMateWindowApi } from "../../src-electron/preload-api.js";
import type {
  WithMateWindowApi,
  WithMateWindowSessionApi,
  WithMateWindowSettingsApi,
} from "../../src/withmate-window-api.js";

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
  assert.deepEqual(await api.deleteSessionsLastActiveBefore({ cutoffDate: "2026-07-01" }), {
    channel: "withmate:delete-sessions-last-active-before",
    args: [{ cutoffDate: "2026-07-01" }],
  });
  assert.deepEqual(await api.getMemoryV6Diagnostics(), {
    channel: "withmate:get-memory-v6-diagnostics",
    args: [],
  });
  assert.deepEqual(await api.installMemoryV6CliShim(), {
    channel: "withmate:install-memory-v6-cli-shim",
    args: [],
  });
  assert.deepEqual(await api.uninstallMemoryV6CliShim(), {
    channel: "withmate:uninstall-memory-v6-cli-shim",
    args: [],
  });
  assert.deepEqual(await api.openMemoryV6ReviewWindow(), {
    channel: "withmate:open-memory-v6-review-window",
    args: [],
  });
  assert.deepEqual(await api.getMemoryV6FileUsage(), {
    channel: "withmate:get-memory-v6-file-usage",
    args: [],
  });
  assert.deepEqual(await api.exportMemoryV6EntryFiles("mem-1"), {
    channel: "withmate:export-memory-v6-entry-files",
    args: ["mem-1"],
  });
  assert.deepEqual(await api.runMemoryV6ProtectedObjectGc({ dryRun: true }), {
    channel: "withmate:run-memory-v6-protected-object-gc",
    args: [{ dryRun: true }],
  });
  assert.deepEqual(await api.searchMemoryV6Entries({ query: "release" }), {
    channel: "withmate:search-memory-v6-entries",
    args: [{ query: "release" }],
  });
  assert.deepEqual(await api.getMemoryV6Entry("mem-1"), {
    channel: "withmate:get-memory-v6-entry",
    args: ["mem-1"],
  });
  assert.deepEqual(await api.forgetMemoryV6Entry("mem-1", "incorrect"), {
    channel: "withmate:forget-memory-v6-entry",
    args: ["mem-1", "incorrect"],
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
  assert.equal("setDefaultCharacter" in api, false);
  assert.deepEqual(await api.resolveLaunchCharacter({ characterId: "char-1" }), {
    channel: "withmate:resolve-launch-character",
    args: [{ characterId: "char-1" }],
  });
  assert.deepEqual(await api.startCharacterAuthoringSession({
    mode: "improve",
    characterId: "char-1",
    provider: "codex",
  }), {
    channel: "withmate:start-character-authoring-session",
    args: [{ mode: "improve", characterId: "char-1", provider: "codex" }],
  });
  assert.deepEqual(await api.getSessionBackgroundActivity("session-1", "memory-generation"), {
    channel: "withmate:get-session-background-activity",
    args: ["session-1", "memory-generation"],
  });
  assert.deepEqual(await api.listSessionSummaryPage({ scope: "recent", limit: 25 }), {
    channel: "withmate:list-session-summary-page",
    args: [{ scope: "recent", limit: 25 }],
  });
  assert.deepEqual(await api.listRelatedSessionSummaries(["session-1", "session-2"]), {
    channel: "withmate:list-related-session-summaries",
    args: [["session-1", "session-2"]],
  });
  assert.deepEqual(await api.listSessionCharacterUsage(), {
    channel: "withmate:list-session-character-usage",
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
  assert.deepEqual(await api.validateWorkspaceDirectory("C:/workspace"), {
    channel: "withmate:validate-workspace-directory",
    args: ["C:/workspace"],
  });
  assert.deepEqual(await api.validateSessionWorkspace("session-1"), {
    channel: "withmate:validate-session-workspace",
    args: ["session-1"],
  });
  assert.deepEqual(await api.pickSessionFiles("session-1"), {
    channel: "withmate:pick-session-files",
    args: ["session-1"],
  });
  assert.deepEqual(await api.pickSessionFolder("session-1"), {
    channel: "withmate:pick-session-folder",
    args: ["session-1"],
  });
  assert.deepEqual(await api.pickSessionImageFile("session-1"), {
    channel: "withmate:pick-session-image-file",
    args: ["session-1"],
  });
  assert.deepEqual(await api.pickImageFile("C:/icons/current.webp", "character-icon"), {
    channel: "withmate:pick-image-file",
    args: ["C:/icons/current.webp", "character-icon"],
  });
  assert.deepEqual(await api.pickImageFile(), {
    channel: "withmate:pick-image-file",
    args: [null, "general"],
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
  const fileRequest = { sessionId: "session-1", rootId: "workspace", relativePath: "src/App.tsx" };
  assert.deepEqual(await api.listSessionFileRoots("session-1"), {
    channel: "withmate:list-session-file-roots",
    args: ["session-1"],
  });
  assert.deepEqual(await api.listSessionDirectory({ ...fileRequest, relativePath: "src" }), {
    channel: "withmate:list-session-directory",
    args: [{ ...fileRequest, relativePath: "src" }],
  });
  assert.deepEqual(await api.inspectSessionFile(fileRequest), {
    channel: "withmate:inspect-session-file",
    args: [fileRequest],
  });
  assert.deepEqual(await api.readSessionFileChunk({
    ...fileRequest,
    offset: 0,
    length: 1024,
    expectedRevision: "10:20",
  }), {
    channel: "withmate:read-session-file-chunk",
    args: [{ ...fileRequest, offset: 0, length: 1024, expectedRevision: "10:20" }],
  });
  assert.deepEqual(await api.openSessionFile({ ...fileRequest, reveal: true }), {
    channel: "withmate:open-session-file",
    args: [{ ...fileRequest, reveal: true }],
  });
  const filePreviewRequest = {
    kind: "resource" as const,
    resource: fileRequest,
    view: { kind: "diff" as const, scope: "working-tree" as const },
  };
  assert.deepEqual(await api.openSessionFilePreviewWindow(filePreviewRequest), {
    channel: "withmate:open-session-file-preview-window",
    args: [filePreviewRequest],
  });
  const imageActionRequest = { sessionId: "session-1", point: { x: 120, y: 240 } };
  assert.deepEqual(await api.copySessionFilePreviewImage(imageActionRequest), {
    channel: "withmate:copy-session-file-preview-image",
    args: [imageActionRequest],
  });
  assert.deepEqual(await api.showSessionFilePreviewImageContextMenu(imageActionRequest), {
    channel: "withmate:show-session-file-preview-image-context-menu",
    args: [imageActionRequest],
  });
  const markdownLinkRequest = {
    target: "docs/review-brief%20final.md",
    point: { x: 80, y: 160 },
  };
  assert.deepEqual(await api.showMarkdownLinkContextMenu(markdownLinkRequest), {
    channel: "withmate:show-markdown-link-context-menu",
    args: [markdownLinkRequest],
  });
  assert.deepEqual(await api.listFileRootChanges({ sessionId: "session-1", rootId: "workspace" }), {
    channel: "withmate:list-file-root-changes",
    args: [{ sessionId: "session-1", rootId: "workspace" }],
  });
  assert.deepEqual(await api.getFileRootDiff({
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "src/App.tsx",
    scope: "working-tree",
  }), {
    channel: "withmate:get-file-root-diff",
    args: [{ sessionId: "session-1", rootId: "workspace", relativePath: "src/App.tsx", scope: "working-tree" }],
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
  assert.deepEqual(await api.updateChatLayoutPreference({ target: "sidePane", value: "files" }), {
    channel: "withmate:update-chat-layout-preference",
    args: [{ target: "sidePane", value: "files" }],
  });
  assert.deepEqual(await api.listPromptTemplates(), {
    channel: "withmate:list-prompt-templates",
    args: [],
  });
  assert.deepEqual(await api.createPromptTemplate({ name: "Review", prompt: "review it" }), {
    channel: "withmate:create-prompt-template",
    args: [{ name: "Review", prompt: "review it" }],
  });
  assert.deepEqual(await api.updatePromptTemplate({ id: "template-1", name: "Review", prompt: "review it" }), {
    channel: "withmate:update-prompt-template",
    args: [{ id: "template-1", name: "Review", prompt: "review it" }],
  });
  assert.deepEqual(await api.deletePromptTemplate("template-1"), {
    channel: "withmate:delete-prompt-template",
    args: ["template-1"],
  });
});

test("createWithMateWindowApi は current public API の key を揃えて expose する", () => {
  const { ipcRenderer } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);

  const keys = Object.keys(api).sort();
  const expectedKeys = [
    "cancelCompanionSessionRun",
    "cancelAuxiliarySessionRun",
    "cancelSessionExecution",
    "cancelCoordinationEvent",
    "cancelSessionRun",
    "closeAuxiliarySession",
    "copyFilesToSessionFiles",
    "copySessionFilePreviewImage",
    "archiveCharacter",
    "createMate",
    "createAuxiliarySession",
    "createCharacter",
    "createCompanionSession",
    "createPromptTemplate",
    "createSession",
    "createSessionSchedule",
    "deleteSession",
    "deleteSessionSchedule",
    "deletePromptTemplate",
    "deleteSessionsLastActiveBefore",
    "discardCompanionSession",
    "dropCompanionTargetStash",
    "enqueueSessionTurn",
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
    "getCoordinationEvent",
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
    "getMemoryV6Diagnostics",
    "getSessionIntegrationDiagnostics",
    "getMemoryV6Entry",
    "exportMemoryV6EntryFiles",
    "getMemoryV6FileUsage",
    "runMemoryV6ProtectedObjectGc",
    "getSessionBackgroundActivity",
    "getSessionContextTelemetry",
    "getSessionMessageArtifact",
    "getSessionSchedule",
    "getFileRootDiff",
    "importModelCatalog",
    "importModelCatalogFile",
    "installMemoryV6CliShim",
    "registerCodexSessionMcp",
    "listAuxiliarySessions",
    "listCharacters",
    "listCompanionAuditLogSummaries",
    "listCompanionAuditLogSummaryPage",
    "listCompanionAuditLogs",
    "listCompanionSessionSummaries",
    "listCoordinationEvents",
    "listOpenActiveAuxiliarySessionSummaries",
    "listOpenCompanionReviewWindowIds",
    "listOpenSessionWindowIds",
    "listPromptTemplates",
    "listSessionTurnExecutions",
    "listSessionAuditLogSummaryPage",
    "listSessionAuditLogSummaries",
    "listSessionAuditLogs",
    "listSessionCustomAgents",
    "listSessionSkills",
    "listSessionCharacterUsage",
    "listRelatedSessionSummaries",
    "listSessionSummaryPage",
    "listFileRootChanges",
    "listWorkspaceCustomAgents",
    "listWorkspaceSkills",
    "mergeCompanionSelectedFiles",
    "openCompanionMergeWindow",
    "openCompanionReviewWindow",
    "openCoordinationWindow",
    "openCharacterEditorWindow",
    "openDiffWindow",
    "openSessionFilePreviewWindow",
    "openHomeWindow",
    "openAppLogFolder",
    "openCrashDumpFolder",
    "openPath",
    "openSession",
    "openSessionFile",
    "getSessionFilePreviewWindowPayload",
    "openSessionFilesDirectory",
    "openSessionFilesTerminal",
    "openSessionMonitorWindow",
    "openSessionTerminal",
    "openSettingsWindow",
    "openMemoryV6ReviewWindow",
    "openTerminalAtPath",
    "pauseSessionSchedule",
    "validateSessionWorkspace",
    "validateWorkspaceDirectory",
    "pickDirectory",
    "pickFile",
    "pickFiles",
    "pickSessionFiles",
    "pickSessionFolder",
    "pickSessionImageFile",
    "pickImageFile",
    "resetMate",
    "previewCompanionComposerInput",
    "previewComposerInput",
    "inspectSessionFile",
    "listSessionDirectory",
    "listSessionFileRoots",
    "listSessionSchedules",
    "readSessionFileChunk",
    "reportRendererLog",
    "resetAppDatabase",
    "restoreCompanionTargetStash",
    "resumeSessionSchedule",
    "resolveLiveApproval",
    "resolveLiveElicitation",
    "resolveCoordinationEvent",
    "resolveLaunchCharacter",
    "runAuxiliarySessionTurn",
    "runCompanionSessionTurn",
    "runSessionScheduleNow",
    "runSessionTurn",
    "savePastedSessionFile",
    "searchMemoryV6Entries",
    "setMateAvatar",
    "setSessionPinned",
    "showSessionFilePreviewImageContextMenu",
    "showMarkdownLinkContextMenu",
    "startCharacterAuthoringSession",
    "stashCompanionTargetChanges",
    "subscribeAppSettings",
    "subscribeAppBootStatus",
    "subscribeCompanionSessionSummaries",
    "subscribeCoordinationEventsChanged",
    "subscribeLiveSessionRun",
    "subscribeModelCatalog",
    "subscribeOpenCompanionReviewWindowIds",
    "subscribeOpenSessionWindowIds",
    "subscribePromptTemplates",
    "subscribeProviderQuotaTelemetry",
    "subscribeSessionExecutionsChanged",
    "subscribeSessionFilePreviewNavigation",
    "subscribeSessionInvalidation",
    "subscribeSessionSchedules",
    "subscribeSessionBackgroundActivity",
    "subscribeSessionContextTelemetry",
    "syncCompanionTarget",
    "forgetMemoryV6Entry",
    "uninstallMemoryV6CliShim",
    "updateAppSettings",
    "updateChatLayoutPreference",
    "updateAuxiliarySession",
    "updateCharacterDefinition",
    "updateCharacterMetadata",
    "updateCompanionSession",
    "updateMate",
    "updatePromptTemplate",
    "updateSession",
    "updateSessionSchedule",
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

test("preload type surface は destructive storage maintenance API を Settings domain に置く", () => {
  const settingsKeys = [
    "resetAppDatabase",
    "deleteSessionsLastActiveBefore",
  ] satisfies Array<keyof WithMateWindowSettingsApi>;
  const sessionKeys = [
    "createSession",
    "deleteSession",
    "listSessionCharacterUsage",
    "listRelatedSessionSummaries",
    "listSessionSummaryPage",
  ] satisfies Array<keyof WithMateWindowSessionApi>;

  assert.equal(settingsKeys.includes("deleteSessionsLastActiveBefore"), true);
  assert.equal((sessionKeys as string[]).includes("deleteSessionsLastActiveBefore"), false);
});

test("createWithMateWindowApi は subscribe 系 API で payload を unwrap する", async () => {
  const { ipcRenderer, listeners } = createIpcRendererStub();
  const api = createWithMateWindowApi(ipcRenderer as never);
  const received: unknown[] = [];

  const disposeBoot = api.subscribeAppBootStatus((status) => {
    received.push({ kind: "boot", status });
  });
  const disposeInvalidation = api.subscribeSessionInvalidation((payload) => {
    received.push({ kind: "invalidation", payload });
  });
  const disposeExecutionChanged = api.subscribeSessionExecutionsChanged((event) => {
    received.push({ kind: "executionChanged", event });
  });
  const disposePreviewNavigation = api.subscribeSessionFilePreviewNavigation((payload) => {
    received.push({ kind: "previewNavigation", payload });
  });
  const disposeLiveRun = api.subscribeLiveSessionRun((sessionId, state) => {
    received.push({ kind: "liveRun", sessionId, state });
  });
  const disposeTemplates = api.subscribePromptTemplates((templates) => {
    received.push({ kind: "templates", templates });
  });
  const disposeCoordination = api.subscribeCoordinationEventsChanged((invalidation) => {
    received.push({ kind: "coordination", invalidation });
  });

  listeners.get("withmate:app-boot-status")?.({}, { kind: "running", stage: "database", title: "DB" });
  listeners.get("withmate:sessions-invalidated")?.({}, { scope: "ids", sessionIds: ["session-1"] });
  listeners.get("withmate:session-executions-changed")?.({}, {
    kind: "state-changed",
    sessionId: "session-1",
    executionId: "execution-1",
    state: "running",
  });
  listeners.get("withmate:session-file-preview-navigation")?.({}, {
    resource: { sessionId: "session-1", rootId: "workspace", relativePath: "src/App.tsx" },
    ownerSessionId: "session-1",
    windowTitle: "App.tsx",
    view: { kind: "diff", scope: "working-tree" },
  });
  listeners.get("withmate:live-session-run")?.({}, { sessionId: "session-1", state: { phase: "running" } });
  listeners.get("withmate:prompt-templates-changed")?.({}, [{ id: "template-1", name: "Review" }]);
  listeners.get("withmate:coordination-events-changed")?.({}, {
    eventId: "coordination-1",
    revision: 2,
  });
  disposeBoot();
  disposeInvalidation();
  disposeExecutionChanged();
  disposePreviewNavigation();
  disposeLiveRun();
  disposeTemplates();
  disposeCoordination();

  assert.deepEqual(received, [
    { kind: "boot", status: { kind: "running", stage: "database", title: "DB" } },
    { kind: "invalidation", payload: { scope: "ids", sessionIds: ["session-1"] } },
    {
      kind: "executionChanged",
      event: { kind: "state-changed", sessionId: "session-1", executionId: "execution-1", state: "running" },
    },
    {
      kind: "previewNavigation",
      payload: {
        resource: { sessionId: "session-1", rootId: "workspace", relativePath: "src/App.tsx" },
        ownerSessionId: "session-1",
        windowTitle: "App.tsx",
        view: { kind: "diff", scope: "working-tree" },
      },
    },
    { kind: "liveRun", sessionId: "session-1", state: { phase: "running" } },
    { kind: "templates", templates: [{ id: "template-1", name: "Review" }] },
    {
      kind: "coordination",
      invalidation: { eventId: "coordination-1", revision: 2 },
    },
  ]);
  assert.equal(listeners.has("withmate:live-session-run"), false);
  assert.equal(listeners.has("withmate:sessions-invalidated"), false);
  assert.equal(listeners.has("withmate:session-executions-changed"), false);
  assert.equal(listeners.has("withmate:session-file-preview-navigation"), false);
  assert.equal(listeners.has("withmate:app-boot-status"), false);
  assert.equal(listeners.has("withmate:sessions-changed"), false);
  assert.equal(listeners.has("withmate:prompt-templates-changed"), false);
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
