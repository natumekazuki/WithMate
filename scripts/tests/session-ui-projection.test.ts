import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AuditLogOperation,
  LiveBackgroundTask,
  ProviderQuotaTelemetry,
} from "../../src/app-state.js";
import {
  buildContextPaneProjection,
  buildCopilotQuotaProjection,
  buildLatestCommandView,
  buildRunningDetailsEntries,
  buildSessionContextTelemetryProjection,
  cycleContextPaneTab,
  resolveAvailableContextPaneTabs,
  resolveAutoContextPaneTab,
} from "../../src/session-ui-projection.js";

function makeBackgroundTask(partial: Partial<LiveBackgroundTask> & Pick<LiveBackgroundTask, "id" | "kind" | "status" | "title" | "updatedAt">): LiveBackgroundTask {
  return {
    details: undefined,
    ...partial,
  };
}

describe("session-ui-projection", () => {
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
    assert.equal(projection.remainingRequestsLabel, "80 / 200 left");
    assert.match(projection.resetLabel, /\d{2}\/\d{2} \d{2}:\d{2}/);
  });

  it("実行中 session があれば LatestCommand を自動選択する", () => {
    const tab = resolveAutoContextPaneTab({
      isSelectedSessionRunning: true,
      isCopilotSession: true,
      backgroundTasks: [
        makeBackgroundTask({
          id: "agent:1",
          kind: "agent",
          status: "running",
          title: "sub agent",
          updatedAt: "2026-03-28T00:00:00.000Z",
        }),
      ],
    });

    assert.equal(tab, "latest-command");
  });

  it("Copilot background task が走っていれば Tasks を自動選択する", () => {
    const tab = resolveAutoContextPaneTab({
      isSelectedSessionRunning: false,
      isCopilotSession: true,
      backgroundTasks: [
        makeBackgroundTask({
          id: "shell:1",
          kind: "shell",
          status: "running",
          title: "npm test",
          updatedAt: "2026-03-28T00:00:00.000Z",
        }),
      ],
    });

    assert.equal(tab, "tasks");
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

  it("cycleContextPaneTab は利用可能な command pane を循環する", () => {
    assert.equal(cycleContextPaneTab("latest-command", 1), "tasks");
    assert.equal(cycleContextPaneTab("latest-command", -1), "tasks");
  });

  it("available tabs は non-Copilot で Tasks を除外する", () => {
    assert.deepEqual(resolveAvailableContextPaneTabs({ isCopilotSession: false }), [
      "latest-command",
    ]);
    assert.deepEqual(resolveAvailableContextPaneTabs({ isCopilotSession: true }), [
      "latest-command",
      "tasks",
    ]);
  });

  it("cycleContextPaneTab は利用可能 tab だけを循環する", () => {
    const availableTabs = resolveAvailableContextPaneTabs({ isCopilotSession: false });
    assert.equal(cycleContextPaneTab("latest-command", 1, availableTabs), "latest-command");
    assert.equal(cycleContextPaneTab("latest-command", -1, availableTabs), "latest-command");
  });
});
