import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNewSession,
  createDefaultSessionMemory,
  type AuditLogEntry,
  type Session,
  type SessionBackgroundActivityState,
  type SessionMemory,
} from "../../src/app-state.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ProviderBackgroundAdapter } from "../../src-electron/provider-runtime.js";
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

function createAuditLogBase(input: Omit<AuditLogEntry, "id">): AuditLogEntry {
  return {
    id: 1,
    ...input,
  };
}

describe("MemoryOrchestrationService", () => {
  it("memory generation が OFF の時は Session Memory extraction が走らない", async () => {
    const session = createSession({ id: "memory-disabled" });
    let extractionCalled = 0;
    let auditCreated = 0;

    const providerAdapter: ProviderBackgroundAdapter = {
      getBackgroundStructuredPromptPolicy() {
        return {
          allowsFileWrite: false,
          allowsShellWrite: false,
          allowsToolPermissionRequests: false,
          structuredOutputOnly: true,
          structuredOutputMode: "schema_submit_tool",
        };
      },
      async extractSessionMemoryDelta() {
        extractionCalled += 1;
        throw new Error("should not run");
      },
      async runBackgroundStructuredPrompt() {
        throw new Error("should not run");
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
      getAppSettings() {
        return normalizeAppSettings({ memoryGenerationEnabled: false });
      },
      getProviderBackgroundAdapter() {
        return providerAdapter;
      },
      ensureSessionMemory(current) {
        return createDefaultSessionMemory(current);
      },
      upsertSessionMemory() {},
      promoteSessionMemoryDeltaToProjectMemory() {
        return 0;
      },
      createAuditLog(input) {
        auditCreated += 1;
        return createAuditLogBase(input);
      },
      updateAuditLog() {},
      setSessionBackgroundActivity() {},
    });

    await service.runSessionMemoryExtraction(
      session,
      { inputTokens: 1, cachedInputTokens: 0, outputTokens: 400 },
      { triggerReason: "outputTokensThreshold" },
    );

    assert.equal(extractionCalled, 0);
    assert.equal(auditCreated, 0);
  });

  it("Session Memory extraction の成功時に audit / activity / promotion を更新する", async () => {
    const session = createSession({ id: "session-memory" });
    const memory = createDefaultSessionMemory(session);
    const auditUpdates: AuditLogEntry[] = [];
    const activities: SessionBackgroundActivityState[] = [];
    const savedMemories: SessionMemory[] = [];
    const promoted: Array<{ sessionId: string; goal: string | undefined }> = [];
    let observedTimeoutMs = 0;

    const providerAdapter: ProviderBackgroundAdapter = {
      getBackgroundStructuredPromptPolicy() {
        return {
          allowsFileWrite: false,
          allowsShellWrite: false,
          allowsToolPermissionRequests: false,
          structuredOutputOnly: true,
          structuredOutputMode: "schema_submit_tool",
        };
      },
      async extractSessionMemoryDelta(input) {
        observedTimeoutMs = input.timeoutMs;
        return {
          threadId: "thread-memory",
          rawText: "{\"goal\":\"整理する\",\"nextActions\":[\"次をやる\"]}",
          delta: { goal: "整理する", nextActions: ["次をやる"] },
          rawItemsJson: "{\"type\":\"background-response\"}",
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 220 },
          providerQuotaTelemetry: {
            provider: "copilot",
            updatedAt: "2026-03-29T00:00:00.000Z",
            snapshots: [
              {
                quotaKey: "premium_interactions",
                entitlementRequests: 500,
                usedRequests: 120,
                remainingPercentage: 76,
                overage: 0,
                overageAllowedWithExhaustedQuota: false,
                resetDate: "2026-04-01T00:00:00.000Z",
              },
            ],
          },
        };
      },
      async runCharacterReflection() {
        throw new Error("not used");
      },
      async runBackgroundStructuredPrompt() {
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
      getAppSettings() {
        return normalizeAppSettings({});
      },
      getProviderBackgroundAdapter() {
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
        return 1;
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
      { inputTokens: 1, cachedInputTokens: 0, outputTokens: 300001 },
      { triggerReason: "outputTokensThreshold" },
    );

    assert.equal(auditUpdates.at(-1)?.phase, "background-completed");
    assert.equal(observedTimeoutMs, 180_000);
    assert.equal(auditUpdates.at(-1)?.rawItemsJson, "{\"type\":\"background-response\"}");
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "remainingPercentage")?.value,
      "76%",
    );
    assert.equal(
      auditUpdates.at(-1)?.transportPayload?.fields.find((field) => field.label === "projectMemoryPromotions")?.value,
      "1",
    );
    assert.equal(savedMemories.at(-1)?.goal, "整理する");
    assert.deepEqual(savedMemories.at(-1)?.nextActions, ["次をやる"]);
    assert.deepEqual(promoted, [{ sessionId: session.id, goal: "整理する" }]);
    assert.equal(activities.at(0)?.status, "running");
    assert.equal(activities.at(-1)?.status, "completed");
    assert.match(activities.at(-1)?.details ?? "", /updated goal:/);
    assert.match(activities.at(-1)?.details ?? "", /整理する/);
    assert.match(activities.at(-1)?.details ?? "", /updated nextActions:/);
    assert.match(activities.at(-1)?.details ?? "", /次をやる/);
    assert.match(activities.at(-1)?.details ?? "", /projectMemoryPromotions: 1/);
  });
});
