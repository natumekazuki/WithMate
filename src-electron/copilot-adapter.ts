import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  CopilotClient,
  approveAll,
  type CopilotSession,
  type PermissionHandler,
  type MessageOptions,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";

import type {
  AuditLogOperation,
  AuditLogUsage,
  AuditTransportPayload,
  LiveApprovalRequest,
  LiveRunStep,
  ProviderQuotaSnapshot,
  ProviderQuotaTelemetry,
  Session,
  SessionContextTelemetry,
  SessionMemoryDelta,
} from "../src/app-state.js";
import { getProviderAppSettings } from "../src/provider-settings-state.js";
import { normalizeApprovalMode } from "../src/approval-mode.js";
import { resolveModelSelection, type ResolvedModelSelection } from "../src/model-catalog.js";
import { buildArtifactFromOperations } from "./provider-artifact.js";
import { composeProviderPrompt, isCanceledProviderMessage } from "./provider-prompt.js";
import {
  ProviderTurnError,
  type ExtractSessionMemoryResult,
  type ExtractSessionMemoryInput,
  type ProviderPromptComposition,
  type ProviderTurnAdapter,
  type RunSessionTurnInput,
  type RunSessionTurnProgressHandler,
  type RunSessionTurnResult,
  type RunCharacterReflectionInput,
  type RunCharacterReflectionResult,
} from "./provider-runtime.js";
import { parseCharacterReflectionOutputText } from "./character-reflection.js";
import { parseSessionMemoryDeltaText } from "./session-memory-extraction.js";
import {
  captureWorkspaceSnapshot,
  type SnapshotCaptureStats,
  type WorkspaceSnapshot,
} from "./snapshot-ignore.js";
import { normalizeAllowedAdditionalDirectories } from "./additional-directories.js";
import { resolveSessionCustomAgentConfigs } from "./custom-agent-discovery.js";

type CachedCopilotSession = {
  session: CopilotSession;
  settingsKey: string;
};

type CopilotCommandStepState = {
  stepId: string;
  summary: string;
  details?: string;
  status: LiveRunStep["status"];
};

type CopilotStableRawItem = {
  type: string;
  timestamp?: string;
  data?: Record<string, unknown>;
};

type CopilotTurnStreamState = {
  liveSteps: Map<string, LiveRunStep>;
  permissionToStepId: Map<string, string>;
  toolNamesByCallId: Map<string, string>;
  events: SessionEvent[];
  assistantText: string;
  assistantMessages: string[];
  assistantDraft: string;
  usage: AuditLogUsage | null;
  streamErrorMessage: string;
};

const COPILOT_SHELL_TOOL_NAMES = new Set(["shell", "powershell", "bash", "terminal"]);
const COPILOT_MUTATING_TOOL_NAMES = new Set(["create", "write", "edit", "replace", "insert", "move", "rename", "delete", "remove"]);
const COPILOT_DROPPED_RAW_EVENT_TYPES = new Set([
  "pending_messages.modified",
  "function",
  "hook.start",
  "hook.end",
  "session.tools_updated",
  "session.usage_info",
  "assistant.intent",
  "assistant.reasoning",
  "assistant.turn_start",
  "assistant.turn_end",
  "session.info",
]);

const require = createRequire(import.meta.url);

export function buildCopilotClientEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Copilot SDK は child CLI の stderr を bootstrap failure 扱いするため、
  // Node.js の ExperimentalWarning だけで false error にならないように抑止する。
  return {
    ...baseEnv,
    NODE_NO_WARNINGS: "1",
  };
}

export function resolveNativeCopilotPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "win32") {
    if (arch === "x64") {
      return "@github/copilot-win32-x64";
    }

    if (arch === "arm64") {
      return "@github/copilot-win32-arm64";
    }
  }

  if (platform === "darwin") {
    if (arch === "x64") {
      return "@github/copilot-darwin-x64";
    }

    if (arch === "arm64") {
      return "@github/copilot-darwin-arm64";
    }
  }

  if (platform === "linux") {
    if (arch === "x64") {
      return "@github/copilot-linux-x64";
    }

    if (arch === "arm64") {
      return "@github/copilot-linux-arm64";
    }
  }

  return null;
}

export function resolveCopilotCliPath(
  resolvePackagePath: (specifier: string) => string = require.resolve,
  fileExists: (candidate: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const nativePackageName = resolveNativeCopilotPackageName(platform, arch);
  if (nativePackageName) {
    try {
      const candidate = resolvePackagePath(nativePackageName);
      if (fileExists(candidate)) {
        return candidate;
      }
    } catch {
      // fallback below
    }
  }

  const commandFileName = platform === "win32" ? "copilot.cmd" : "copilot";
  const localNodeModulesCommand = path.resolve(process.cwd(), "node_modules", ".bin", commandFileName);
  if (fileExists(localNodeModulesCommand)) {
    return localNodeModulesCommand;
  }

  return commandFileName;
}

function buildCopilotClientKeyFromAppSettings(providerId: string, appSettings: RunSessionTurnInput["appSettings"]): string {
  const codingApiKey = getProviderAppSettings(appSettings, providerId).apiKey.trim();
  return JSON.stringify([providerId, codingApiKey || null]);
}

function buildCopilotClientKey(providerId: string, input: RunSessionTurnInput): string {
  return buildCopilotClientKeyFromAppSettings(providerId, input.appSettings);
}

export function isRecoverableCopilotConnectionErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("connection is closed.")
    || normalized.includes("cli server exited unexpectedly with code 0")
    || normalized.includes("cli server exited with code 0");
}

function hasMeaningfulPartialResult(partialResult: RunSessionTurnResult): boolean {
  return partialResult.assistantText.trim().length > 0
    || partialResult.operations.length > 0
    || partialResult.usage !== null
    || (partialResult.rawItemsJson.trim().length > 0 && partialResult.rawItemsJson.trim() !== "[]");
}

