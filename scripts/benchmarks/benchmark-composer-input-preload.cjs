const { contextBridge } = require("electron");

const now = new Date().toISOString();
const countArg = process.argv.find((value) => value.startsWith("--benchmark-auxiliary-count="));
const historyArg = process.argv.find((value) => value.startsWith("--benchmark-history="));
const auxiliaryCount = Math.max(1, Number(countArg?.split("=")[1] ?? 1));
const historyLength = historyArg?.split("=")[1] === "long" ? 120 : 4;

function messageList(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `${prefix} message ${index} ${"fixture ".repeat(12)}`,
  }));
}

function session() {
  return {
    id: "benchmark-main",
    taskTitle: "Composer input benchmark",
    status: "saved",
    updatedAt: now,
    isPinned: false,
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "benchmark",
    workspacePath: "benchmark-workspace",
    branch: "benchmark",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
    characterId: "benchmark-character",
    character: "Benchmark Character",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    characterRuntimeSnapshot: null,
    runState: "idle",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "benchmark-thread",
    messages: messageList("main", historyLength),
    stream: [],
  };
}

function auxiliary(id) {
  return {
    id,
    parentSessionId: "benchmark-main",
    status: "active",
    runState: "idle",
    title: `Auxiliary ${id}`,
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: `benchmark-thread-${id}`,
    composerDraft: "",
    messages: messageList(id, historyLength),
    displayAfterMessageIndex: null,
    createdAt: now,
    updatedAt: now,
    closedAt: "",
    characterId: "benchmark-character",
    characterRuntimeSnapshot: null,
    characterIconPath: "",
    preview: "",
  };
}

const mainSession = session();
const auxiliarySessions = Array.from({ length: auxiliaryCount }, (_, index) => auxiliary(`benchmark-aux-${index + 1}`));
const counters = { updateAuxiliarySession: 0, getAuxiliarySession: 0, saveAuxiliaryDraft: 0, requestBytes: 0, responseBytes: 0 };
const draftRecords = new Map();

function resultFor(name, args) {
  if (name === "getSession") return mainSession;
  if (name === "listAuxiliarySessions") return auxiliarySessions.map(({ messages, composerDraft, characterRuntimeSnapshot, ...summary }) => summary);
  if (name === "getAuxiliarySession") {
    counters.getAuxiliarySession += 1;
    return auxiliarySessions.find((item) => item.id === args[0]) ?? null;
  }
  if (name === "updateAuxiliarySession") {
    counters.updateAuxiliarySession += 1;
    const payload = args[0];
    counters.requestBytes += JSON.stringify(payload ?? null).length;
    counters.responseBytes += JSON.stringify(payload ?? null).length;
    return payload;
  }
  if (name === "getAuxiliaryDraft") {
    const existing = draftRecords.get(args[0]);
    if (existing) return existing;
    const session = auxiliarySessions.find((item) => item.id === args[0]);
    if (!session) return null;
    return { auxiliarySessionId: session.id, parentSessionId: session.parentSessionId, incarnation: "benchmark-incarnation", durableRevision: 0, text: session.composerDraft, updatedAt: session.updatedAt };
  }
  if (name === "saveAuxiliaryDraft") {
    counters.saveAuxiliaryDraft += 1;
    const payload = args[0];
    counters.requestBytes += JSON.stringify(payload ?? null).length;
    const current = draftRecords.get(payload.auxiliarySessionId);
    const durableRevision = (current?.durableRevision ?? 0) + 1;
    const ack = { auxiliarySessionId: payload.auxiliarySessionId, incarnation: payload.incarnation, durableRevision, updatedAt: payload.updatedAt };
    draftRecords.set(payload.auxiliarySessionId, { ...payload, durableRevision });
    counters.responseBytes += JSON.stringify({ outcome: "saved", ack }).length;
    return { outcome: "saved", ack };
  }
  if (name === "getAuxiliarySessionStatus") {
    const current = auxiliarySessions.find((item) => item.id === args[0]);
    return current ? { id: current.id, parentSessionId: current.parentSessionId, status: current.status, createdAt: current.createdAt, incarnation: "benchmark-incarnation", runState: current.runState } : null;
  }
  if (name === "acknowledgeSessionDraftFlush") return undefined;
  if (name === "getAppSettings") return {
    memoryGenerationEnabled: false, launchAtLoginEnabled: false, sessionTurnNotificationEnabled: false,
    sessionTurnNotificationResponsePreviewEnabled: false, characterDefinitionEnabled: true,
    characterAffectContextEnabled: false, conversationTimingEnabled: false, toolCallPresenceEnabled: false,
    autoCollapseActionDockOnSend: false, scrollToLatestOnSend: true,
    chatLayoutPreference: { header: "visible", sidePane: "visible", actionDock: "expanded" },
    keyboardShortcuts: { overrides: {} }, memoryFileQuotaBytes: 0, glossaryProactiveCreateLimit: 0,
    mateMemoryGenerationSettings: { priorityList: [], triggerIntervalMinutes: 60 },
    codingProviderSettings: {}, memoryExtractionProviderSettings: {},
  };
  if (name === "getModelCatalog") return { revision: 1, providers: [] };
  if (name === "getSessionGlossaryProjection") return { sessionId: "benchmark-main", revision: 0, state: { status: "ready", entries: [] } };
  if (name === "previewComposerInput") return { text: args[1] ?? "", attachments: [], errors: [] };
  if (name === "listSessionAuditLogSummaryPage") return { entries: [], nextCursor: null };
  if (name.startsWith("list") || name.startsWith("search")) return [];
  if (name.startsWith("get")) return null;
  if (name.startsWith("subscribe")) return () => {};
  if (name.startsWith("validate")) return { valid: true };
  if (name.startsWith("open") || name.startsWith("report") || name.startsWith("update") || name.startsWith("set")) return name === "updateSession" ? mainSession : undefined;
  return undefined;
}

