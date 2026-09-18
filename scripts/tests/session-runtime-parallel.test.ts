import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import { ProviderTurnError, type ProviderCodingAdapter } from "../../src-electron/provider-runtime.js";
import { SessionRuntimeService } from "../../src-electron/session-runtime-service.js";
import type { Session } from "../../src/app-state.js";
import { buildNewSession } from "../../src/app-state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function session(id: string, provider: string): Session {
  return {
    ...buildNewSession({
      id,
      taskTitle: id,
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      provider,
      characterId: `character-${id}`,
      character: id,
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    }),
  };
}

function providerCatalog(id: string): ModelCatalogProvider {
  return {
    id,
    label: id,
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
  };
}

function adapter(
  gates: Map<string, Promise<{ threadId: string; assistantText: string; finalText: string }>>,
  onCancel: (sessionId: string) => void,
  onStart: (sessionId: string) => void = () => undefined,
): ProviderCodingAdapter {
  return {
    composePrompt() {
      return {
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
        imagePaths: [],
        additionalDirectories: [],
      };
    },
    async getProviderQuotaTelemetry() { return null; },
    invalidateSessionThread() {},
    invalidateAllSessionThreads() {},
    runSessionTurn(input) {
      onStart(input.session.id);
      const resultPromise = gates.get(input.session.id)!;
      const result = resultPromise.then((value) => ({
        threadId: value.threadId,
        assistantText: value.assistantText,
        lastNonEmptyAssistantMessageText: value.finalText,
        logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
        transportPayload: null,
        operations: [],
        rawItemsJson: "[]",
        usage: null,
      }));
      if (!input.signal) {
        return result;
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          input.signal?.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = () => {
          onCancel(input.session.id);
          settle(() => reject(new ProviderTurnError(
            "test provider canceled",
            {
              threadId: null,
              assistantText: "",
              logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
              transportPayload: null,
              operations: [],
              rawItemsJson: "[]",
              usage: null,
            },
            true,
            "canceled",
          )));
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });
        if (input.signal?.aborted) {
          onAbort();
          return;
        }
        result.then((value) => settle(() => resolve(value)), (error) => settle(() => reject(error)));
      });
    },
  };
}

function makeRuntimeService(
  stored: Map<string, Session>,
  adapters: Map<string, ProviderCodingAdapter>,
  confirmedFinalTexts: string[],
) {
  let auditId = 0;
  const liveRuns = new Map<string, any>();
  const appSettings = normalizeAppSettings({});
  appSettings.codingProviderSettings.gemini = { enabled: true, apiKey: "" };
  return new SessionRuntimeService({
    getSession: (id) => stored.get(id) ?? null,
    upsertSession: (next, options) => {
      if (options?.confirmedFinalAssistantText !== undefined) {
        confirmedFinalTexts.push(options.confirmedFinalAssistantText ?? "");
      }
      stored.set(next.id, next);
      return next;
    },
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    getAppSettings: () => appSettings,
    resolveProviderCatalog: (providerId) => {
      const provider = providerCatalog(providerId ?? "codex");
      return { provider, snapshot: { revision: 1, providers: [provider] } };
    },
    getProviderCodingAdapter: (providerId) => adapters.get(providerId)!,
    getSessionMemory: (next) => ({
      sessionId: next.id,
      workspacePath: next.workspacePath,
      threadId: next.threadId,
      schemaVersion: 1,
      goal: "",
      decisions: [],
      openQuestions: [],
      nextActions: [],
      notes: [],
      updatedAt: new Date().toISOString(),
    }),
    resolveProjectMemoryEntriesForPrompt: () => [],
    createAuditLog: (input) => ({ id: ++auditId, ...input }),
    updateAuditLog: () => undefined,
    setLiveSessionRun: (id, state) => state ? liveRuns.set(id, state) : liveRuns.delete(id),
    getLiveSessionRun: (id) => liveRuns.get(id) ?? null,
    waitForApprovalDecision: () => "approve",
    waitForElicitationResponse: () => ({ action: "cancel" }),
    setProviderQuotaTelemetry: () => undefined,
    setSessionContextTelemetry: () => undefined,
    invalidateProviderSessionThread: () => undefined,
    scheduleProviderQuotaTelemetryRefresh: () => undefined,
    broadcastLiveSessionRun: () => undefined,
    resolvePendingApprovalRequest: () => undefined,
    resolvePendingElicitationRequest: () => undefined,
    providerCancelGraceMs: 0,
  });
}