export function shouldRetryCopilotTurn(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!isRecoverableCopilotConnectionErrorMessage(message)) {
    return false;
  }

  if (!(error instanceof ProviderTurnError)) {
    return true;
  }

  return !error.canceled && !hasMeaningfulPartialResult(error.partialResult);
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toAuditUsageFromCopilot(data: { inputTokens?: number; cacheReadTokens?: number; outputTokens?: number }): AuditLogUsage | null {
  if (
    typeof data.inputTokens !== "number"
    && typeof data.cacheReadTokens !== "number"
    && typeof data.outputTokens !== "number"
  ) {
    return null;
  }

  return {
    inputTokens: data.inputTokens ?? 0,
    cachedInputTokens: data.cacheReadTokens ?? 0,
    outputTokens: data.outputTokens ?? 0,
  };
}

function createCopilotTurnStreamState(): CopilotTurnStreamState {
  return {
    liveSteps: new Map<string, LiveRunStep>(),
    permissionToStepId: new Map<string, string>(),
    toolNamesByCallId: new Map<string, string>(),
    events: [],
    assistantText: "",
    assistantMessages: [],
    assistantDraft: "",
    usage: null,
    streamErrorMessage: "",
  };
}

function updateCopilotCommandStep(state: CopilotTurnStreamState, nextState: CopilotCommandStepState): void {
  state.liveSteps.set(nextState.stepId, {
    id: nextState.stepId,
    type: "command_execution",
    summary: nextState.summary,
    details: nextState.details,
    status: nextState.status,
  });
}

function applyCopilotTurnEvent(args: {
  event: SessionEvent;
  state: CopilotTurnStreamState;
  providerId: string;
  sessionId: string;
  workspacePath: string;
  onProviderQuotaTelemetry?: RunSessionTurnInput["onProviderQuotaTelemetry"];
  onSessionContextTelemetry?: RunSessionTurnInput["onSessionContextTelemetry"];
}): void {
  const { event, state, providerId, sessionId, workspacePath } = args;
  state.events.push(event);

  switch (event.type) {
    case "assistant.message_delta":
    case "assistant.message": {
      const nextAssistantState = applyCopilotAssistantEvent(state.assistantMessages, state.assistantDraft, event);
      state.assistantMessages = nextAssistantState.messages;
      state.assistantDraft = nextAssistantState.draft;
      state.assistantText = nextAssistantState.assistantText;
      break;
    }
    case "assistant.usage":
      state.usage = toAuditUsageFromCopilot(event.data);
      if (args.onProviderQuotaTelemetry) {
        const telemetry = buildCopilotProviderQuotaTelemetry(
          providerId,
          event.data.quotaSnapshots,
          event.timestamp,
        );
        if (telemetry) {
          void args.onProviderQuotaTelemetry(telemetry);
        }
      }
      break;
    case "session.usage_info":
      if (args.onSessionContextTelemetry) {
        void args.onSessionContextTelemetry(
          buildCopilotSessionContextTelemetry(
            providerId,
            sessionId,
            event.data,
            event.timestamp,
          ),
        );
      }
      break;
    case "session.error":
      state.streamErrorMessage = event.data.message;
      break;
    case "permission.requested": {
      const request = event.data.permissionRequest;
      const summary = buildCopilotPermissionSummary(request, workspacePath);
      if (summary) {
        const stepId = request.toolCallId ?? event.data.requestId;
        state.permissionToStepId.set(event.data.requestId, stepId);
        if (request.kind === "shell") {
          state.toolNamesByCallId.set(stepId, "shell");
        }
        updateCopilotCommandStep(state, {
          stepId,
          summary,
          details: request.kind === "shell" ? request.warning : undefined,
          status: "pending",
        });
      }
      break;
    }
    case "permission.completed": {
      const stepId = state.permissionToStepId.get(event.data.requestId);
      if (!stepId) {
        break;
      }

      const current = state.liveSteps.get(stepId);
      if (!current) {
        break;
      }

      updateCopilotCommandStep(state, {
        stepId,
        summary: current.summary,
        details: appendDetail(current.details, `permission: ${event.data.result.kind}`),
        status: event.data.result.kind === "approved" ? "in_progress" : "failed",
      });
      break;
    }
    case "tool.execution_start":
      state.toolNamesByCallId.set(event.data.toolCallId, event.data.toolName);
      if (isCopilotVisibleToolName(event.data.toolName)) {
        const current = state.liveSteps.get(event.data.toolCallId);
        updateCopilotCommandStep(state, {
          stepId: event.data.toolCallId,
          summary:
            current?.summary ?? buildCopilotToolSummary(event.data.toolName, event.data.arguments, workspacePath),
          details: current?.details,
          status: "in_progress",
        });
      }
      break;
    case "tool.execution_partial_result": {
      const current = state.liveSteps.get(event.data.toolCallId);
      if (!current) {
        break;
      }

      updateCopilotCommandStep(state, {
        stepId: current.id,
        summary: current.summary,
        details: appendDetail(current.details, event.data.partialOutput),
        status: "in_progress",
      });
      break;
    }
    case "tool.execution_complete":
      if (
        state.liveSteps.has(event.data.toolCallId)
        || isCopilotVisibleToolName(state.toolNamesByCallId.get(event.data.toolCallId) ?? "")
      ) {
        const current = state.liveSteps.get(event.data.toolCallId);
        const toolName = state.toolNamesByCallId.get(event.data.toolCallId) ?? "shell";
        updateCopilotCommandStep(state, {
          stepId: event.data.toolCallId,
          summary: current?.summary ?? buildCopilotToolSummary(toolName, undefined, workspacePath),
          details: appendDetail(current?.details, extractToolExecutionDetails(event)),
          status: event.data.success ? "completed" : "failed",
        });
      }
      break;
    default:
      break;
  }
}

type CopilotQuotaSnapshotLike = {
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage: number;
  overage?: number;
  overageAllowedWithExhaustedQuota?: boolean;
  resetDate?: string;
};

function normalizeQuotaRemainingPercentage(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }

  if (value >= 0 && value <= 1) {
    return value * 100;
  }

  return value;
}