const api = {};
const names = [
  "getSession", "listAuxiliarySessions", "getAuxiliarySession", "updateAuxiliarySession", "getAppSettings", "getModelCatalog",
  "getSessionGlossaryProjection", "previewComposerInput", "subscribeSessionInvalidation", "subscribeLiveSessionRun",
  "subscribeAuxiliarySessionNavigation", "subscribeSessionGlossary", "getLiveSessionRun", "getSessionMessageArtifact",
  "listSessionSkills", "listSessionCustomAgents", "listWorkspaceSkills", "listWorkspaceCustomAgents", "validateSessionWorkspace",
  "updateSession", "runSessionTurn", "cancelSessionRun", "cancelAuxiliarySessionRun", "setSessionPinned", "deleteSession",
  "getFileRootDiff", "getFileRootGitHistoryDiff", "listFileRootChanges", "openSessionFilePreviewWindow", "openDiffWindow",
  "openPath", "openSessionTerminal", "openSessionFilesDirectory", "openSessionFilesTerminal", "pickFiles", "pickSessionFiles",
  "pickSessionFolder", "pickSessionImageFile", "copyFilesToSessionFiles", "savePastedSessionFile", "reportRendererLog",
  "resolveLiveApproval", "resolveLiveElicitation", "searchSessionGlossary", "getAppBootStatus", "getMemoryV6Diagnostics",
  "getSessionAuditLogSummaries", "getSessionAuditLogDetail", "listSessionAuditLogs", "getSessionCharacterUsage",
  "createAuxiliarySession", "cancelAuxiliaryCreation", "getAuxiliaryCreationContext", "getAuxiliaryCreation",
  "updateChatLayoutPreference",
  "subscribeOpenSessionWindowIds", "subscribeSessionWindowRestoreSet",
  "subscribeProviderQuotaTelemetry", "subscribeSessionContextTelemetry", "subscribeSessionBackgroundActivity",
  "listOpenSessionWindowIds", "getSessionWindowRestoreSet",
  "subscribeSessionDraftFlushRequest",
  "subscribeSessionDraftFlushRelease",
  "subscribeAppSettings",
  "listSessionAuditLogSummaryPage",
  "getAuxiliaryDraft", "saveAuxiliaryDraft", "getAuxiliarySessionStatus",
  "acknowledgeSessionDraftFlush",
];
for (const name of names) {
  api[name] = (...args) => name.startsWith("subscribe")
    ? resultFor(name, args)
    : name === "acknowledgeSessionDraftFlush"
      ? resultFor(name, args)
    : Promise.resolve(resultFor(name, args));
}
api.getBenchmarkTelemetry = () => ({
  auxiliaryCount,
  historyLength,
  counters: { ...counters },
});
contextBridge.exposeInMainWorld("withmate", api);
