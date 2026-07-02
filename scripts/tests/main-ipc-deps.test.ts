import assert from "node:assert/strict";
import test from "node:test";

import { createMainIpcRegistrationDeps } from "../../src-electron/main-ipc-deps.js";

test("createMainIpcRegistrationDeps は残存する window / mate delegate を組み立てる", async () => {
  const calls: string[] = [];

  const deps = createMainIpcRegistrationDeps({
    window: {
      resolveEventWindow: () => null,
      resolveHomeWindow: () => null,
      async openSessionWindow(sessionId) {
        calls.push(`openSession:${sessionId}`);
        return {} as never;
      },
      async openHomeWindow() {
        calls.push("openHome");
        return {} as never;
      },
      async openSessionMonitorWindow() {
        return {} as never;
      },
      async openSettingsWindow() {
        return {} as never;
      },
      async openMemoryV6ReviewWindow() {
        calls.push("openMemoryReview");
        return {} as never;
      },
      isSettingsWindow() {
        calls.push("isSettings");
        return true;
      },
      isMemoryV6ReviewWindow() {
        calls.push("isMemoryReview");
        return true;
      },
      async openCharacterEditorWindow() {
        return {} as never;
      },
      async openDiffWindow() {
        return {} as never;
      },
      async openCompanionReviewWindow() {
        return {} as never;
      },
      async openCompanionMergeWindow() {
        return {} as never;
      },
      async pickDirectory() {
        return null;
      },
      async pickFile() {
        return null;
      },
      async pickFiles() {
        return [];
      },
      async pickSessionFiles() {
        return [];
      },
      async pickSessionFolder() {
        return null;
      },
      async pickSessionImageFile() {
        return null;
      },
      async pickImageFile() {
        return null;
      },
      async openPathTarget() {},
      async openAppLogFolder() {},
      async openCrashDumpFolder() {},
      async openSessionTerminal() {},
      async openTerminalAtPath() {},
    },
    catalog: {
      getModelCatalog: () => null,
      importModelCatalogDocument: () => ({ revision: 1, providers: [] }),
      async importModelCatalogFromFile() {
        return null;
      },
      exportModelCatalogDocument: () => null,
      async exportModelCatalogToFile() {
        return null;
      },
    },
    settings: {
      getAppSettings: () =>
        ({ providers: {}, codingProviderSettings: {}, memoryExtractionProviderSettings: {}, characterReflectionProviderSettings: {} }) as never,
      updateAppSettings: (settings) => settings,
      getAppDatabaseDiagnostics: () => ({}) as never,
      getMemoryV6Diagnostics: () => ({}) as never,
      installMemoryV6CliShim: () => ({}) as never,
      uninstallMemoryV6CliShim: () => ({}) as never,
      searchMemoryV6Entries: () => ({ items: [] }),
      getMemoryV6Entry: () => null,
      forgetMemoryV6Entry: (entryId) => ({ entryId, status: "not_found", reason: "user_request" }),
      async resetAppDatabase() {
        return null;
      },
    },
    sessionQuery: {
      listSessionSummaries: () => [],
      listCompanionSessionSummaries: () => [],
      listSessionAuditLogs: () => [],
      listSessionAuditLogSummaries: () => [],
      listSessionAuditLogSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false, total: 0 }),
      getSessionAuditLogDetail: () => null,
      getSessionAuditLogDetailSection: () => null,
      getSessionAuditLogOperationDetail: () => null,
      listCompanionAuditLogs: () => [],
      listCompanionAuditLogSummaries: () => [],
      listCompanionAuditLogSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false, total: 0 }),
      getCompanionAuditLogDetail: () => null,
      getCompanionAuditLogDetailSection: () => null,
      getCompanionAuditLogOperationDetail: () => null,
      async listSessionSkills() { return []; },
      async listSessionCustomAgents() { return []; },
      async listWorkspaceSkills() { return []; },
      async listWorkspaceCustomAgents() { return []; },
      listOpenSessionWindowIds: () => [],
      listOpenCompanionReviewWindowIds: () => [],
      getSession: () => null,
      getSessionMessageArtifact: () => null,
      getDiffPreview: () => null,
      async previewComposerInput() {
        return null;
      },
      async searchWorkspaceFiles() {
        return [];
      },
    },
    companion: {
      async createCompanionSession() {
        return {} as never;
      },
      getCompanionSession: () => null,
      getCompanionMessageArtifact: () => null,
      async getCompanionReviewSnapshot() {
        return null;
      },
      async mergeCompanionSelectedFiles() {
        return {} as never;
      },
      async syncCompanionTarget() {
        return {} as never;
      },
      async stashCompanionTargetChanges() {
        return {} as never;
      },
      async restoreCompanionTargetStash() {
        return {} as never;
      },
      async dropCompanionTargetStash() {
        return {} as never;
      },
      async discardCompanionSession() {
        return {} as never;
      },
      async updateCompanionSession(session) {
        return session;
      },
      async previewCompanionComposerInput() {
        return { attachments: [], errors: [] };
      },
      async searchCompanionWorkspaceFiles() {
        return [];
      },
      async runCompanionSessionTurn() {
        return {} as never;
      },
      cancelCompanionSessionRun: () => {},
    },
    sessionRuntime: {
      getLiveSessionRun: () => null,
      async getProviderQuotaTelemetry() {
        return null;
      },
      getSessionContextTelemetry: () => null,
      getSessionBackgroundActivity: () => null,
      resolveLiveApproval: () => {},
      resolveLiveElicitation: () => {},
      createSession: () => ({}) as never,
      updateSession: () => ({}) as never,
      deleteSession: () => {},
      async runSessionTurn() {
        return {} as never;
      },
      cancelSessionRun: () => {},
    },
    character: {
      async listCharacters() {
        return [];
      },
      async getCharacter() {
        return null;
      },
      async createCharacter() {
        return {} as never;
      },
      async updateCharacterMetadata() {
        return {} as never;
      },
      async updateCharacterDefinition() {
        return {} as never;
      },
      async archiveCharacter() {
        return {} as never;
      },
      async setDefaultCharacter() {
        return {} as never;
      },
      async resolveLaunchCharacter() {
        return null;
      },
    },
    mate: {
      getMateState() {
        calls.push("getMateState");
        return "not_created";
      },
      getMateProfile() {
        calls.push("getMateProfile");
        return null;
      },
      async createMate(input) {
        calls.push(`createMate:${input.displayName}`);
        return {} as never;
      },
      async updateMate(input) {
        calls.push(`updateMate:${input.displayName}`);
        return {} as never;
      },
      async setMateAvatar(input) {
        calls.push(`setMateAvatar:${input.avatarFilePath ?? "clear"}`);
        return {} as never;
      },
      async resetMate() {
        calls.push("resetMate");
      },
    },
  });

  assert.equal(await deps.openHomeWindow(), undefined);
  assert.equal(await deps.openMemoryV6ReviewWindow(), undefined);
  assert.equal(deps.isMemoryV6ReviewWindow({} as never), true);
  assert.equal(deps.isSettingsWindow({} as never), true);
  assert.equal(await deps.openSessionWindow("session-1"), undefined);
  await deps.getMateState();
  await deps.getMateProfile();
  await deps.createMate({ displayName: "Buddy" });
  await deps.updateMate({ displayName: "Buddy 2" });
  await deps.setMateAvatar({ avatarFilePath: "C:/avatar.png" });
  await deps.resetMate();
  assert.deepEqual(calls, [
    "openHome",
    "openMemoryReview",
    "isMemoryReview",
    "isSettings",
    "openSession:session-1",
    "getMateState",
    "getMateProfile",
    "createMate:Buddy",
    "updateMate:Buddy 2",
    "setMateAvatar:C:/avatar.png",
    "resetMate",
  ]);
});
