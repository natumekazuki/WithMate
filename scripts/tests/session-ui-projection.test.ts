import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AuditLogOperation,
  LiveBackgroundTask,
  LiveRunStep,
  ProviderQuotaTelemetry,
} from "../../src/app-state.js";
import type { GlossaryProjectionState, SessionGlossaryProjection } from "../../src/glossary-contract.js";
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
  // @test-value v1
  // kind = "invariant"
  // claim = "Glossary検索は初回と追加取得の双方でcurrent projection revisionのresponseだけを採用する"
  // oracle = { type = "adr", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "古い検索responseが新しいGlossary projectionを上書きする"
  // scope = "session-ui-glossary-search-generation"
  // lifecycle = "permanent"
  // @end-test-value
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

  it("ContextPaneProjection は CompanionGroup tab の件数と tone を作る", () => {
    const projection = buildContextPaneProjection({
      activeContextPaneTab: "companion-group",
      latestCommandView: null,
      backgroundTasks: [],
      companionGroupMonitorEntries: [
        {
          kind: "companion",
          groupLabel: "WithMate",
          state: { kind: "running", label: "実行中" },
          session: {
            id: "companion-1",
            groupId: "group-1",
            taskTitle: "Companion",
            status: "active",
            repoRoot: "F:/workspace/WithMate",
            focusPath: "",
            targetBranch: "main",
            baseSnapshotRef: "refs/withmate/base/1",
            baseSnapshotCommit: "base-1",
            selectedPaths: [],
            changedFiles: [],
            siblingWarnings: [],
            allowedAdditionalDirectories: [],
            runState: "running",
            threadId: "",
            provider: "codex",
            model: "gpt-5.4",
            reasoningEffort: "high",
            approvalMode: "untrusted",
            codexSandboxMode: "danger-full-access",
            character: "Mia",
            characterRoleMarkdown: "",
            characterIconPath: "icon.png",
            characterThemeColors: {
              main: "#000000",
              sub: "#ffffff",
            },
            updatedAt: "2026-03-28T00:00:00.000Z",
            latestMergeRun: null,
          },
        },
      ],
    });

    assert.equal(projection.toneClassName, "running");
    assert.equal(projection.badgeLabel, "1");
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

  // @test-value v1
  // kind = "contract"
  // claim = "context paneの既定循環はRoot WorkItem tabを含むcanonical tab順を前後どちらにも維持する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#6. UI" }
  // failure_mode = "keyboard循環でWorkItem tabを飛ばすか逆方向の終端が旧Companion tabへ固定される"
  // scope = "session-ui-projection context pane tab order"
  // lifecycle = "permanent"
  // distinction = "available subsetではなく全command paneのcanonical wrap-around順を検証する"
  // @end-test-value
  it("cycleContextPaneTab は利用可能な command pane を循環する", () => {
    assert.equal(cycleContextPaneTab("latest-command", 1), "messages");
    assert.equal(cycleContextPaneTab("latest-command", -1), "work-item");
  });

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
    assert.deepEqual(resolveAvailableContextPaneTabs({ isCopilotSession: false, hasCompanionGroupMonitor: true }), [
      "latest-command",
      "companion-group",
    ]);
  });

  it("cycleContextPaneTab は利用可能 tab だけを循環する", () => {
    const availableTabs = resolveAvailableContextPaneTabs({ isCopilotSession: false });
    assert.equal(cycleContextPaneTab("latest-command", 1, availableTabs), "latest-command");
    assert.equal(cycleContextPaneTab("latest-command", -1, availableTabs), "latest-command");
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "Messages tabはcapabilityを明示的に有効化したSession Windowだけへ追加する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md" }
  // failure_mode = "対応しないWindowに空または操作不能なMessages tabを表示する"
  // scope = "session-context-pane-messages-tab-capability"
  // lifecycle = "permanent"
  // @end-test-value
  it("Messages tab は明示的に有効化したSession Windowだけへ追加される", () => {
    assert.deepEqual(resolveAvailableContextPaneTabs({
      isCopilotSession: true,
      includeMessages: true,
      hasReasoningCapability: true,
      hasCompanionGroupMonitor: true,
    }), [
      "latest-command",
      "messages",
      "reasoning",
      "tasks",
      "companion-group",
    ]);
    assert.deepEqual(resolveAvailableContextPaneTabs({ isCopilotSession: true }), [
      "latest-command",
      "tasks",
    ]);
    assert.equal(contextPaneTabLabel("messages"), "Messages");
    assert.equal(cycleContextPaneTab("latest-command", 1, ["latest-command", "messages"]), "messages");
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "Glossary tabはAgent Sessionの明示capabilityでだけ既存right pane順へ追加する"
  // oracle = { type = "contract", ref = "docs/features/repository-glossary.md" }
  // failure_mode = "非対応SessionへGlossary tabが出る、または既存tab順を壊す"
  // scope = "session-context-pane-glossary-tab-capability"
  // lifecycle = "permanent"
  // @end-test-value
  it("Glossary tabはAgent Sessionで明示的に有効化し、既存right pane順へ追加する", () => {
    assert.deepEqual(resolveAvailableContextPaneTabs({
      isCopilotSession: false,
      includeMessages: true,
      includeGlossary: true,
    }), ["latest-command", "messages", "glossary"]);
    assert.equal(contextPaneTabLabel("glossary"), "Glossary");
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "Glossary tabはloading・missing・emptyを含むprojection state間で同じtab identityを維持する"
  // oracle = { type = "contract", ref = "docs/features/repository-glossary.md" }
  // failure_mode = "データ状態の変化でtabが消失・再配置され選択状態が不安定になる"
  // scope = "session-context-pane-glossary-tab-state"
  // lifecycle = "permanent"
  // @end-test-value
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