describe("SessionRuntimeService parallel conversations", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "MainとAuxiliary A/Bは同時実行でき、AだけをcancelしてもMain/Bの保存結果とthreadが混線しない"
  // oracle = { type = "contract", ref = "issue-710 acceptance A/G: independent parallel runs" }
  // fault = "共有runtime状態やProvider実行を会話間で直列化し、AのcancelでMain/Bを停止または別会話のmessages/threadを保存する"
  // observable = "各Sessionのrun結果、messages末尾、threadId、cancel後のAの状態"
  // observation_boundary = "public-boundary"
  // scope = "session-runtime-parallel"
  // lifecycle = "permanent"
  // @end-test-value
  it("同一Providerと別Providerの両方でMain/A/Bを独立して完了・cancelする", async () => {
    for (const auxiliaryProvider of ["codex", "gemini"] as const) {
      const main = session("main", "codex");
      const auxiliaryA = session("aux-a", auxiliaryProvider);
      const auxiliaryB = session("aux-b", auxiliaryProvider);
      const stored = new Map([main, auxiliaryA, auxiliaryB].map((value) => [value.id, value] as const));
      const mainGate = deferred<{ threadId: string; assistantText: string; finalText: string }>();
      const aGate = deferred<{ threadId: string; assistantText: string; finalText: string }>();
      const bGate = deferred<{ threadId: string; assistantText: string; finalText: string }>();
      const gates = new Map([
        [main.id, mainGate.promise],
        [auxiliaryA.id, aGate.promise],
        [auxiliaryB.id, bGate.promise],
      ]);
      const startedSessionIds = new Set<string>();
      const cancelA = () => aGate.resolve({ threadId: "thread-a-canceled", assistantText: "", finalText: "" });
      const adapters = new Map<string, ProviderCodingAdapter>([
        ["codex", adapter(gates, (sessionId) => { if (sessionId === auxiliaryA.id) cancelA(); }, (sessionId) => startedSessionIds.add(sessionId))],
        ["gemini", adapter(gates, (sessionId) => { if (sessionId === auxiliaryA.id) cancelA(); }, (sessionId) => startedSessionIds.add(sessionId))],
      ]);
      const mainStored = new Map([[main.id, main]]);
      const auxiliaryStored = new Map([[auxiliaryA.id, auxiliaryA], [auxiliaryB.id, auxiliaryB]]);
      const mainConfirmedFinalTexts: string[] = [];
      const auxiliaryConfirmedFinalTexts: string[] = [];
      const mainRuntime = makeRuntimeService(mainStored, adapters, mainConfirmedFinalTexts);
      const auxiliaryRuntime = makeRuntimeService(auxiliaryStored, adapters, auxiliaryConfirmedFinalTexts);

      const mainRun = mainRuntime.runSessionTurn(main.id, { userMessage: "main" });
      const aRun = auxiliaryRuntime.runSessionTurn(auxiliaryA.id, { userMessage: "a" });
      const bRun = auxiliaryRuntime.runSessionTurn(auxiliaryB.id, { userMessage: "b" });
      for (let attempt = 0; attempt < 100 && startedSessionIds.size < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.deepEqual([...startedSessionIds].sort(), [auxiliaryA.id, auxiliaryB.id, main.id].sort());
      await auxiliaryRuntime.cancelRun(auxiliaryA.id);
      mainGate.resolve({ threadId: "thread-main", assistantText: "途中発言\n最終発言", finalText: "最終発言" });
      bGate.resolve({ threadId: "thread-b", assistantText: "b done", finalText: "b final" });
      await Promise.all([mainRun, aRun, bRun]);

      assert.equal(mainStored.get(main.id)?.runState, "idle");
      assert.equal(mainStored.get(main.id)?.threadId, "thread-main");
      assert.equal(mainStored.get(main.id)?.messages.at(-1)?.text, "途中発言\n最終発言");
      assert.equal(auxiliaryStored.get(auxiliaryB.id)?.runState, "idle");
      assert.equal(auxiliaryStored.get(auxiliaryB.id)?.threadId, "thread-b");
      assert.equal(auxiliaryStored.get(auxiliaryB.id)?.messages.at(-1)?.text, "b done");
      assert.equal(auxiliaryStored.get(auxiliaryA.id)?.runState, "idle");
      assert.match(auxiliaryStored.get(auxiliaryA.id)?.messages.at(-1)?.text ?? "", /キャンセル|cancel/i);
      assert.deepEqual(mainConfirmedFinalTexts, ["最終発言"]);
      assert.deepEqual(auxiliaryConfirmedFinalTexts, ["b final"]);
    }
  });
});
