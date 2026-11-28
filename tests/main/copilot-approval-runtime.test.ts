import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { CopilotSession, type CopilotClient, type PermissionRequestedData, type SessionConfig, type SessionEvent } from "@github/copilot-sdk";
import { CopilotAdapter } from "../../src-electron/providers/copilot/copilot-adapter.js";
import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import { ApprovalReviewInputFence, WithMateApprovalReviewTurn } from "../../src-electron/session/withmate-approval-review.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { SessionRuntimeFixture } from "./session-runtime-fixture.js";

type PermissionWire = Parameters<CopilotSession["rpc"]["permissions"]["handlePendingPermissionRequest"]>[0] & { sessionId: string };
type Review = "allow_once" | "deny" | "ask_user" | "technical-failure";

function createCopilotReadRuntime(options: {
  workspacePath: string;
  review: Review;
  reviewerMode?: "user" | "auto-review";
  reviewerOff?: boolean;
}) {
  const { workspacePath } = options;
  const selection = { providerId: "codex", model: "fixture-reviewer", reasoningEffort: "high" } as const;
  const catalog: ModelCatalogProvider = { id: "copilot", label: "Copilot", defaultModelId: "gpt-4.1", defaultReasoningEffort: "high",
    models: [{ id: "gpt-4.1", label: "GPT-4.1", reasoningEfforts: ["high"] }] };
  let stored = buildNewSession({ provider: "copilot", model: "gpt-4.1", reasoningEffort: "high", approvalMode: "on-request",
    taskTitle: "Copilot read fixture", workspaceLabel: "fixture", workspacePath, branch: "fixture", characterId: "fixture",
    character: "Fixture", characterIconPath: "", characterThemeColors: { main: "#000000", sub: "#ffffff" } });
  if (options.reviewerMode) stored = { ...stored, codexReviewer: options.reviewerMode, withMateReviewerExplicit: true };
  let live: LiveSessionRunState | null = null;
  let turn = 0;
  let eventId = 0;
  let opened = 0;
  let session: CopilotSession;
  const published = Promise.withResolvers<string>();
  const publishedIds: string[] = [];
  const notifications: string[] = [];
  const outbound = Promise.withResolvers<PermissionWire>();
  const sent = Promise.withResolvers<void>();
  const reviewing = Promise.withResolvers<string>();
  const reviewerDone = Promise.withResolvers<void>();
  const emit = <E extends SessionEvent["type"]>(type: E, data: Extract<SessionEvent, { type: E }>["data"]) => {
    // バージョンを固定した SDK の実際のイベントディスパッチャーを通じて、サーバー通知を配信する。
    Reflect.get(session, "_dispatchEvent").call(session, { type, data, id: `event-${++eventId}`, parentId: null, timestamp: "2026-01-01T00:00:00Z" });
  };
  const wire = {
    async sendRequest(method: string, payload: unknown) {
      switch (method) {
        case "session.send": sent.resolve(); return { messageId: "synthetic-input" };
        case "session.eventLog.registerInterest": return { handle: "synthetic-interest" };
        case "session.eventLog.releaseInterest": return {};
        case "session.detach": return { success: true };
        case "session.abort": emit("session.idle", {}); return {};
        case "session.permissions.handlePendingPermissionRequest": outbound.resolve(payload as PermissionWire); return { success: true };
        default: throw new Error(`Unexpected synthetic native request: ${method}`);
      }
    },
  };
  const createSession = async (config: SessionConfig) => {
    // パッケージのコンストラクターと設定登録は、通常 `CopilotClient` が呼ぶ内部メソッドである。
    // ここでは通信経路もプロセスも初期化しない。
    session = Reflect.construct(CopilotSession, ["synthetic-native-session", wire]);
    Reflect.get(session, "registerPermissionHandler").call(session, config.onPermissionRequest);
    return session;
  };
  const adapter = new CopilotAdapter({ createClient: () => ({ createSession, stop: async () => [] }) as unknown as CopilotClient });
  const approvals = new SessionApprovalService({
    updateLiveSessionRun: (_sessionId, update) => {
      if (!live) return null;
      const previousId = live.approvalRequest?.requestId;
      live = update(live);
      const id = live.approvalRequest?.requestId;
      if (id && id !== previousId) publishedIds.push(id);
      return live;
    },
    notifyApproval: (_sessionId, requestId) => { notifications.push(requestId); published.resolve(requestId); },
  });
  const runtime = new SessionRuntimeFixture({
    getSession: () => stored,
    upsertSession: (next) => stored = next,
    createSessionTurn: (data) => ({ id: ++turn, ...data }), updateSessionTurn() {},
    getAppSettings: () => normalizeAppSettings({ withMateAutoReview: options.reviewerOff ? null : selection,
      codingProviderSettings: { copilot: { enabled: true } } }),
    getProviderCodingAdapter: () => adapter,
    resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [catalog] }, provider: catalog }),
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    beginProviderAgentRuntimeTurn: () => ({ handle: "synthetic-handle", binding: { bindingId: "synthetic-binding",
      bindingReference: "synthetic-capability", providerId: "copilot", executionGeneration: "synthetic-generation", transport: "env", expiresAt: null } }),
    startWithMateApprovalReview: (input) => {
      assert.deepEqual(input.selection, selection);
      return new WithMateApprovalReviewTurn({ ...input, source: { kind: "main", sessionId: stored.id, incarnationId: "synthetic-incarnation" },
        inputs: new ApprovalReviewInputFence(), policyCurrent: () => true,
        open: async () => {
          opened++;
          return { close() {}, review: async (prompt) => {
            reviewing.resolve(prompt);
            await reviewerDone.promise;
            if (options.review === "technical-failure") throw new Error("Synthetic reviewer unavailable");
            return { decision: options.review, reason: "Synthetic reviewer result" };
          } };
        },
      });
    },
    setLiveSessionRun: (_id, next) => { live = next; }, getLiveSessionRun: () => live,
    waitForApprovalDecision: (...args) => approvals.waitForLiveApprovalDecision(...args),
    waitForElicitationResponse: () => ({ action: "cancel" }),
    setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, scheduleProviderQuotaTelemetryRefresh() {},
    invalidateProviderSessionThread: (_provider, id) => adapter.invalidateSessionThread(id),
    broadcastLiveSessionRun() {}, resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
  });

  return { live: () => live, publishedIds, notifications, opened: () => opened, reviewing: reviewing.promise, reviewerDone,
    pending: published.promise, outbound: outbound.promise,
    manual: (requestId: string, decision: "approve" | "deny") => approvals.resolveLiveApproval(stored.id, requestId, decision),
    start: () => runtime.runSessionTurn(stored.id, { userMessage: "Read the synthetic fixture", executionOptions: captureSessionExecutionOptions(stored) }),
    async request(data: PermissionRequestedData) { await sent.promise; emit("permission.requested", data); },
    finish: () => emit("session.idle", {}),
    async cleanup() {
      reviewerDone.resolve();
      approvals.reset();
      if (session) emit("session.idle", {});
      await adapter.invalidateAllSessionThreads();
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Copilotの単発の明示判断Readは設定した審査先へ渡り、ask_userだけが公開され、人と審査と技術失敗の結果は別のSDK応答になる"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: CopilotAdapterのon-requestとSDK応答; docs/design/withmate-auto-review.md#一件の判定と手動承認" }
// fault = "明示判断を人間専用と誤る、pendingを先に公開する、または審査結果・失敗を人間の決定に変換する"
// observable = "審査役への実要求、live承認欄と公開通知hook、SDKのpending permission RPC本文"
// observation_boundary = "consumer"
// scope = "合成native通知から固定SDK、CopilotAdapter、SessionRuntime、実承認キュー、審査Turnを経由してSDK応答まで"
// lifecycle = "permanent"
// distinction = "callback単体ではSDKによる出所転送や、実Turnでの選択審査先と手動公開を観測できない"
// @end-test-value
it("Copilotの合成Readは実SDKと共通runtimeを通り決着主体を維持する", { timeout: 10_000 }, async (t) => {
  const root = path.resolve("synthetic-copilot-approval-workspace");
  t.mock.method(os, "homedir", () => root);
  const read = { kind: "read", path: path.join(root, "synthetic.txt"), intention: "Read one fixture" } as const;
  const explicit = { status: "completed", recommendation: "requireApproval" } as const;
  for (const scenario of [
    { label: "ordinary classification", review: "allow_once", native: { permissionRequest: read }, expected: "approve-once" },
    { label: "review allow", review: "allow_once", expected: "approve-once", source: "host_policy" },
    { label: "review deny", review: "deny", expected: "user-not-available", source: "host_policy" },
    { label: "review ask_user", review: "ask_user", manual: "approve", expected: "approve-once", source: "human_response" },
    { label: "review failure", review: "technical-failure", expected: "user-not-available", source: "unattended_fallback" },
    { label: "managed Auto Review", review: "allow_once", native: { permissionRequest: { ...read, managedApprovalRequired: true } },
      expected: "user-not-available", source: "unattended_fallback" },
    { label: "managed User", review: "allow_once", reviewerMode: "user", native: { promptRequest: { ...read, managedApprovalRequired: true } },
      manual: "deny", expected: "reject", source: "human_response" },
    { label: "explicit Auto Review Off", review: "allow_once", reviewerMode: "auto-review", reviewerOff: true,
      expected: "user-not-available", source: "unattended_fallback" },
  ] as const) {
    const f = createCopilotReadRuntime({ workspacePath: root, ...scenario });
    const run = f.start();
    try {
      const eligible = scenario.label.startsWith("review ");
      const data: PermissionRequestedData = { requestId: "synthetic-read-request", permissionRequest: read,
        ...(scenario.label === "ordinary classification" ? {} : { promptRequest: read, assistedApprovalAssessment: explicit }),
        ...("native" in scenario ? scenario.native : {}),
      };
      await f.request(data);
      if (eligible) {
        const first = await Promise.race([
          f.reviewing.then((prompt) => ({ boundary: "review", prompt })),
          f.pending.then(() => ({ boundary: "manual", prompt: "" })),
          f.outbound.then(() => ({ boundary: "native response", prompt: "" })),
        ]);
        assert.equal(first.boundary, "review", scenario.label);
        const prompt = JSON.parse(first.prompt);
        assert.deepEqual(prompt.pendingOperation.operation, { request: read, workspacePath: root, promptRequest: read, assistedApprovalAssessment: explicit });
        assert.deepEqual(f.notifications, []);
        assert.equal(f.live()?.approvalRequest, null);
        f.reviewerDone.resolve();
      }
      const manualDecision = "manual" in scenario ? scenario.manual : undefined;
      const expectedPublications: string[] = [];
      if (manualDecision !== undefined) {
        const requestId = await f.pending;
        expectedPublications.push(requestId);
        assert.equal(f.live()?.approvalRequest?.requestId, requestId);
        f.manual(requestId, manualDecision);
      }
      const response = await f.outbound;
      assert.equal(response.sessionId, "synthetic-native-session", scenario.label);
      assert.equal(response.requestId, data.requestId, scenario.label);
      assert.deepEqual(response.result, { kind: scenario.expected }, scenario.label);
      assert.equal(response.decisionContext?.source, "source" in scenario ? scenario.source : undefined, scenario.label);
      assert.equal(f.opened(), Number(eligible), scenario.label);
      assert.deepEqual(f.publishedIds, expectedPublications, scenario.label);
      assert.deepEqual(f.notifications, expectedPublications, scenario.label);
      assert.equal(f.live()?.approvalRequest, null);
      f.finish();
      assert.equal((await run).runState, "idle");
    } finally {
      await f.cleanup();
    }
  }
});
