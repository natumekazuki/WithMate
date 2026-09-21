import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AuditLogOperation, LiveBackgroundTask, LiveRunStep, ProviderQuotaTelemetry } from "../../src-shared/session/runtime-state.js";
import type { GlossaryProjectionState, SessionGlossaryProjection } from "../../src-shared/glossary/glossary-contract.js";
import {
  buildContextPaneProjection,
  buildCopilotQuotaProjection,
  buildLatestCommandProjection,
  buildLatestCommandView,
  buildRunningDetailsEntries,
  buildSessionContextTelemetryProjection,
  cycleContextPaneTab,
  contextPaneTabLabel,
  findLatestAuditCommandOperation,
  findLatestLiveCommandStep,
  resolveAvailableContextPaneTabs,
  shouldIncludeGlossaryContextPane,
  isGlossarySearchRevisionCurrent,
} from "../../src/session-ui-projection.js";

function makeBackgroundTask(partial: Partial<LiveBackgroundTask> & Pick<LiveBackgroundTask, "id" | "kind" | "status" | "title" | "updatedAt">): LiveBackgroundTask {
  return {
    details: undefined,
    ...partial,
  };
}

describe("session-ui-projection", () => {
  it("Glossary検索結果は初回・追加取得ともcurrent projection revisionだけを採用する", () => {
    assert.equal(isGlossarySearchRevisionCurrent("revision-a", "revision-a"), true);
    assert.equal(isGlossarySearchRevisionCurrent("revision-b", "revision-a"), false);
    assert.equal(isGlossarySearchRevisionCurrent("revision-a", null), false);
  });

  it("latest command helpers は末尾の command_execution を拾う", () => {
    const liveSteps: LiveRunStep[] = [
      {
        id: "cmd-old",
        type: "command_execution",
        summary: "npm test",
        status: "completed",
      },
      {
        id: "reasoning-1",
        type: "reasoning",
        summary: "考慮中",
        status: "completed",
      },
      {
        id: "cmd-new",
        type: "command_execution",
        summary: "npm run build",
        status: "in_progress",
      },
    ];
    const auditOperations: AuditLogOperation[] = [
      {
        type: "command_execution",
        summary: "git status",
      },
      {
        type: "response_item",
        summary: "assistant text",
      },
      {
        type: "command_execution",
        summary: "npm test",
      },
    ];

    assert.equal(findLatestLiveCommandStep(liveSteps)?.id, "cmd-new");
    assert.equal(findLatestAuditCommandOperation(auditOperations)?.summary, "npm test");
  });

  it("latest command helpers は command_execution がなければ null を返す", () => {
    assert.equal(
      findLatestLiveCommandStep([
        {
          id: "reasoning-1",
          type: "reasoning",
          summary: "考慮中",
          status: "completed",
        },
      ]),
      null,
    );
    assert.equal(
      findLatestAuditCommandOperation([
        {
          type: "response_item",
          summary: "assistant text",
        },
      ]),
      null,
    );
  });

  it("LatestCommand projection は live がなければ audit fallback を使う", () => {
    const projection = buildLatestCommandProjection({
      liveSteps: [],
      auditOperations: [
        {
          type: "command_execution",
          summary: "npm test",
          details: "ok",
        },
      ],
      latestTerminalAuditPhase: "completed",
    });

    assert.equal(projection.latestLiveCommandStep, null);
    assert.deepEqual(projection.latestCommandView, {
      status: "completed",
      summary: "npm test",
      details: "ok",
      sourceLabel: "latest run",
      riskLabels: [],
    });
  });

  it("LatestCommand projection は audit fallback を無効化できる", () => {
    const projection = buildLatestCommandProjection({
      liveSteps: [],
      auditOperations: [
        {
          type: "command_execution",
          summary: "npm test",
        },
      ],
      latestTerminalAuditPhase: "completed",
      auditFallbackEnabled: false,
    });

    assert.equal(projection.latestLiveCommandStep, null);
    assert.equal(projection.latestCommandView, null);
  });

  it("LatestCommand projection は audit fallback 無効中でも live command を優先する", () => {
    const projection = buildLatestCommandProjection({
      liveSteps: [
        {
          id: "cmd-live",
          type: "command_execution",
          summary: "npm run build",
          status: "in_progress",
        },
      ],
      auditOperations: [
        {
          type: "command_execution",
          summary: "npm test",
        },
      ],
      latestTerminalAuditPhase: "completed",
      auditFallbackEnabled: false,
    });

    assert.equal(projection.latestLiveCommandStep?.id, "cmd-live");
    assert.deepEqual(projection.latestCommandView, {
      status: "in_progress",
      summary: "npm run build",
      details: undefined,
      sourceLabel: "live",
      riskLabels: [],
    });
  });

  it("live command があれば latest run より優先して LatestCommand view を作る", () => {
    const latestAuditCommandOperation: AuditLogOperation = {
      type: "command_execution",
      summary: "git status",
    };

    const view = buildLatestCommandView({
      latestLiveCommandStep: {
        id: "step-1",
        type: "command_execution",
        summary: "rm -rf dist",
        status: "in_progress",
        details: "destructive command",
      },
      latestAuditCommandOperation,
      latestTerminalAuditPhase: "completed",
    });

    assert.deepEqual(view, {
      status: "in_progress",
      summary: "rm -rf dist",
      details: "destructive command",
      sourceLabel: "live",
      riskLabels: ["DELETE"],
    });
  });

  it("Copilot quota projection は preferred snapshot と表示文言を返す", () => {
    const telemetry: ProviderQuotaTelemetry = {
      provider: "copilot",
      updatedAt: "2026-03-28T00:00:00.000Z",
      snapshots: [
        {
          quotaKey: "chat",
          entitlementRequests: 200,
          usedRequests: 120,
          remainingPercentage: 40.1,
          overage: 0,
          overageAllowedWithExhaustedQuota: false,
          resetDate: "2026-03-29T00:00:00.000Z",
        },
      ],
    };

    const projection = buildCopilotQuotaProjection(telemetry);

    assert.equal(projection.snapshot?.quotaKey, "chat");
    assert.equal(projection.remainingPercentLabel, "40% left");
    assert.equal(projection.remainingRequestsLabel, "80 / 200 requests left");
    assert.match(projection.resetLabel, /\d{2}\/\d{2} \d{2}:\d{2}/);
  });

  it("Copilot quota projection は AI credits snapshot を優先して credits 表示にする", () => {
    const telemetry: ProviderQuotaTelemetry = {
      provider: "copilot",
      updatedAt: "2026-06-01T00:00:00.000Z",
      snapshots: [
        {
          quotaKey: "premium_interactions",
          entitlementRequests: 200,
          usedRequests: 120,
          remainingPercentage: 40,
          overage: 0,
          overageAllowedWithExhaustedQuota: false,
        },
        {
          quotaKey: "ai_credits",
          entitlementRequests: 1500,
          usedRequests: 250,
          remainingPercentage: 83.3,
          overage: 0,
          overageAllowedWithExhaustedQuota: false,
        },
      ],
    };

    const projection = buildCopilotQuotaProjection(telemetry);

    assert.equal(projection.snapshot?.quotaKey, "ai_credits");
    assert.equal(projection.remainingPercentLabel, "83% left");
    assert.equal(projection.remainingRequestsLabel, "1250 / 1500 credits left");
  });

  it("ContextPaneProjection は LatestCommand tab の表示情報を作る", () => {
    const projection = buildContextPaneProjection({
      activeContextPaneTab: "latest-command",
      latestCommandView: {
        status: "completed",
        summary: "npm run build",
        sourceLabel: "latest run",
        riskLabels: ["WRITE"],
      },
      backgroundTasks: [
        makeBackgroundTask({
          id: "agent:1",
          kind: "agent",
          status: "completed",
          title: "sub agent",
          updatedAt: "2026-03-28T00:00:00.000Z",
        }),
      ],
    });

    assert.equal(projection.badgeLabel, "");
    assert.equal(projection.toneClassName, "completed");
    assert.equal(projection.latestCommandToneClassName, "completed");
    assert.equal(projection.latestCommandStatusLabel, "完了");
    assert.equal(projection.latestCommandSourceCopy, "LAST RUN");
  });

  it("ContextPaneProjection は Tasks tab の tone を background task 状態から作る", () => {
    const projection = buildContextPaneProjection({
      activeContextPaneTab: "tasks",
      latestCommandView: null,
      backgroundTasks: [
        makeBackgroundTask({
          id: "agent:1",
          kind: "agent",
          status: "failed",
          title: "sub agent",
          updatedAt: "2026-03-28T00:00:00.000Z",
        }),
      ],
    });

    assert.equal(projection.toneClassName, "failed");
    assert.equal(projection.tasksToneClassName, "failed");
    assert.equal(projection.badgeLabel, "失敗");
  });


  it("running details は確定済み step だけを末尾から拾い、最新 command は重複表示しない", () => {
    const entries = buildRunningDetailsEntries({
      liveSteps: [
        {
          id: "cmd-old",
          type: "command_execution",
          summary: "npm test",
          details: "ok",
          status: "completed",
        },
        {
          id: "tool-1",
          type: "mcp_tool_call",
          summary: "github/search",
          details: "{\"count\":1}",
          status: "completed",
        },
        {
          id: "cmd-live",
          type: "command_execution",
          summary: "npm run build",
          details: "building",
          status: "in_progress",
        },
      ],
      latestLiveCommandStepId: "cmd-live",
    });

    assert.deepEqual(entries, [
      {
        id: "cmd-old",
        type: "command_execution",
        status: "completed",
        summary: "npm test",
        details: "ok",
      },
      {
        id: "tool-1",
        type: "mcp_tool_call",
        status: "completed",
        summary: "github/search",
        details: "{\"count\":1}",
      },
    ]);
  });

  it("running details は pending / in_progress を除外し、件数を絞る", () => {
    const entries = buildRunningDetailsEntries({
      liveSteps: [
        {
          id: "1",
          type: "reasoning",
          summary: "first",
          status: "completed",
        },
        {
          id: "2",
          type: "reasoning",
          summary: "second",
          status: "completed",
        },
        {
          id: "3",
          type: "reasoning",
          summary: "third",
          status: "completed",
        },
        {
          id: "4",
          type: "reasoning",
          summary: "fourth",
          status: "completed",
        },
        {
          id: "5",
          type: "mcp_tool_call",
          summary: "pending",
          status: "pending",
        },
      ],
      maxEntries: 2,
    });

    assert.deepEqual(entries, [
      {
        id: "3",
        type: "reasoning",
        status: "completed",
        summary: "third",
        details: undefined,
      },
      {
        id: "4",
        type: "reasoning",
        status: "completed",
        summary: "fourth",
        details: undefined,
      },
    ]);
  });

  it("SessionContextTelemetry projection は表示用の文字列をまとめる", () => {
    const projection = buildSessionContextTelemetryProjection({
      provider: "copilot",
      sessionId: "session-1",
      updatedAt: "2026-03-28T00:00:00.000Z",
      tokenLimit: 128000,
      currentTokens: 3210,
      messagesLength: 14,
      systemTokens: 120,
      conversationTokens: 3090,
    });

    assert.equal(projection.summaryLabel, "3,210 / 128,000");
    assert.equal(projection.currentTokensLabel, "3,210");
    assert.equal(projection.tokenLimitLabel, "128,000");
    assert.equal(projection.messagesLengthLabel, "14");
    assert.equal(projection.systemTokensLabel, "120");
    assert.equal(projection.conversationTokensLabel, "3,090");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "context pane tab cycleは通常Sessionで利用可能なtabだけを循環する"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "削除済み専用tabをcycle結果へ返す"
  // observable = "cycleContextPaneTabの通常tab結果"
  // observation_boundary = "public-boundary"
  // scope = "session-context-pane-tab-cycle"
  // lifecycle = "permanent"
  // @end-test-value
  it("cycleContextPaneTab は利用可能な command pane を循環する", () => {
    assert.equal(cycleContextPaneTab("latest-command", 1), "messages");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "通常Sessionのavailable context tabsはprovider capabilityに従う"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "通常Sessionへ利用不可のtabを公開する"
  // observable = "resolveAvailableContextPaneTabsの通常Session結果"
  // observation_boundary = "public-boundary"
  // scope = "session-context-pane-available-tabs"
  // lifecycle = "permanent"
  // @end-test-value
  it("available tabs は non-Copilot で Tasks を除外し、Reasoning は capability がある時点で表示する", () => {
    assert.deepEqual(resolveAvailableContextPaneTabs({ isCopilotSession: false }), [
      "latest-command",
    ]);
    assert.deepEqual(resolveAvailableContextPaneTabs({ isCopilotSession: true }), [
      "latest-command",
      "tasks",
    ]);
    assert.deepEqual(resolveAvailableContextPaneTabs({ isCopilotSession: false, hasReasoningCapability: true }), [
      "latest-command",
      "reasoning",
    ]);
    assert.deepEqual(resolveAvailableContextPaneTabs({ isCopilotSession: true, hasReasoningCapability: true }), [
      "latest-command",
      "reasoning",
      "tasks",
    ]);
    assert.deepEqual(resolveAvailableContextPaneTabs({ isCopilotSession: true, hasReasoningText: true }), [
      "latest-command",
      "reasoning",
      "tasks",
    ]);
  });

  it("cycleContextPaneTab は利用可能 tab だけを循環する", () => {
    const availableTabs = resolveAvailableContextPaneTabs({ isCopilotSession: false });
    assert.equal(cycleContextPaneTab("latest-command", 1, availableTabs), "latest-command");
    assert.equal(cycleContextPaneTab("latest-command", -1, availableTabs), "latest-command");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Messages tabは有効化されたSessionにだけ既存pane順で追加される"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md" }
  // fault = "Messages tabの表示条件または順序を誤り利用できるpaneの切替先を失う"
  // observable = "利用可能tab一覧、Messages label、循環切替先"
  // observation_boundary = "public-boundary"
  // scope = "Session context pane Messages capability"
  // lifecycle = "permanent"
  // @end-test-value
  it("Messages tab は明示的に有効化したSession Windowだけへ既存順で追加される", () => {
    assert.deepEqual(resolveAvailableContextPaneTabs({
      isCopilotSession: true,
      includeMessages: true,
      hasReasoningCapability: true,
    }), [
      "latest-command",
      "messages",
      "reasoning",
      "tasks",
    ]);
    assert.deepEqual(resolveAvailableContextPaneTabs({ isCopilotSession: true }), [
      "latest-command",
      "tasks",
    ]);
    assert.equal(contextPaneTabLabel("messages"), "Messages");
    assert.equal(cycleContextPaneTab("latest-command", 1, ["latest-command", "messages"]), "messages");
  });

  it("Glossary tabはAgent Sessionで明示的に有効化し、既存right pane順へ追加する", () => {
    assert.deepEqual(resolveAvailableContextPaneTabs({
      isCopilotSession: false,
      includeMessages: true,
      includeGlossary: true,
    }), ["latest-command", "messages", "glossary"]);
    assert.equal(contextPaneTabLabel("glossary"), "Glossary");
  });

  it("Glossary tabはloading・missing・空を含む全状態で安定して表示する", () => {
    const projection = (state: GlossaryProjectionState): SessionGlossaryProjection => ({
      sessionId: "session-1",
      scopeRevision: "scope-1",
      sequence: 1,
      checkout: { repositoryName: "repository", branch: "main", pathLabel: "repository" },
      state,
    });
    const issue = { path: "$", code: "INVALID_YAML", message: "invalid" };

    assert.equal(shouldIncludeGlossaryContextPane(null), true);
    assert.equal(shouldIncludeGlossaryContextPane(projection({
      status: "missing",
      relativePath: ".withmate/glossary.yaml",
      revision: null,
    })), true);
    assert.equal(shouldIncludeGlossaryContextPane(projection({
      status: "valid",
      relativePath: ".withmate/glossary.yaml",
      revision: "empty",
      entries: [],
    })), true);
    assert.equal(shouldIncludeGlossaryContextPane(projection({
      status: "valid",
      relativePath: ".withmate/glossary.yaml",
      revision: "populated",
      entries: [{ term: "Runtime", aliases: [], definition: "definition" }],
    })), true);
    assert.equal(shouldIncludeGlossaryContextPane(projection({
      status: "invalid",
      relativePath: ".withmate/glossary.yaml",
      revision: "invalid",
      issues: [issue],
    })), true);
    assert.equal(shouldIncludeGlossaryContextPane(projection({
      status: "unsupported",
      relativePath: ".withmate/glossary.yaml",
      revision: "unsupported",
      schemaVersion: 2,
      issues: [issue],
    })), true);
    assert.equal(shouldIncludeGlossaryContextPane(projection({
      status: "watch-error",
      relativePath: ".withmate/glossary.yaml",
      revision: null,
      message: "watch failed",
    })), true);
  });
});