export function toProviderQuotaSnapshots(
  snapshots: Record<string, CopilotQuotaSnapshotLike> | null | undefined,
): ProviderQuotaSnapshot[] {
  if (!snapshots) {
    return [];
  }

  return Object.entries(snapshots)
    .map(([quotaKey, snapshot]) => ({
      quotaKey,
      entitlementRequests: snapshot.entitlementRequests,
      usedRequests: snapshot.usedRequests,
      remainingPercentage: normalizeQuotaRemainingPercentage(snapshot.remainingPercentage),
      overage: snapshot.overage ?? 0,
      overageAllowedWithExhaustedQuota: snapshot.overageAllowedWithExhaustedQuota ?? false,
      resetDate: snapshot.resetDate,
    }))
    .sort((left, right) => left.quotaKey.localeCompare(right.quotaKey));
}

export function buildCopilotProviderQuotaTelemetry(
  providerId: string,
  snapshots: Record<string, CopilotQuotaSnapshotLike> | null | undefined,
  updatedAt: string,
): ProviderQuotaTelemetry | null {
  const normalizedSnapshots = toProviderQuotaSnapshots(snapshots);
  if (normalizedSnapshots.length === 0) {
    return null;
  }

  return {
    provider: providerId,
    updatedAt,
    snapshots: normalizedSnapshots,
  };
}

export function buildCopilotSessionContextTelemetry(
  providerId: string,
  sessionId: string,
  data: {
    tokenLimit: number;
    currentTokens: number;
    messagesLength: number;
    systemTokens?: number;
    conversationTokens?: number;
    toolDefinitionsTokens?: number;
  },
  updatedAt: string,
): SessionContextTelemetry {
  return {
    provider: providerId,
    sessionId,
    updatedAt,
    tokenLimit: data.tokenLimit,
    currentTokens: data.currentTokens,
    messagesLength: data.messagesLength,
    systemTokens: data.systemTokens,
    conversationTokens: data.conversationTokens,
    toolDefinitionsTokens: data.toolDefinitionsTokens,
  };
}

function appendDetail(current: string | undefined, next: string | undefined): string | undefined {
  if (!next?.trim()) {
    return current;
  }

  if (!current?.trim()) {
    return next;
  }

  if (current.includes(next)) {
    return current;
  }

  return `${current}\n${next}`;
}

function appendUniqueMessage(messages: string[], nextMessage: string): string[] {
  const normalized = nextMessage.trim();
  if (!normalized) {
    return messages;
  }

  if (messages[messages.length - 1] === normalized) {
    return messages;
  }

  return [...messages, normalized];
}

function buildAssistantText(messages: string[], draft: string): string {
  const parts = [...messages];
  const normalizedDraft = draft.trim();
  if (normalizedDraft) {
    parts.push(normalizedDraft);
  }

  return parts.join("\n\n");
}

export function applyCopilotAssistantEvent(
  messages: string[],
  draft: string,
  event:
    | Extract<SessionEvent, { type: "assistant.message_delta" }>
    | Extract<SessionEvent, { type: "assistant.message" }>,
): { messages: string[]; draft: string; assistantText: string } {
  if (event.data.parentToolCallId) {
    return {
      messages,
      draft,
      assistantText: buildAssistantText(messages, draft),
    };
  }

  if (event.type === "assistant.message_delta") {
    const nextDraft = draft + event.data.deltaContent;
    return {
      messages,
      draft: nextDraft,
      assistantText: buildAssistantText(messages, nextDraft),
    };
  }

  const content = event.data.content.trim();
  if (!content) {
    return {
      messages,
      draft: "",
      assistantText: buildAssistantText(messages, ""),
    };
  }

  const draftTrimmed = draft.trim();
  const finalizedMessages = draftTrimmed && draftTrimmed === content
    ? appendUniqueMessage(messages, draftTrimmed)
    : appendUniqueMessage(messages, content);

  return {
    messages: finalizedMessages,
    draft: "",
    assistantText: buildAssistantText(finalizedMessages, ""),
  };
}

function normalizeCopilotToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function getStringArgument(argumentsValue: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!argumentsValue) {
    return null;
  }

  for (const key of keys) {
    const candidate = argumentsValue[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function compactCopilotTargetPath(targetPath: string, workspacePath: string): string {
  const normalizedTarget = targetPath.replace(/\\/g, "/");
  const normalizedWorkspace = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const relativePath = path.posix.relative(normalizedWorkspace, normalizedTarget);

  if (relativePath && !relativePath.startsWith("../") && !path.posix.isAbsolute(relativePath)) {
    return relativePath;
  }

  return normalizedTarget;
}

function inferCopilotWriteAction(intention: string | undefined): string {
  const normalized = intention?.trim().toLowerCase() ?? "";
  if (normalized.includes("create")) {
    return "create";
  }

  if (normalized.includes("delete") || normalized.includes("remove")) {
    return "delete";
  }

  if (normalized.includes("rename") || normalized.includes("move")) {
    return "move";
  }

  if (normalized.includes("replace") || normalized.includes("edit") || normalized.includes("modify") || normalized.includes("update")) {
    return "edit";
  }

  return "write";
}

export function isCopilotVisibleToolName(toolName: string): boolean {
  const normalized = normalizeCopilotToolName(toolName);
  return COPILOT_SHELL_TOOL_NAMES.has(normalized) || COPILOT_MUTATING_TOOL_NAMES.has(normalized);
}

export function buildCopilotToolSummary(
  toolName: string,
  argumentsValue: Record<string, unknown> | undefined,
  workspacePath: string,
): string {
  const normalizedToolName = normalizeCopilotToolName(toolName);
  if (COPILOT_SHELL_TOOL_NAMES.has(normalizedToolName)) {
    return extractShellCommandFromArguments(argumentsValue) ?? normalizedToolName;
  }

  const targetPath = getStringArgument(argumentsValue, ["path", "filePath", "fileName", "target", "targetPath", "destination", "destinationPath"]);
  if (normalizedToolName === "move" || normalizedToolName === "rename") {
    const sourcePath = getStringArgument(argumentsValue, ["source", "sourcePath", "from", "oldPath"]);
    const destinationPath = getStringArgument(argumentsValue, ["destination", "destinationPath", "to", "newPath", "path"]);
    const formattedSource = sourcePath ? compactCopilotTargetPath(sourcePath, workspacePath) : null;
    const formattedDestination = destinationPath ? compactCopilotTargetPath(destinationPath, workspacePath) : null;
    if (formattedSource && formattedDestination) {
      return `${normalizedToolName} ${formattedSource} -> ${formattedDestination}`;
    }

    if (formattedDestination) {
      return `${normalizedToolName} ${formattedDestination}`;
    }
  }

  if (targetPath) {
    return `${normalizedToolName} ${compactCopilotTargetPath(targetPath, workspacePath)}`;
  }

  return normalizedToolName;
}

function shouldDropCopilotRawEvent(event: SessionEvent): boolean {
  if ("ephemeral" in event && event.ephemeral === true) {
    return true;
  }

  const eventType = String(event.type);
  return eventType.endsWith("_delta") || COPILOT_DROPPED_RAW_EVENT_TYPES.has(eventType);
}

type CopilotPermissionRequestLike = {
  kind: string;
  toolCallId?: string;
  warning?: string;
  fullCommandText?: unknown;
  fileName?: unknown;
  intention?: unknown;
};

function buildCopilotPermissionSummary(request: CopilotPermissionRequestLike, workspacePath: string): string | null {
  if (request.kind === "shell" && typeof request.fullCommandText === "string" && request.fullCommandText.trim()) {
    return request.fullCommandText.trim();
  }

  if (request.kind === "write" && typeof request.fileName === "string" && request.fileName.trim()) {
    const action = inferCopilotWriteAction(typeof request.intention === "string" ? request.intention : undefined);
    return `${action} ${compactCopilotTargetPath(request.fileName, workspacePath)}`;
  }

  return null;
}

function buildCopilotApprovalTitle(kind: string): string {
  switch (kind) {
    case "shell":
      return "Shell command の承認が必要";
    case "write":
      return "ファイル変更の承認が必要";
    case "mcp":
      return "MCP tool の承認が必要";
    case "custom-tool":
      return "Custom tool の承認が必要";
    case "url":
      return "URL fetch の承認が必要";
    case "read":
      return "ファイル参照の承認が必要";
    default:
      return "操作の承認が必要";
  }
}

function buildCopilotApprovalDetails(request: CopilotPermissionRequestLike, workspacePath: string): string | undefined {
  const detailParts: string[] = [];

  if (request.kind === "write" && typeof request.intention === "string" && request.intention.trim()) {
    detailParts.push(`intent: ${request.intention.trim()}`);
  }

  if (request.kind === "write" && typeof request.fileName === "string" && request.fileName.trim()) {
    detailParts.push(`target: ${compactCopilotTargetPath(request.fileName, workspacePath)}`);
  }

  if (request.kind !== "shell" && typeof request.fullCommandText === "string" && request.fullCommandText.trim()) {
    detailParts.push(request.fullCommandText.trim());
  }

  return detailParts.length > 0 ? detailParts.join("\n") : undefined;
}

function buildCopilotApprovalRequest(
  request: PermissionRequest,
  providerId: string,
  workspacePath: string,
): LiveApprovalRequest {
  const requestLike = request as PermissionRequest & CopilotPermissionRequestLike;
  const summary = buildCopilotPermissionSummary(requestLike, workspacePath) ?? request.kind;
  const warning = typeof requestLike.warning === "string" && requestLike.warning.trim()
    ? requestLike.warning.trim()
    : undefined;

  return {
    requestId: request.toolCallId?.trim() || `${request.kind}:${summary}`,
    provider: providerId,
    kind: request.kind,
    title: buildCopilotApprovalTitle(request.kind),
    summary,
    details: buildCopilotApprovalDetails(requestLike, workspacePath),
    warning,
    decisionMode: "direct-decision",
  };
}

export function buildCopilotMessageAttachments(
  attachments: RunSessionTurnInput["attachments"],
): NonNullable<MessageOptions["attachments"]> {
  return attachments.map((attachment) => ({
    type: attachment.kind === "folder" ? "directory" : "file",
    path: attachment.absolutePath,
    displayName: attachment.displayPath,
  }));
}

export function buildCopilotSystemMessage(
  prompt: ProviderPromptComposition,
): SessionConfig["systemMessage"] | undefined {
  if (!prompt.systemBodyText.trim()) {
    return undefined;
  }

  return {
    mode: "append",
    content: prompt.systemBodyText,
  };
}

function buildCopilotTransportPayload(
  prompt: ProviderPromptComposition,
  attachments: NonNullable<MessageOptions["attachments"]>,
): AuditTransportPayload {
  const fields = [];

  if (prompt.systemBodyText.trim()) {
    fields.push({
      label: "session.systemMessage",
      value: prompt.systemBodyText,
    });
  }

  fields.push({
    label: "session.send.prompt",
    value: prompt.inputBodyText,
  });

  if (attachments.length > 0) {
    fields.push({
      label: "session.send.attachments",
      value: attachments
        .map((attachment) => {
          const fallbackName = "path" in attachment
            ? attachment.path
            : "filePath" in attachment
              ? attachment.filePath
              : "selection";
          return `${attachment.type}: ${attachment.displayName ?? fallbackName}`;
        })
        .join("\n"),
    });
  }

  return {
    summary: "Copilot session config + session.send payload",
    fields,
  };
}

export function buildCopilotStableRawItems(
  events: SessionEvent[],
  workspacePath: string,
): CopilotStableRawItem[] {
  const stableItems: CopilotStableRawItem[] = [];
  const toolNamesByCallId = new Map<string, string>();

  for (const event of events) {
    if (shouldDropCopilotRawEvent(event)) {
      continue;
    }

    switch (event.type) {
      case "user.message":
        stableItems.push({
          type: event.type,
          timestamp: event.timestamp,
          data: {
            content: event.data.content,
          },
        });
        break;
      case "assistant.message":
        stableItems.push({
          type: event.type,
          timestamp: event.timestamp,
          data: {
            content: event.data.content,
            parentToolCallId: event.data.parentToolCallId ?? null,
          },
        });
        break;
      case "assistant.usage":
        stableItems.push({
          type: event.type,
          timestamp: event.timestamp,
          data: {
            inputTokens: event.data.inputTokens ?? null,
            cacheReadTokens: event.data.cacheReadTokens ?? null,
            outputTokens: event.data.outputTokens ?? null,
          },
        });
        break;
      case "session.error":
        stableItems.push({
          type: event.type,
          timestamp: event.timestamp,
          data: {
            message: event.data.message,
          },
        });
        break;
      case "session.idle":
        stableItems.push({
          type: event.type,
          timestamp: event.timestamp,
        });
        break;
      case "permission.requested": {
        const summary = buildCopilotPermissionSummary(event.data.permissionRequest, workspacePath);
        stableItems.push({
          type: event.type,
          timestamp: event.timestamp,
          data: {
            requestId: event.data.requestId,
            kind: event.data.permissionRequest.kind,
            summary: summary ?? event.data.permissionRequest.kind,
          },
        });
        break;
      }
      case "permission.completed":
        stableItems.push({
          type: event.type,
          timestamp: event.timestamp,
          data: {
            requestId: event.data.requestId,
            resultKind: event.data.result.kind,
          },
        });
        break;
      case "tool.execution_start":
        toolNamesByCallId.set(event.data.toolCallId, event.data.toolName);
        stableItems.push({
          type: event.type,
          timestamp: event.timestamp,
          data: {
            toolCallId: event.data.toolCallId,
            toolName: event.data.toolName,
            summary: buildCopilotToolSummary(event.data.toolName, event.data.arguments, workspacePath),
          },
        });
        break;
      case "tool.execution_complete": {
        const toolName = toolNamesByCallId.get(event.data.toolCallId) ?? null;
        stableItems.push({
          type: event.type,
          timestamp: event.timestamp,
          data: {
            toolCallId: event.data.toolCallId,
            toolName,
            success: event.data.success,
            content: event.data.result?.content ?? null,
            errorMessage: event.data.error?.message ?? null,
          },
        });
        break;
      }
      default:
        stableItems.push({
          type: event.type,
          timestamp: event.timestamp,
        });
        break;
    }
  }

  return stableItems;
}

function extractShellCommandFromArguments(argumentsValue: Record<string, unknown> | undefined): string | null {
  if (!argumentsValue) {
    return null;
  }

  const directCommand =
    (typeof argumentsValue.command === "string" ? argumentsValue.command : null) ??
    (typeof argumentsValue.commandText === "string" ? argumentsValue.commandText : null) ??
    (typeof argumentsValue.fullCommandText === "string" ? argumentsValue.fullCommandText : null) ??
    (typeof argumentsValue.input === "string" ? argumentsValue.input : null);

  if (directCommand?.trim()) {
    return directCommand.trim();
  }

  return stringifyUnknown(argumentsValue) ?? null;
}

function extractToolExecutionDetails(event: Extract<SessionEvent, { type: "tool.execution_complete" }>): string | undefined {
  const detailParts: string[] = [];
  const result = event.data.result;

  if (typeof result?.detailedContent === "string" && result.detailedContent.trim()) {
    detailParts.push(result.detailedContent);
  } else if (typeof result?.content === "string" && result.content.trim()) {
    detailParts.push(result.content);
  }

  for (const content of result?.contents ?? []) {
    if (content.type === "text" && content.text.trim()) {
      detailParts.push(content.text);
      continue;
    }

    if (content.type === "terminal" && content.text.trim()) {
      const header = typeof content.cwd === "string" && content.cwd.trim() ? `cwd: ${content.cwd}` : null;
      const exitCode = typeof content.exitCode === "number" ? `exit code: ${content.exitCode}` : null;
      detailParts.push([header, content.text, exitCode].filter((part) => part && part.trim()).join("\n"));
    }
  }

  if (event.data.error?.message?.trim()) {
    detailParts.push(event.data.error.message);
  }

  const normalized = detailParts.map((part) => part.trim()).filter((part) => part.length > 0);
  return normalized.length > 0 ? normalized.join("\n\n") : undefined;
}

function toCommandOperations(steps: Map<string, LiveRunStep>): AuditLogOperation[] {
  return Array.from(steps.values())
    .filter((step) => step.type === "command_execution")
    .map((step) => ({
      type: "command_execution",
      summary: step.summary,
      details: step.details,
    }));
}

type PermissionDecisionKind =
  | "approved"
  | "denied-by-rules"
  | "denied-no-approval-rule-and-could-not-request-from-user"
  | "denied-interactively-by-user"
  | "denied-by-content-exclusion-policy";

function toPermissionDecision(kind: PermissionDecisionKind): PermissionRequestResult {
  return { kind } as PermissionRequestResult;
}

function isReadOnlyPermissionRequest(request: PermissionRequest): boolean {
  switch (request.kind) {
    case "read":
      return true;
    case "mcp":
      return request.readOnly === true;
    default:
      return false;
  }
}

function buildPermissionHandler(input: RunSessionTurnInput): PermissionHandler {
  switch (normalizeApprovalMode(input.session.approvalMode)) {
    case "allow-all":
      return approveAll;
    case "safety":
      return (request) => (
        isReadOnlyPermissionRequest(request)
          ? toPermissionDecision("approved")
          : toPermissionDecision("denied-by-rules")
      );
    case "provider-controlled":
    default:
      return async (request) => {
        if (isReadOnlyPermissionRequest(request)) {
          return toPermissionDecision("approved");
        }

        if (!input.onApprovalRequest) {
          return toPermissionDecision("denied-no-approval-rule-and-could-not-request-from-user");
        }

        const decision = await input.onApprovalRequest(
          buildCopilotApprovalRequest(request, input.providerCatalog.id, input.session.workspacePath),
        );
        return toPermissionDecision(decision === "approve" ? "approved" : "denied-interactively-by-user");
      };
  }
}

function buildCopilotBootstrapDebugItems(
  input: RunSessionTurnInput,
  cliPath: string,
  phase: string,
  message: string,
): string {
  return JSON.stringify([
    {
      type: "copilot_bootstrap_debug",
      phase,
      message,
      cliPath,
      provider: input.providerCatalog.id,
      model: input.session.model,
      reasoningEffort: input.session.reasoningEffort,
      approvalMode: input.session.approvalMode,
      workspacePath: input.session.workspacePath,
      threadId: input.session.threadId,
      hasApiKey: getProviderAppSettings(input.appSettings, input.providerCatalog.id).apiKey.trim().length > 0,
      useLoggedInUser: getProviderAppSettings(input.appSettings, input.providerCatalog.id).apiKey.trim().length === 0,
    },
  ], null, 2);
}

function logCopilotRuntime(message: string, details: Record<string, unknown>): void {
  console.warn(`[copilot] ${message} ${JSON.stringify(details)}`);
}

async function emitLiveState(
  handler: RunSessionTurnProgressHandler | undefined,
  sessionId: string,
  threadId: string | null,
  steps: Map<string, LiveRunStep>,
  assistantText: string,
  usage: AuditLogUsage | null,
  errorMessage: string,
): Promise<void> {
  if (!handler) {
    return;
  }

  await handler({
    sessionId,
    threadId: threadId ?? "",
    assistantText,
    steps: Array.from(steps.values()),
    usage,
    errorMessage,
    approvalRequest: null,
  });
}

function waitForCopilotSessionCompletion(
  session: CopilotSession,
  signal: AbortSignal | undefined,
): { wait: Promise<void>; dispose: () => void } {
  let settled = false;
  let resolveWait!: () => void;
  let rejectWait!: (error: Error) => void;

  const wait = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  const settle = (handler: () => void) => {
    if (settled) {
      return;
    }

    settled = true;
    handler();
  };

  const unsubscribe = session.on((event) => {
    if (event.type === "session.idle") {
      settle(() => resolveWait());
      return;
    }

    if (event.type === "session.error") {
      const error = new Error(event.data.message);
      error.stack = event.data.stack;
      settle(() => rejectWait(error));
    }
  });

  const handleAbort = () => {
    settle(() => rejectWait(new Error("Abort requested")));
  };

  signal?.addEventListener("abort", handleAbort, { once: true });

  return {
    wait,
    dispose: () => {
      signal?.removeEventListener("abort", handleAbort);
      unsubscribe();
    },
  };
}

export class CopilotAdapter implements ProviderTurnAdapter {
  private readonly clients = new Map<string, CopilotClient>();
  private readonly sessions = new Map<string, CachedCopilotSession>();

  composePrompt(input: RunSessionTurnInput): ProviderPromptComposition {
    return composeProviderPrompt(input);
  }

  invalidateSessionThread(sessionId: string): void {
    void this.disposeSessionCache(sessionId);
  }

  invalidateAllSessionThreads(): void {
    for (const sessionId of this.sessions.keys()) {
      void this.disposeSessionCache(sessionId);
    }
  }

  async getProviderQuotaTelemetry({
    providerId,
    appSettings,
  }: {
    providerId: string;
    appSettings: RunSessionTurnInput["appSettings"];
  }): Promise<ProviderQuotaTelemetry | null> {
    return this.fetchProviderQuotaTelemetry(providerId, appSettings);
  }

  async extractSessionMemoryDelta(input: ExtractSessionMemoryInput): Promise<ExtractSessionMemoryResult> {
    const result = await this.runBackgroundPrompt(input, parseSessionMemoryDeltaText);
    return {
      threadId: result.threadId,
      rawText: result.rawText,
      delta: result.output,
      rawItemsJson: result.rawItemsJson,
      usage: result.usage,
      providerQuotaTelemetry: result.providerQuotaTelemetry,
    };
  }

  async runCharacterReflection(input: RunCharacterReflectionInput): Promise<RunCharacterReflectionResult> {
    const result = await this.runBackgroundPrompt(input, parseCharacterReflectionOutputText);
    return {
      threadId: result.threadId,
      rawText: result.rawText,
      output: result.output,
      rawItemsJson: result.rawItemsJson,
      usage: result.usage,
      providerQuotaTelemetry: result.providerQuotaTelemetry,
    };
  }

  private getClient(providerId: string, input: RunSessionTurnInput): { client: CopilotClient; clientKey: string } {
    const codingApiKey = getProviderAppSettings(input.appSettings, providerId).apiKey.trim();
    const clientKey = buildCopilotClientKey(providerId, input);
    const cached = this.clients.get(clientKey);
    if (cached) {
      return { client: cached, clientKey };
    }

    const cliPath = resolveCopilotCliPath();
    const client = new CopilotClient({
      cliPath,
      env: buildCopilotClientEnv(process.env),
      ...(codingApiKey ? { githubToken: codingApiKey, useLoggedInUser: false } : {}),
    });
    this.clients.set(clientKey, client);
    return { client, clientKey };
  }

  private getOrCreateClientByAppSettings(providerId: string, appSettings: RunSessionTurnInput["appSettings"]): CopilotClient {
    const clientKey = buildCopilotClientKeyFromAppSettings(providerId, appSettings);
    const cached = this.clients.get(clientKey);
    if (cached) {
      return cached;
    }

    const apiKey = getProviderAppSettings(appSettings, providerId).apiKey.trim();
    const client = new CopilotClient({
      cliPath: resolveCopilotCliPath(),
      env: buildCopilotClientEnv(process.env),
      ...(apiKey ? { githubToken: apiKey, useLoggedInUser: false } : {}),
    });
    this.clients.set(clientKey, client);
    return client;
  }

  private buildBackgroundSessionConfig(input: ExtractSessionMemoryInput | RunCharacterReflectionInput): SessionConfig {
    const denyAllPermissions: PermissionHandler = () => ({ kind: "denied-interactively-by-user" });
    return {
      model: input.model,
      reasoningEffort: input.reasoningEffort === "minimal" ? "low" : input.reasoningEffort,
      workingDirectory: input.session.workspacePath,
      streaming: false,
      onPermissionRequest: denyAllPermissions,
      systemMessage: {
        mode: "append",
        content: input.prompt.systemText,
      },
    };
  }

  private async runBackgroundPrompt<TOutput>(
    input: ExtractSessionMemoryInput | RunCharacterReflectionInput,
    parse: (rawText: string) => TOutput | null,
  ): Promise<{
    threadId: string | null;
    rawText: string;
    output: TOutput | null;
    rawItemsJson: string;
    usage: AuditLogUsage | null;
    providerQuotaTelemetry: ProviderQuotaTelemetry | null;
  }> {
    const client = this.getOrCreateClientByAppSettings(input.session.provider, input.appSettings);
    await client.start();
    let usage: AuditLogUsage | null = null;

    const extractionSession = await client.createSession(this.buildBackgroundSessionConfig(input));
    const unsubscribeUsage = extractionSession.on("assistant.usage", (event) => {
      usage = toAuditUsageFromCopilot(event.data);
    });

    try {
      const response = await extractionSession.sendAndWait({ prompt: input.prompt.userText }, 60_000);
      const rawText = response?.data.content ?? "";
      const providerQuotaTelemetry = await this.fetchProviderQuotaTelemetry(input.session.provider, input.appSettings)
        .catch(() => null);
      return {
        threadId: extractionSession.sessionId,
        rawText,
        output: parse(rawText),
        rawItemsJson: JSON.stringify({
          type: "copilot-background-response",
          sessionId: extractionSession.sessionId,
          content: rawText,
          quotaSnapshots: providerQuotaTelemetry?.snapshots ?? [],
        }, null, 2),
        usage,
        providerQuotaTelemetry,
      };
    } finally {
      unsubscribeUsage();
      await extractionSession.disconnect().catch(() => undefined);
    }
  }

  private async disposeSessionCache(sessionId: string): Promise<void> {
    const cached = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (cached) {
      await cached.session.disconnect().catch(() => undefined);
    }
  }

  private async resetRecoverableConnection(input: RunSessionTurnInput): Promise<void> {
    await this.disposeSessionCache(input.session.id);
    this.clients.delete(buildCopilotClientKey(input.providerCatalog.id, input));
  }

  private buildSessionConfig(
    input: RunSessionTurnInput,
    prompt: ProviderPromptComposition,
    clientKey: string,
  ): {
    config: SessionConfig;
    selection: ResolvedModelSelection;
    settingsKey: string;
  } {
    const selection = resolveModelSelection(input.providerCatalog, input.session.model, input.session.reasoningEffort);
    const resolvedCustomAgents = resolveSessionCustomAgentConfigs(
      input.session.workspacePath,
      input.session.customAgentName,
    );
    const systemMessage = buildCopilotSystemMessage(prompt);
    const config: SessionConfig = {
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort === "minimal" ? "low" : selection.resolvedReasoningEffort,
      workingDirectory: input.session.workspacePath,
      streaming: true,
      onPermissionRequest: buildPermissionHandler(input),
      ...(systemMessage ? { systemMessage } : {}),
      ...(resolvedCustomAgents.customAgents.length > 0 ? { customAgents: resolvedCustomAgents.customAgents } : {}),
      ...(resolvedCustomAgents.selectedAgentName ? { agent: resolvedCustomAgents.selectedAgentName } : {}),
    };

    return {
      config,
      selection,
      settingsKey: JSON.stringify([
        clientKey,
        config.model,
        config.reasoningEffort,
        config.workingDirectory,
        input.session.approvalMode,
        systemMessage?.mode ?? "",
        systemMessage?.content ?? "",
        input.session.customAgentName,
        resolvedCustomAgents.customAgents.map((agent) => JSON.stringify({
          name: agent.name,
          displayName: agent.displayName ?? "",
          description: agent.description ?? "",
          prompt: agent.prompt,
          tools: agent.tools ?? null,
        })).join("\u001f"),
      ]),
    };
  }

  private async getSession(
    input: RunSessionTurnInput,
    prompt: ProviderPromptComposition,
  ): Promise<{ session: CopilotSession; selection: ResolvedModelSelection }> {
    const { client, clientKey } = this.getClient(input.providerCatalog.id, input);
    const nextSettings = this.buildSessionConfig(input, prompt, clientKey);
    const cached = this.sessions.get(input.session.id);
    if (cached && cached.settingsKey === nextSettings.settingsKey) {
      return {
        session: cached.session,
        selection: nextSettings.selection,
      };
    }

    if (cached) {
      void cached.session.disconnect().catch(() => undefined);
    }

    const session = input.session.threadId.trim()
      ? await client.resumeSession(input.session.threadId, nextSettings.config)
      : await client.createSession(nextSettings.config);

    this.sessions.set(input.session.id, {
      session,
      settingsKey: nextSettings.settingsKey,
    });

    return {
      session,
      selection: nextSettings.selection,
    };
  }

  private async buildTurnResult(
    prompt: ProviderPromptComposition,
    messageAttachments: NonNullable<MessageOptions["attachments"]>,
    threadId: string | null,
    assistantText: string,
    steps: Map<string, LiveRunStep>,
    usage: AuditLogUsage | null,
    events: SessionEvent[],
    workspacePath: string,
    session: Session,
    providerCatalog: RunSessionTurnInput["providerCatalog"],
    selection: ResolvedModelSelection,
    beforeSnapshot: WorkspaceSnapshot,
    beforeSnapshotStats: SnapshotCaptureStats,
    providerQuotaTelemetry: ProviderQuotaTelemetry | null,
  ): Promise<RunSessionTurnResult> {
    const { snapshot: afterSnapshot, stats: afterSnapshotStats } = await captureWorkspaceSnapshot([
      workspacePath,
      ...normalizeAllowedAdditionalDirectories(workspacePath, session.allowedAdditionalDirectories),
    ]);
    const operations = toCommandOperations(steps);
    const artifact = buildArtifactFromOperations({
      session,
      operations,
      usage,
      threadId,
      beforeSnapshot,
      afterSnapshot,
      beforeSnapshotStats,
      afterSnapshotStats,
      providerCatalog,
      selection,
    });

    return {
      threadId,
      assistantText,
      artifact,
      logicalPrompt: prompt.logicalPrompt,
      transportPayload: buildCopilotTransportPayload(prompt, messageAttachments),
      operations,
      rawItemsJson: JSON.stringify(buildCopilotStableRawItems(events, workspacePath), null, 2),
      usage,
      providerQuotaTelemetry,
    };
  }

  private async runSessionTurnOnce(
    input: RunSessionTurnInput,
    prompt: ProviderPromptComposition,
    onProgress?: RunSessionTurnProgressHandler,
  ): Promise<RunSessionTurnResult> {
    const messageAttachments = buildCopilotMessageAttachments(input.attachments);

    const cliPath = resolveCopilotCliPath();
    const { snapshot: beforeSnapshot, stats: beforeSnapshotStats } = await captureWorkspaceSnapshot([
      input.session.workspacePath,
      ...normalizeAllowedAdditionalDirectories(input.session.workspacePath, input.session.allowedAdditionalDirectories),
    ]);
    let session: CopilotSession;
    let selection: ResolvedModelSelection;
    try {
      ({ session, selection } = await this.getSession(input, prompt));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logCopilotRuntime("session bootstrap failed", {
        cliPath,
        provider: input.providerCatalog.id,
        model: input.session.model,
        workspacePath: input.session.workspacePath,
        threadId: input.session.threadId,
        message,
      });
      throw new ProviderTurnError(
        message,
        {
          threadId: input.session.threadId || null,
          assistantText: "",
          logicalPrompt: prompt.logicalPrompt,
          transportPayload: buildCopilotTransportPayload(prompt, messageAttachments),
          operations: [],
          rawItemsJson: buildCopilotBootstrapDebugItems(input, cliPath, "session-bootstrap", message),
          usage: null,
          providerQuotaTelemetry: null,
        },
        Boolean(input.signal?.aborted) || isCanceledProviderMessage(message),
      );
    }
    const streamState = createCopilotTurnStreamState();
    let progressChain = Promise.resolve();
    const scheduleLiveState = () => {
      progressChain = progressChain.then(() =>
        emitLiveState(
          onProgress,
          input.session.id,
          session.sessionId,
          streamState.liveSteps,
          streamState.assistantText,
          streamState.usage,
          streamState.streamErrorMessage,
        ),
      );
      return progressChain;
    };

    await emitLiveState(
      onProgress,
      input.session.id,
      session.sessionId,
      streamState.liveSteps,
      streamState.assistantText,
      streamState.usage,
      streamState.streamErrorMessage,
    );

    const unsubscribe = session.on((event) => {
      applyCopilotTurnEvent({
        event,
        state: streamState,
        providerId: input.providerCatalog.id,
        sessionId: input.session.id,
        workspacePath: input.session.workspacePath,
        onProviderQuotaTelemetry: input.onProviderQuotaTelemetry,
        onSessionContextTelemetry: input.onSessionContextTelemetry,
      });
      void scheduleLiveState();
    });

    const handleAbort = () => {
      void session.abort().catch(() => undefined);
    };

    input.signal?.addEventListener("abort", handleAbort, { once: true });

    try {
      const completion = waitForCopilotSessionCompletion(session, input.signal);
      try {
        await session.send({
          prompt: prompt.inputBodyText,
          ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
        });
        await completion.wait;
      } finally {
        completion.dispose();
      }
      await progressChain;

      if (streamState.streamErrorMessage) {
        const providerQuotaTelemetry = await this.fetchProviderQuotaTelemetry(input.providerCatalog.id, input.appSettings)
          .catch(() => null);
        const partialResult = await this.buildTurnResult(
          prompt,
          messageAttachments,
          session.sessionId,
          streamState.assistantText,
          streamState.liveSteps,
          streamState.usage,
          streamState.events,
          input.session.workspacePath,
          input.session,
          input.providerCatalog,
          selection,
          beforeSnapshot,
          beforeSnapshotStats,
          providerQuotaTelemetry,
        );
        throw new ProviderTurnError(
          streamState.streamErrorMessage,
          partialResult,
          Boolean(input.signal?.aborted) || isCanceledProviderMessage(streamState.streamErrorMessage),
        );
      }

      const providerQuotaTelemetry = await this.fetchProviderQuotaTelemetry(input.providerCatalog.id, input.appSettings)
        .catch(() => null);
      return this.buildTurnResult(
        prompt,
        messageAttachments,
        session.sessionId,
        streamState.assistantText,
        streamState.liveSteps,
        streamState.usage,
        streamState.events,
        input.session.workspacePath,
        input.session,
        input.providerCatalog,
        selection,
        beforeSnapshot,
        beforeSnapshotStats,
        providerQuotaTelemetry,
      );
    } catch (error) {
      if (error instanceof ProviderTurnError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const providerQuotaTelemetry = await this.fetchProviderQuotaTelemetry(input.providerCatalog.id, input.appSettings)
        .catch(() => null);
      const partialResult = await this.buildTurnResult(
        prompt,
        messageAttachments,
        session.sessionId,
        streamState.assistantText,
        streamState.liveSteps,
        streamState.usage,
        streamState.events,
        input.session.workspacePath,
        input.session,
        input.providerCatalog,
        selection,
        beforeSnapshot,
        beforeSnapshotStats,
        providerQuotaTelemetry,
      );
      logCopilotRuntime("turn execution failed", {
        cliPath,
        provider: input.providerCatalog.id,
        model: input.session.model,
        workspacePath: input.session.workspacePath,
        threadId: session.sessionId,
        message,
      });
      throw new ProviderTurnError(
        message,
        partialResult,
        Boolean(input.signal?.aborted) || isCanceledProviderMessage(message),
      );
    } finally {
      unsubscribe();
      input.signal?.removeEventListener("abort", handleAbort);
    }
  }

  async runSessionTurn(input: RunSessionTurnInput, onProgress?: RunSessionTurnProgressHandler): Promise<RunSessionTurnResult> {
    const prompt = this.composePrompt(input);

    try {
      return await this.runSessionTurnOnce(input, prompt, onProgress);
    } catch (error) {
      if (!shouldRetryCopilotTurn(error)) {
        throw error;
      }

      logCopilotRuntime("retrying stale connection", {
        provider: input.providerCatalog.id,
        model: input.session.model,
        workspacePath: input.session.workspacePath,
        threadId: input.session.threadId,
        message: error instanceof Error ? error.message : String(error),
      });
      await this.resetRecoverableConnection(input);
      return this.runSessionTurnOnce(input, prompt, onProgress);
    }
  }

  private async fetchProviderQuotaTelemetry(
    providerId: string,
    appSettings: RunSessionTurnInput["appSettings"],
  ): Promise<ProviderQuotaTelemetry | null> {
    const client = this.getOrCreateClientByAppSettings(providerId, appSettings);
    await client.start();
    const quota = await client.rpc.account.getQuota();
    return buildCopilotProviderQuotaTelemetry(providerId, quota.quotaSnapshots, new Date().toISOString());
  }
}
