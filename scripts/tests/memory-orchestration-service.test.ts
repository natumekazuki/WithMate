import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNewSession,
  createDefaultSessionMemory,
  type AuditLogEntry,
  type CharacterMemoryEntry,
  type CharacterProfile,
  type Session,
  type SessionBackgroundActivityState,
  type SessionMemory,
} from "../../src/app-state.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ProviderTurnAdapter } from "../../src-electron/provider-runtime.js";
import { MemoryOrchestrationService } from "../../src-electron/memory-orchestration-service.js";

function createSession(overrides?: Partial<Session>): Session {
  return {
    ...buildNewSession({
      taskTitle: "Memory Test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

function createCharacter(): CharacterProfile {
  return {
    id: "char-a",
    name: "A",
    iconPath: "",
    roleMarkdown: "落ち着いて伴走する。",
    description: "",
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createAuditLogBase(input: Omit<AuditLogEntry, "id">): AuditLogEntry {
  return {
    id: 1,
    ...input,
  };
}

function createMemoryEntry(): CharacterMemoryEntry {
  return {
    id: "entry-1",
    characterScopeId: "scope-1",
    sourceSessionId: "session-1",
    category: "relationship",
    title: "前提",
    detail: "既存の関係性",
    keywords: ["関係"],
    evidence: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null,
  };
}

describe("MemoryOrchestrationService", () => {
  it("Session Memory extraction の成功時に audit / activity / promotion を更新する", async () => {
    const session = createSession({ id: "session-memory" });
    const memory = createDefaultSessionMemory(session);
    const auditUpdates: AuditLogEntry[] = [];
    const activities: SessionBackgroundActivityState[] = [];
    const savedMemories: SessionMemory[] = [];
    const promoted: Array<{ sessionId: string; goal: string | undefined }> = [];

    const providerAdapter: ProviderTurnAdapter = {
      composePrompt() {
        throw new Error("not used");
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async extractSessionMemoryDelta() {
        return {
          threadId: "thread-memory",
          rawText: "{\"goal\":\"整理する\",\"nextActions\":[\"次をやる\"]}",
          delta: { goal: "整理する", nextActions: ["次をやる"] },
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 220 },
        };
      },
      async runCharacterReflection() {
        throw new Error("not used");
      },
      invalidateSessionThread() {},
      invalidateAllSessionThreads() {},
      async runSessionTurn() {
        throw new Error("not used");
      },
    };

    const service = new MemoryOrchestrationService({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      isSessionRunInFlight() {
        return false;
      },
      isRunningSession() {
        return false;
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      getProviderAdapter() {
        return providerAdapter;
      },
      ensureSessionMemory() {
        return memory;
      },
      upsertSessionMemory(next) {
        savedMemories.push(next);
      },
      promoteSessionMemoryDeltaToProjectMemory(nextSession, delta) {
        promoted.push({ sessionId: nextSession.id, goal: delta.goal });
      },
      resolveCharacterMemoryEntriesForReflection() {
        return [];
      },
      markCharacterMemoryEntriesUsed() {},
      saveCharacterMemoryDelta() {
        return 0;
      },
      appendMonologueToSession(nextSession) {
        return nextSession;
      },
      createAuditLog(input) {
        return createAuditLogBase(input);
      },
      updateAuditLog(_id, entry) {
        auditUpdates.push(entry);
      },
      setSessionBackgroundActivity(_sessionId, _kind, state) {
        if (state) {
          activities.push(state);
        }
      },
    });

    await service.runSessionMemoryExtraction(
      session,
      { inputTokens: 1, cachedInputTokens: 0, outputTokens: 250 },
      { triggerReason: "outputTokensThreshold" },
    );

    assert.equal(auditUpdates.at(-1)?.phase, "background-completed");
    assert.equal(savedMemories.at(-1)?.goal, "整理する");
    assert.deepEqual(savedMemories.at(-1)?.nextActions, ["次をやる"]);
    assert.deepEqual(promoted, [{ sessionId: session.id, goal: "整理する" }]);
    assert.equal(activities.at(0)?.status, "running");
    assert.equal(activities.at(-1)?.status, "completed");
  });

  it("Character reflection の session-start は monologue のみを保存する", async () => {
    const session = createSession({ id: "session-start" });
    const auditUpdates: AuditLogEntry[] = [];
    const activities: SessionBackgroundActivityState[] = [];
    const appendedMonologues: string[] = [];
    let savedCharacterCount = 0;

    const providerAdapter: ProviderTurnAdapter = {
      composePrompt() {
        throw new Error("not used");
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async extractSessionMemoryDelta() {
        throw new Error("not used");
      },
      async runCharacterReflection() {
        return {
          threadId: "thread-char",
          rawText: "{\"memoryDelta\":null,\"monologue\":{\"text\":\"今日はよろしく。\",\"mood\":\"warm\"}}",
          output: {
            memoryDelta: null,
            monologue: { text: "今日はよろしく。", mood: "warm" },
          },
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 80 },
        };
      },
      invalidateSessionThread() {},
      invalidateAllSessionThreads() {},
      async runSessionTurn() {
        throw new Error("not used");
      },
    };

    const service = new MemoryOrchestrationService({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      isSessionRunInFlight() {
        return false;
      },
      isRunningSession() {
        return false;
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      getProviderAdapter() {
        return providerAdapter;
      },
      ensureSessionMemory(current) {
        return createDefaultSessionMemory(current);
      },
      upsertSessionMemory() {},
      promoteSessionMemoryDeltaToProjectMemory() {},
      resolveCharacterMemoryEntriesForReflection() {
        return [createMemoryEntry()];
      },
      markCharacterMemoryEntriesUsed() {},
      saveCharacterMemoryDelta() {
        savedCharacterCount += 1;
        return 1;
      },
      appendMonologueToSession(nextSession, monologue) {
        appendedMonologues.push(monologue.text);
        return nextSession;
      },
      createAuditLog(input) {
        return createAuditLogBase(input);
      },
      updateAuditLog(_id, entry) {
        auditUpdates.push(entry);
      },
      setSessionBackgroundActivity(_sessionId, _kind, state) {
        if (state) {
          activities.push(state);
        }
      },
    });

    await service.runCharacterReflection(session, { triggerReason: "session-start" });

    assert.equal(auditUpdates.at(-1)?.phase, "background-completed");
    assert.deepEqual(appendedMonologues, ["今日はよろしく。"]);
    assert.equal(savedCharacterCount, 0);
    assert.equal(activities.at(-1)?.status, "completed");
  });

  it("Character reflection の context-growth は memory 保存と used mark を行う", async () => {
    const session = createSession({ id: "session-growth" });
    const usedEntryIds: string[][] = [];
    const savedCharacterMemory: Array<{ sessionId: string; count: number }> = [];

    const providerAdapter: ProviderTurnAdapter = {
      composePrompt() {
        throw new Error("not used");
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async extractSessionMemoryDelta() {
        throw new Error("not used");
      },
      async runCharacterReflection() {
        return {
          threadId: "thread-char-growth",
          rawText: "{\"memoryDelta\":{\"entries\":[{\"category\":\"relationship\",\"title\":\"距離感\",\"detail\":\"少し砕けた会話を好む\",\"keywords\":[\"距離感\"],\"evidence\":[\"会話\"]}]},\"monologue\":null}",
          output: {
            memoryDelta: {
              entries: [
                {
                  category: "relationship",
                  title: "距離感",
                  detail: "少し砕けた会話を好む",
                  keywords: ["距離感"],
                  evidence: ["会話"],
                },
              ],
            },
            monologue: null,
          },
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 120 },
        };
      },
      invalidateSessionThread() {},
      invalidateAllSessionThreads() {},
      async runSessionTurn() {
        throw new Error("not used");
      },
    };

    const service = new MemoryOrchestrationService({
      getSession(sessionId) {
        if (sessionId !== session.id) {
          return null;
        }
        return {
          ...session,
          messages: [
            ...session.messages,
            { role: "user", text: "もう少し砕けた感じで話して" },
            { role: "assistant", text: "わかった。少しくだけて話すね。" },
            { role: "user", text: "そうそう、その感じ" },
            { role: "assistant", text: "この距離感でいこう。" },
            { role: "user", text: "助かる" },
            { role: "assistant", text: "まかせて" },
          ],
        };
      },
      isSessionRunInFlight() {
        return false;
      },
      isRunningSession() {
        return false;
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      getProviderAdapter() {
        return providerAdapter;
      },
      ensureSessionMemory(current) {
        return createDefaultSessionMemory(current);
      },
      upsertSessionMemory() {},
      promoteSessionMemoryDeltaToProjectMemory() {},
      resolveCharacterMemoryEntriesForReflection() {
        return [createMemoryEntry()];
      },
      markCharacterMemoryEntriesUsed(entryIds) {
        usedEntryIds.push(entryIds);
      },
      saveCharacterMemoryDelta(nextSession, entries) {
        savedCharacterMemory.push({ sessionId: nextSession.id, count: entries.length });
        return entries.length;
      },
      appendMonologueToSession(nextSession) {
        return nextSession;
      },
      createAuditLog(input) {
        return createAuditLogBase(input);
      },
      updateAuditLog() {},
      setSessionBackgroundActivity() {},
    });

    await service.runCharacterReflection(session, { triggerReason: "context-growth" });

    assert.deepEqual(usedEntryIds, [["entry-1"]]);
    assert.deepEqual(savedCharacterMemory, [{ sessionId: session.id, count: 1 }]);
  });
});
