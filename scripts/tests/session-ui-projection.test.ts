import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AuditLogOperation,
  ProviderQuotaTelemetry,
  SessionBackgroundActivityState,
} from "../../src/app-state.js";
import {
  buildContextPaneProjection,
  buildCopilotQuotaProjection,
  buildLatestCommandView,
  buildRunningDetailsEntries,
  buildSessionContextTelemetryProjection,
  cycleContextPaneTab,
  resolveAutoContextPaneTab,
} from "../../src/session-ui-projection.js";

function makeBackgroundActivity(
  partial: Partial<SessionBackgroundActivityState> & Pick<SessionBackgroundActivityState, "kind" | "status" | "title" | "summary">,
): SessionBackgroundActivityState {
  return {
    sessionId: "session-1",
    details: undefined,
    errorMessage: "",
    updatedAt: "2026-03-28T00:00:00.000Z",
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
      selectedMemoryGenerationActivity: null,
      selectedCharacterMemoryGenerationActivity: null,
      selectedMonologueActivity: makeBackgroundActivity({
        kind: "monologue",
        status: "running",
        title: "独り言を生成中",
        summary: "stream を作っている",
      }),
    });

    assert.equal(tab, "latest-command");
  });

  it("ContextPaneProjection は active tab に応じて badge と tone を切り替える", () => {
    const projection = buildContextPaneProjection({
      activeContextPaneTab: "memory-generation",
      latestCommandView: {
        status: "completed",
        summary: "npm run build",
        sourceLabel: "latest run",
        riskLabels: ["WRITE"],
      },
      selectedMemoryGenerationActivity: makeBackgroundActivity({
        kind: "memory-generation",
        status: "running",
        title: "Session Memory を更新中",
        summary: "delta を生成している",
      }),
      selectedCharacterMemoryGenerationActivity: makeBackgroundActivity({
        kind: "character-memory-generation",
        status: "completed",
        title: "Character Memory を更新中",
        summary: "relationship を整理している",
      }),
      selectedMonologueActivity: null,
    });

    assert.equal(projection.badgeLabel, "実行中");
    assert.equal(projection.toneClassName, "running");
    assert.equal(projection.latestCommandToneClassName, "completed");
    assert.equal(projection.latestCommandStatusLabel, "完了");
    assert.equal(projection.latestCommandSourceCopy, "LAST RUN");
    assert.equal(projection.memoryGenerationToneClassName, "running");
    assert.equal(projection.characterMemoryGenerationToneClassName, "completed");
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

  it("cycleContextPaneTab は 3 面を循環する", () => {
    assert.equal(cycleContextPaneTab("latest-command", 1), "memory-generation");
    assert.equal(cycleContextPaneTab("latest-command", -1), "monologue");
  });
});
