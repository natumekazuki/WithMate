import assert from "node:assert/strict";
import test from "node:test";

import type { MateGrowthApplyResult } from "../../src/mate-growth-apply-result.js";
import { createMainIpcRegistrationDeps } from "../../src-electron/main-ipc-deps.js";

const zeroGrowthResult: MateGrowthApplyResult = {
  candidateCount: 0,
  appliedCount: 0,
  skippedCount: 0,
  revisionId: null,
};

test("createMainIpcRegistrationDeps は window open 系の戻り値を void 化して delegate する", async () => {
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
      async openMemoryManagementWindow() {
        calls.push("openMemory");
        return {} as never;
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
      listProviderInstructionTargets: () => [],
      upsertProviderInstructionTarget: (input) => input as never,
      async resetAppDatabase() {
        return null;
      },
      getMemoryManagementSnapshot: () => ({ sessionMemories: [], projectMemories: [], characterMemories: [] }),
      getMemoryManagementPage: () => ({
        snapshot: { sessionMemories: [], projectMemories: [], characterMemories: [] },
        pages: {
          session: { nextCursor: null, hasMore: false, total: 0 },
          project: { nextCursor: null, hasMore: false, total: 0 },
          character: { nextCursor: null, hasMore: false, total: 0 },
          mate_profile: { nextCursor: null, hasMore: false, total: 0 },
        },
      }),
      getMateGrowthSettings: () => null,
      updateMateGrowthSettings: () => null,
      getMateEmbeddingSettings: () => null,
      startMateEmbeddingDownload: () => {
        calls.push("startMateEmbeddingDownload");
      },
      deleteSessionMemory: () => {},
      deleteProjectMemoryEntry: () => {},
      deleteCharacterMemoryEntry: () => {},
      forgetMateProfileItem: () => {},
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
      async getCharacterUpdateWorkspace() {
        return null;
      },
      async extractCharacterUpdateMemory() {
        return { characterId: "char-1", generatedAt: "", entryCount: 0, text: "" };
      },
      async createCharacterUpdateSession() {
        return {} as never;
      },
      async createCharacter() {
        return {} as never;
      },
      async updateCharacter() {
        return {} as never;
      },
      async deleteCharacter() {},
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
      async applyPendingGrowth() {
        calls.push("applyPendingGrowth");
        return zeroGrowthResult;
      },
      async runMateTalkTurn(input) {
        calls.push(`runMateTalk:${input.message}`);
        return {
          mateId: "mate-1",
          userMessage: input.message,
          assistantMessage: "受け取ったよ。",
          createdAt: "2026-05-04T00:00:00.000Z",
        };
      },
      async resetMate() {
        calls.push("resetMate");
      },
    },
  });

  assert.equal(await deps.openHomeWindow(), undefined);
  assert.equal(await deps.openMemoryManagementWindow(), undefined);
  assert.equal(await deps.openSessionWindow("session-1"), undefined);
  await deps.getMateState();
  await deps.getMateProfile();
  await deps.createMate({ displayName: "Buddy" });
  await deps.applyPendingGrowth();
  await deps.runMateTalkTurn({ message: "hello" });
  await deps.resetMate();
  deps.startMateEmbeddingDownload();
  assert.deepEqual(calls, [
    "openHome",
    "openMemory",
    "openSession:session-1",
    "getMateState",
    "getMateProfile",
    "createMate:Buddy",
    "applyPendingGrowth",
    "runMateTalk:hello",
    "resetMate",
    "startMateEmbeddingDownload",
  ]);
});
