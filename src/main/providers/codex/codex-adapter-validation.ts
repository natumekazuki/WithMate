import { createHash } from "node:crypto";

import { resolveWorkspaceIdentity, type WorkspaceIdentity } from "../../../shared/workspace-path.js";
import {
  CODEX_ADAPTER_LIMITS,
  type CodexAdapterOptions,
  type CodexAdapterRequestOptions,
  type CodexAdapterApprovalPolicy,
  type CodexAdapterModel,
  type CodexAdapterSandboxMode,
  type CodexAdapterSandboxPolicy,
  type CodexAdapterThreadStatus,
  type CodexAdapterTurnStatus,
  type CodexInterruptTurnInput,
  type CodexListModelsInput,
  type CodexReadThreadInput,
  type CodexResumeThreadInput,
  type CodexStartThreadInput,
  type CodexStartTurnInput,
  type CodexSteerTurnInput,
} from "./codex-adapter-contract.js";

export type CodexValidationResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

export type CodexValidatedModelPage = Readonly<{
  models: readonly CodexAdapterModel[];
  nextCursor: string | null;
  byteLength: number;
}>;

export type CodexValidatedThreadStatus = Readonly<{
  type: "notLoaded" | "idle" | "systemError" | "active";
  activeFlags: readonly ("waitingOnApproval" | "waitingOnUserInput")[];
}>;

export type CodexValidatedItem =
  | Readonly<{
      classification: "agentMessage";
      id: string;
      text: string;
      phase: "commentary" | "final_answer" | null;
    }>
  | Readonly<{ classification: "plan"; id: string; text: string }>
  | Readonly<{
      classification: "reasoning";
      id: string;
      summary: readonly string[];
      content: readonly string[];
    }>
  | Readonly<{
      classification: "operation";
      id: string;
      itemType: "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall";
      status: string;
    }>
  | Readonly<{ classification: "userMessage"; id: string; clientId?: string | null }>
  | Readonly<{
      classification: "unsupported";
      id: string;
      itemType: string;
      lifecycleStatus?: "inProgress" | "completed" | "failed";
    }>;

export type CodexValidatedTurn = Readonly<{
  id: string;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  items: readonly CodexValidatedItem[];
}>;

export type CodexValidatedThread = Readonly<{
  id: string;
  status: CodexValidatedThreadStatus;
  cliVersion: string;
  modelProvider: string;
  cwd: string;
  workspaceKey: string;
  ephemeral: boolean;
  turns: readonly CodexValidatedTurn[];
}>;

export type CodexValidatedThreadOperationResponse = Readonly<{
  thread: CodexValidatedThread;
  model: string;
  modelProvider: string;
  reasoningEffort: string | null;
  effective: Readonly<{
    cwd: string;
    workspaceKey: string;
    approvalPolicy: "never" | "untrusted" | "on-request" | "granular";
    sandboxMode: CodexAdapterSandboxMode | "external-sandbox";
  }>;
}>;

export type CodexValidatedNotification =
  | Readonly<{ method: "thread/started"; thread: CodexValidatedThread }>
  | Readonly<{
      method: "thread/status/changed";
      threadId: string;
      status: CodexValidatedThreadStatus;
    }>
  | Readonly<{ method: "turn/started" | "turn/completed"; threadId: string; turn: CodexValidatedTurn }>
  | Readonly<{
      method: "item/started" | "item/completed";
      threadId: string;
      turnId: string;
      item: CodexValidatedItem;
      timestampMs: number;
    }>
  | Readonly<{
      method: "item/agentMessage/delta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }>
  | Readonly<{
      method: "thread/tokenUsage/updated";
      threadId: string;
      turnId: string;
      tokenUsage: CodexValidatedTokenUsage;
    }>
  | Readonly<{ method: "warning"; threadId: string | null; message: string }>
  | Readonly<{
      method: "error";
      threadId: string;
      turnId: string;
      willRetry: boolean;
    }>;

export type CodexValidatedTokenUsage = Readonly<{
  last: CodexValidatedTokenUsageBreakdown;
  total: CodexValidatedTokenUsageBreakdown;
  modelContextWindow: number | null;
}>;

export type CodexValidatedTokenUsageBreakdown = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}>;

export type CodexNotificationClassification =
  | Readonly<{ kind: "known"; notification: CodexValidatedNotification }>
  | Readonly<{ kind: "known_invalid"; method: string }>
  | Readonly<{
      kind: "unknown_valid";
      method: string;
      correlation: Readonly<{ threadId?: string; turnId?: string; itemId?: string }>;
      fingerprint: string;
    }>
  | Readonly<{ kind: "unknown_invalid" }>;

type ValidationContext = {
  seen: WeakSet<object>;
  aggregateBytes: number;
  maxAggregateBytes: number;
};

const INPUT_MODALITIES = new Set(["text", "image", "audio"]);
const TURN_STATUSES = new Set(["inProgress", "completed", "failed", "interrupted"]);
const APPROVAL_POLICIES = new Set(["never", "untrusted", "on-request"]);
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const REASONING_SUMMARIES = new Set(["auto", "concise", "detailed", "none"]);
const NODE_TIMER_MAX_MS = 2_147_483_647;
const COLLAB_TOOLS: ReadonlySet<unknown> = new Set(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"]);
const COLLAB_TOOL_STATUSES: ReadonlySet<unknown> = new Set(["inProgress", "completed", "failed"]);
const COLLAB_AGENT_STATUSES: ReadonlySet<unknown> = new Set([
  "pendingInit",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
]);
const SUBAGENT_ACTIVITY_KINDS: ReadonlySet<unknown> = new Set(["started", "interacted", "interrupted"]);

export function snapshotListModelsInput(value: unknown): CodexValidationResult<CodexListModelsInput> {
  return validate(() => {
    if (value === undefined) return Object.freeze({});
    const context = createContext();
    const record = exactRecord(value, [], ["pageSize"], context, 0);
    if (record === undefined) return undefined;
    if (!Object.hasOwn(record, "pageSize")) return Object.freeze({});
    const pageSize = positiveSafeInteger(record.pageSize, CODEX_ADAPTER_LIMITS.maxModelPageItems);
    return pageSize === undefined ? undefined : Object.freeze({ pageSize });
  });
}

export function snapshotAdapterOptions(value: unknown): CodexValidationResult<CodexAdapterOptions> {
  return validate(() => {
    const context = createContext();
    const record = exactRecord(value, ["cliVersion"], [], context, 0);
    const cliVersion = record === undefined ? undefined : shortNonEmptyString(record.cliVersion, context);
    return cliVersion === undefined ? undefined : Object.freeze({ cliVersion });
  });
}

export function snapshotAdapterRequestOptions(value: unknown): CodexValidationResult<CodexAdapterRequestOptions> {
  return validate(() => {
    if (value === undefined) return Object.freeze({});
    const context = createContext();
    const record = exactRecord(value, [], ["timeoutMs", "signal"], context, 0);
    if (record === undefined) return undefined;
    const timeoutMs = optional(record, "timeoutMs", (candidate) => positiveSafeInteger(candidate, NODE_TIMER_MAX_MS));
    const signal = optional(record, "signal", (candidate) =>
      typeof AbortSignal !== "undefined" && candidate instanceof AbortSignal ? candidate : undefined,
    );
    if (timeoutMs === INVALID || signal === INVALID) return undefined;
    return Object.freeze({
      ...(timeoutMs === ABSENT ? {} : { timeoutMs }),
      ...(signal === ABSENT ? {} : { signal }),
    });
  });
}

export function snapshotStartThreadInput(value: unknown): CodexValidationResult<CodexStartThreadInput> {
  return validate(() => {
    const context = createContext();
    const record = exactRecord(
      value,
      ["model", "workspacePath", "approvalPolicy", "sandboxMode", "persistence"],
      [],
      context,
      0,
    );
    if (record === undefined) return undefined;
    const model = shortNonEmptyString(record.model, context);
    const workspacePath = workspacePathString(record.workspacePath, context);
    const approvalPolicy = approvalPolicyValue(record.approvalPolicy);
    const sandboxMode = sandboxModeValue(record.sandboxMode);
    const persistence = record.persistence;
    if (
      model === undefined ||
      workspacePath === undefined ||
      approvalPolicy === undefined ||
      sandboxMode === undefined ||
      (persistence !== "persistent" && persistence !== "ephemeral")
    ) {
      return undefined;
    }
    return Object.freeze({ model, workspacePath, approvalPolicy, sandboxMode, persistence });
  });
}

export function snapshotResumeThreadInput(value: unknown): CodexValidationResult<CodexResumeThreadInput> {
  return validate(() => {
    const context = createContext();
    const record = exactRecord(
      value,
      ["threadId"],
      ["model", "workspacePath", "approvalPolicy", "sandboxMode"],
      context,
      0,
    );
    if (record === undefined) return undefined;
    const threadId = identifier(record.threadId, context);
    const model = optional(record, "model", (candidate) => shortNonEmptyString(candidate, context));
    const workspacePath = optional(record, "workspacePath", (candidate) => workspacePathString(candidate, context));
    const approvalPolicy = optional(record, "approvalPolicy", approvalPolicyValue);
    const sandboxMode = optional(record, "sandboxMode", sandboxModeValue);
    if (
      threadId === undefined ||
      model === INVALID ||
      workspacePath === INVALID ||
      approvalPolicy === INVALID ||
      sandboxMode === INVALID
    ) {
      return undefined;
    }
    return Object.freeze({
      threadId,
      ...(model === ABSENT ? {} : { model }),
      ...(workspacePath === ABSENT ? {} : { workspacePath }),
      ...(approvalPolicy === ABSENT ? {} : { approvalPolicy }),
      ...(sandboxMode === ABSENT ? {} : { sandboxMode }),
    });
  });
}

export function snapshotReadThreadInput(value: unknown): CodexValidationResult<CodexReadThreadInput> {
  return validate(() => {
    const context = createContext();
    const record = exactRecord(value, ["threadId", "includeTurns"], [], context, 0);
    if (record === undefined) return undefined;
    const threadId = identifier(record.threadId, context);
    return threadId === undefined || typeof record.includeTurns !== "boolean"
      ? undefined
      : Object.freeze({ threadId, includeTurns: record.includeTurns });
  });
}

export function snapshotStartTurnInput(value: unknown): CodexValidationResult<CodexStartTurnInput> {
  return validate(() => {
    const context = createContext(CODEX_ADAPTER_LIMITS.maxTurnTextBytes);
    const record = exactRecord(
      value,
      ["threadId", "contentBlocks"],
      ["workspacePath", "approvalPolicy", "sandboxPolicy", "model", "reasoningEffort", "reasoningSummary"],
      context,
      0,
    );
    if (record === undefined) return undefined;
    const threadId = identifier(record.threadId, context);
    const contentBlocks = textContentBlocks(record.contentBlocks, context, 1);
    const workspacePath = optional(record, "workspacePath", (candidate) => workspacePathString(candidate, context));
    const approvalPolicy = optional(record, "approvalPolicy", approvalPolicyValue);
    const sandboxPolicy = optional(record, "sandboxPolicy", (candidate) => decodeSandboxPolicy(candidate, context, 1));
    const model = optional(record, "model", (candidate) => shortNonEmptyString(candidate, context));
    const reasoningEffort = optional(record, "reasoningEffort", (candidate) => shortNonEmptyString(candidate, context));
    const reasoningSummary = optional(record, "reasoningSummary", (candidate) =>
      typeof candidate === "string" && REASONING_SUMMARIES.has(candidate)
        ? (candidate as CodexStartTurnInput["reasoningSummary"])
        : undefined,
    );
    if (
      threadId === undefined ||
      contentBlocks === undefined ||
      contentBlocks.length === 0 ||
      workspacePath === INVALID ||
      approvalPolicy === INVALID ||
      sandboxPolicy === INVALID ||
      model === INVALID ||
      reasoningEffort === INVALID ||
      reasoningSummary === INVALID
    ) {
      return undefined;
    }
    return Object.freeze({
      threadId,
      contentBlocks,
      ...(workspacePath === ABSENT ? {} : { workspacePath }),
      ...(approvalPolicy === ABSENT ? {} : { approvalPolicy }),
      ...(sandboxPolicy === ABSENT ? {} : { sandboxPolicy }),
      ...(model === ABSENT ? {} : { model }),
      ...(reasoningEffort === ABSENT ? {} : { reasoningEffort }),
      ...(reasoningSummary === ABSENT ? {} : { reasoningSummary }),
    });
  });
}

export function snapshotSteerTurnInput(value: unknown): CodexValidationResult<CodexSteerTurnInput> {
  return validate(() => {
    const context = createContext(CODEX_ADAPTER_LIMITS.maxTurnTextBytes);
    const record = exactRecord(value, ["threadId", "expectedTurnId", "contentBlocks"], [], context, 0);
    if (record === undefined) return undefined;
    const threadId = identifier(record.threadId, context);
    const expectedTurnId = identifier(record.expectedTurnId, context);
    const contentBlocks = textContentBlocks(record.contentBlocks, context, 1);
    return threadId === undefined ||
      expectedTurnId === undefined ||
      contentBlocks === undefined ||
      contentBlocks.length === 0
      ? undefined
      : Object.freeze({ threadId, expectedTurnId, contentBlocks });
  });
}

export function snapshotInterruptTurnInput(value: unknown): CodexValidationResult<CodexInterruptTurnInput> {
  return validate(() => {
    const context = createContext();
    const record = exactRecord(value, ["threadId", "turnId"], [], context, 0);
    if (record === undefined) return undefined;
    const threadId = identifier(record.threadId, context);
    const turnId = identifier(record.turnId, context);
    return threadId === undefined || turnId === undefined ? undefined : Object.freeze({ threadId, turnId });
  });
}

export function decodeModelListResponse(value: unknown): CodexValidationResult<CodexValidatedModelPage> {
  return validate(() => {
    const wireContext = createContext(CODEX_ADAPTER_LIMITS.maxModelCatalogBytes);
    const snapshot = snapshotJsonValue(value, wireContext, 0);
    if (snapshot === INVALID) return undefined;
    const context = createContext();
    const record = exactRecord(snapshot, ["data"], ["nextCursor"], context, 0);
    if (record === undefined) return undefined;
    const entries = denseArray(record.data, CODEX_ADAPTER_LIMITS.maxModelPageItems, context, 1);
    const nextCursor = Object.hasOwn(record, "nextCursor")
      ? nullableString(record.nextCursor, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes)
      : Object.freeze({ value: null });
    if (entries === undefined || nextCursor === undefined) return undefined;
    const models: CodexAdapterModel[] = [];
    for (const entry of entries) {
      const model = decodeModel(entry, context, 2);
      if (model === undefined) return undefined;
      models.push(model);
    }
    return Object.freeze({
      models: Object.freeze(models),
      nextCursor: nextCursor.value,
      byteLength: wireContext.aggregateBytes,
    });
  });
}

export function decodeThreadStartResponse(
  value: unknown,
): CodexValidationResult<CodexValidatedThreadOperationResponse> {
  return decodeThreadOperationResponse(value);
}

export function decodeThreadResumeResponse(
  value: unknown,
): CodexValidationResult<CodexValidatedThreadOperationResponse> {
  return decodeThreadOperationResponse(value);
}

export function decodeThreadReadResponse(
  value: unknown,
): CodexValidationResult<Readonly<{ thread: CodexValidatedThread }>> {
  return validate(() => {
    const context = createContext();
    const record = exactRecord(value, ["thread"], [], context, 0);
    const thread = record === undefined ? undefined : decodeThread(record.thread, context, 1);
    return thread === undefined ? undefined : Object.freeze({ thread });
  });
}

export function decodeTurnStartResponse(value: unknown): CodexValidationResult<Readonly<{ turn: CodexValidatedTurn }>> {
  return validate(() => {
    const context = createContext();
    const record = exactRecord(value, ["turn"], [], context, 0);
    const turn = record === undefined ? undefined : decodeTurn(record.turn, context, 1);
    return turn === undefined ? undefined : Object.freeze({ turn });
  });
}

export function decodeTurnSteerResponse(value: unknown): CodexValidationResult<Readonly<{ turnId: string }>> {
  return validate(() => {
    const context = createContext();
    const record = exactRecord(value, ["turnId"], [], context, 0);
    const turnId = record === undefined ? undefined : identifier(record.turnId, context);
    return turnId === undefined ? undefined : Object.freeze({ turnId });
  });
}

export function decodeTurnInterruptResponse(value: unknown): CodexValidationResult<Readonly<Record<string, never>>> {
  return validate(() => {
    const context = createContext();
    const record = exactRecord(value, [], [], context, 0);
    return record === undefined ? undefined : Object.freeze({});
  });
}

export function classifyCodexNotification(method: unknown, params: unknown): CodexNotificationClassification {
  try {
    const context = createContext();
    const methodSnapshot = methodString(method, context);
    if (methodSnapshot === undefined) return Object.freeze({ kind: "unknown_invalid" });
    const notification = decodeKnownNotification(methodSnapshot, params, context);
    if (notification !== undefined) return Object.freeze({ kind: "known", notification });
    if (KNOWN_NOTIFICATION_METHODS.has(methodSnapshot)) {
      return Object.freeze({ kind: "known_invalid", method: methodSnapshot });
    }
    const unknownContext = createContext();
    const paramsSnapshot = params === undefined ? undefined : snapshotJsonValue(params, unknownContext, 0);
    if (paramsSnapshot === INVALID) return Object.freeze({ kind: "unknown_invalid" });
    const correlation = boundedUnknownCorrelation(paramsSnapshot);
    const fingerprint = fingerprintUnknownNotification(methodSnapshot, paramsSnapshot);
    return Object.freeze({ kind: "unknown_valid", method: methodSnapshot, correlation, fingerprint });
  } catch {
    return Object.freeze({ kind: "unknown_invalid" });
  }
}

function fingerprintUnknownNotification(method: string, params: unknown): string {
  const canonical = `${JSON.stringify(method)}:${canonicalJson(params)}`;
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value) as string;
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function toAdapterThreadStatus(status: CodexValidatedThreadStatus): CodexAdapterThreadStatus {
  switch (status.type) {
    case "notLoaded":
      return "not_loaded";
    case "idle":
      return "idle";
    case "active":
      return "active";
    case "systemError":
      return "system_error";
  }
}

export function toAdapterTurnStatus(status: CodexValidatedTurn["status"]): CodexAdapterTurnStatus {
  switch (status) {
    case "inProgress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
  }
}

const KNOWN_NOTIFICATION_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "thread/tokenUsage/updated",
  "warning",
  "error",
]);

function decodeKnownNotification(
  method: string,
  params: unknown,
  context: ValidationContext,
): CodexValidatedNotification | undefined {
  switch (method) {
    case "thread/started": {
      const record = exactRecord(params, ["thread"], [], context, 0);
      const thread = record === undefined ? undefined : decodeThread(record.thread, context, 1);
      return thread === undefined ? undefined : Object.freeze({ method, thread });
    }
    case "thread/status/changed": {
      const record = exactRecord(params, ["threadId", "status"], [], context, 0);
      if (record === undefined) return undefined;
      const threadId = identifier(record.threadId, context);
      const status = decodeThreadStatus(record.status, context, 1);
      return threadId === undefined || status === undefined ? undefined : Object.freeze({ method, threadId, status });
    }
    case "turn/started":
    case "turn/completed": {
      const record = exactRecord(params, ["threadId", "turn"], [], context, 0);
      if (record === undefined) return undefined;
      const threadId = identifier(record.threadId, context);
      const turn = decodeTurn(record.turn, context, 1);
      if (
        threadId === undefined ||
        turn === undefined ||
        (method === "turn/started" && turn.status !== "inProgress") ||
        (method === "turn/completed" && turn.status === "inProgress")
      ) {
        return undefined;
      }
      return Object.freeze({ method, threadId, turn });
    }
    case "item/started":
    case "item/completed": {
      const timestampField = method === "item/started" ? "startedAtMs" : "completedAtMs";
      const record = exactRecord(params, ["item", "threadId", "turnId", timestampField], [], context, 0);
      if (record === undefined) return undefined;
      const threadId = identifier(record.threadId, context);
      const turnId = identifier(record.turnId, context);
      const item = decodeThreadItem(record.item, context, 1);
      const timestampMs = nonNegativeSafeInteger(record[timestampField]);
      return threadId === undefined ||
        turnId === undefined ||
        item === undefined ||
        timestampMs === undefined ||
        !itemStatusMatchesLifecycle(method, item)
        ? undefined
        : Object.freeze({ method, threadId, turnId, item, timestampMs });
    }
    case "item/agentMessage/delta": {
      const record = exactRecord(params, ["threadId", "turnId", "itemId", "delta"], [], context, 0);
      if (record === undefined) return undefined;
      const threadId = identifier(record.threadId, context);
      const turnId = identifier(record.turnId, context);
      const itemId = identifier(record.itemId, context);
      const delta = boundedString(record.delta, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true);
      return threadId === undefined || turnId === undefined || itemId === undefined || delta === undefined
        ? undefined
        : Object.freeze({ method, threadId, turnId, itemId, delta });
    }
    case "thread/tokenUsage/updated": {
      const record = exactRecord(params, ["threadId", "turnId", "tokenUsage"], [], context, 0);
      if (record === undefined) return undefined;
      const threadId = identifier(record.threadId, context);
      const turnId = identifier(record.turnId, context);
      const tokenUsage = decodeTokenUsage(record.tokenUsage, context, 1);
      return threadId === undefined || turnId === undefined || tokenUsage === undefined
        ? undefined
        : Object.freeze({ method, threadId, turnId, tokenUsage });
    }
    case "warning": {
      const record = exactRecord(params, ["message"], ["threadId"], context, 0);
      if (record === undefined) return undefined;
      const message = boundedString(record.message, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, true);
      let threadId: string | null = null;
      if (Object.hasOwn(record, "threadId") && record.threadId !== null) {
        const decodedThreadId = identifier(record.threadId, context);
        if (decodedThreadId === undefined) return undefined;
        threadId = decodedThreadId;
      }
      return message === undefined ? undefined : Object.freeze({ method, threadId, message });
    }
    case "error": {
      const record = exactRecord(params, ["error", "threadId", "turnId", "willRetry"], [], context, 0);
      if (record === undefined) return undefined;
      const threadId = identifier(record.threadId, context);
      const turnId = identifier(record.turnId, context);
      if (
        threadId === undefined ||
        turnId === undefined ||
        typeof record.willRetry !== "boolean" ||
        !validateTurnErrorPayload(record.error, context, 1)
      ) {
        return undefined;
      }
      return Object.freeze({ method, threadId, turnId, willRetry: record.willRetry });
    }
    default:
      return undefined;
  }
}

function itemStatusMatchesLifecycle(method: "item/started" | "item/completed", item: CodexValidatedItem): boolean {
  const status =
    item.classification === "operation"
      ? item.status
      : item.classification === "unsupported"
        ? item.lifecycleStatus
        : undefined;
  return status === undefined || (method === "item/started" ? status === "inProgress" : status !== "inProgress");
}

function decodeThreadOperationResponse(value: unknown): CodexValidationResult<CodexValidatedThreadOperationResponse> {
  return validate(() => {
    const context = createContext();
    const record = exactRecord(
      value,
      ["thread", "model", "modelProvider", "cwd", "approvalPolicy", "approvalsReviewer", "sandbox"],
      ["serviceTier", "instructionSources", "reasoningEffort"],
      context,
      0,
    );
    if (record === undefined) return undefined;
    const thread = decodeThread(record.thread, context, 1);
    const model = shortNonEmptyString(record.model, context);
    const modelProvider = shortNonEmptyString(record.modelProvider, context);
    const reasoningEffort = Object.hasOwn(record, "reasoningEffort")
      ? nullableNonEmptyString(record.reasoningEffort, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes)
      : Object.freeze({ value: null });
    const cwd = workspaceIdentity(record.cwd, context);
    const approvalPolicy = decodeEffectiveApprovalPolicy(record.approvalPolicy, context, 1);
    const sandboxMode = decodeEffectiveSandboxMode(record.sandbox, context, 1);
    if (
      thread === undefined ||
      model === undefined ||
      modelProvider === undefined ||
      thread.modelProvider !== modelProvider ||
      thread.workspaceKey !== cwd?.workspaceKey ||
      reasoningEffort === undefined ||
      cwd === undefined ||
      approvalPolicy === undefined ||
      sandboxMode === undefined ||
      !optionalValid(record, "serviceTier", (candidate) => nullableShortString(candidate, context)) ||
      !optionalValid(record, "instructionSources", (candidate) =>
        stringArray(candidate, context, 1, CODEX_ADAPTER_LIMITS.maxArrayItems),
      ) ||
      (record.approvalsReviewer !== "user" &&
        record.approvalsReviewer !== "auto_review" &&
        record.approvalsReviewer !== "guardian_subagent")
    ) {
      return undefined;
    }
    return Object.freeze({
      thread,
      model,
      modelProvider,
      reasoningEffort: reasoningEffort.value,
      effective: Object.freeze({
        cwd: cwd.workspacePath,
        workspaceKey: cwd.workspaceKey,
        approvalPolicy,
        sandboxMode,
      }),
    });
  });
}

function decodeModel(value: unknown, context: ValidationContext, depth: number): CodexAdapterModel | undefined {
  const record = exactRecord(
    value,
    [
      "id",
      "model",
      "displayName",
      "description",
      "hidden",
      "supportedReasoningEfforts",
      "defaultReasoningEffort",
      "isDefault",
    ],
    [
      "upgrade",
      "upgradeInfo",
      "availabilityNux",
      "inputModalities",
      "supportsPersonality",
      "additionalSpeedTiers",
      "serviceTiers",
      "defaultServiceTier",
    ],
    context,
    depth,
  );
  if (record === undefined) return undefined;
  const id = identifier(record.id, context);
  const requestModel = shortNonEmptyString(record.model, context);
  const displayName = shortNonEmptyString(record.displayName, context);
  const description = boundedString(record.description, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, true);
  const defaultReasoningEffort = shortNonEmptyString(record.defaultReasoningEffort, context);
  const effortEntries = denseArray(
    record.supportedReasoningEfforts,
    CODEX_ADAPTER_LIMITS.maxArrayItems,
    context,
    depth + 1,
  );
  const modalityEntries = Object.hasOwn(record, "inputModalities")
    ? denseArray(record.inputModalities, 3, context, depth + 1)
    : Object.freeze(["text", "image"]);
  if (
    id === undefined ||
    requestModel === undefined ||
    displayName === undefined ||
    description === undefined ||
    defaultReasoningEffort === undefined ||
    effortEntries === undefined ||
    modalityEntries === undefined ||
    typeof record.hidden !== "boolean" ||
    (Object.hasOwn(record, "supportsPersonality") && typeof record.supportsPersonality !== "boolean") ||
    typeof record.isDefault !== "boolean" ||
    !optionalValid(record, "upgrade", (candidate) => nullableShortString(candidate, context)) ||
    !optionalValid(record, "upgradeInfo", (candidate) => validateUpgradeInfo(candidate, context, depth + 1)) ||
    !optionalValid(record, "availabilityNux", (candidate) => validateAvailabilityNux(candidate, context, depth + 1)) ||
    !optionalValid(record, "additionalSpeedTiers", (candidate) =>
      stringArray(candidate, context, depth + 1, CODEX_ADAPTER_LIMITS.maxArrayItems),
    ) ||
    !optionalValid(record, "defaultServiceTier", (candidate) => nullableShortString(candidate, context))
  ) {
    return undefined;
  }
  const efforts: string[] = [];
  const seenEfforts = new Set<string>();
  for (const entry of effortEntries) {
    const effort = exactRecord(entry, ["reasoningEffort", "description"], [], context, depth + 2);
    if (effort === undefined) return undefined;
    const effortName = shortNonEmptyString(effort.reasoningEffort, context);
    if (
      effortName === undefined ||
      seenEfforts.has(effortName) ||
      boundedString(effort.description, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, true) === undefined
    ) {
      return undefined;
    }
    seenEfforts.add(effortName);
    efforts.push(effortName);
  }
  const modalities: ("text" | "image" | "audio")[] = [];
  const seenModalities = new Set<string>();
  for (const entry of modalityEntries) {
    if (typeof entry !== "string" || !INPUT_MODALITIES.has(entry) || seenModalities.has(entry)) return undefined;
    seenModalities.add(entry);
    modalities.push(entry as "text" | "image" | "audio");
  }
  if (!efforts.includes(defaultReasoningEffort)) return undefined;
  const serviceTierIds = Object.hasOwn(record, "serviceTiers")
    ? decodeServiceTiers(record.serviceTiers, context, depth + 1)
    : Object.freeze([]);
  const defaultServiceTier = Object.hasOwn(record, "defaultServiceTier") ? record.defaultServiceTier : null;
  if (
    serviceTierIds === undefined ||
    (defaultServiceTier !== null && !serviceTierIds.includes(defaultServiceTier as string))
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    requestModel,
    displayName,
    hidden: record.hidden,
    selectable: !record.hidden,
    supportedReasoningEfforts: Object.freeze(efforts),
    defaultReasoningEffort,
    inputModalities: Object.freeze(modalities),
    supportsPersonality: Object.hasOwn(record, "supportsPersonality") ? (record.supportsPersonality as boolean) : false,
    isDefault: record.isDefault,
  });
}

function decodeThread(value: unknown, context: ValidationContext, depth: number): CodexValidatedThread | undefined {
  const record = exactRecord(
    value,
    [
      "id",
      "sessionId",
      "preview",
      "ephemeral",
      "modelProvider",
      "createdAt",
      "updatedAt",
      "status",
      "cwd",
      "cliVersion",
      "source",
      "turns",
    ],
    [
      "forkedFromId",
      "parentThreadId",
      "recencyAt",
      "path",
      "threadSource",
      "agentNickname",
      "agentRole",
      "gitInfo",
      "name",
    ],
    context,
    depth,
  );
  if (record === undefined) return undefined;
  const id = identifier(record.id, context);
  const status = decodeThreadStatus(record.status, context, depth + 1);
  const cliVersion = shortNonEmptyString(record.cliVersion, context);
  const modelProvider = shortNonEmptyString(record.modelProvider, context);
  const cwd = workspaceIdentity(record.cwd, context);
  const turnsArray = denseArray(record.turns, CODEX_ADAPTER_LIMITS.maxThreadTurns, context, depth + 1);
  if (
    id === undefined ||
    status === undefined ||
    cliVersion === undefined ||
    modelProvider === undefined ||
    cwd === undefined ||
    turnsArray === undefined ||
    identifier(record.sessionId, context) === undefined ||
    !optionalValid(record, "forkedFromId", (candidate) => nullableIdentifier(candidate, context)) ||
    !optionalValid(record, "parentThreadId", (candidate) => nullableIdentifier(candidate, context)) ||
    boundedString(record.preview, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true) === undefined ||
    typeof record.ephemeral !== "boolean" ||
    nonNegativeSafeInteger(record.createdAt) === undefined ||
    nonNegativeSafeInteger(record.updatedAt) === undefined ||
    !optionalValid(record, "recencyAt", nullableSafeInteger) ||
    !optionalValid(record, "path", (candidate) =>
      nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
    ) ||
    !validateSessionSource(record.source, context, depth + 1) ||
    !optionalValid(record, "threadSource", (candidate) => nullableShortString(candidate, context)) ||
    !optionalValid(record, "agentNickname", (candidate) => nullableShortString(candidate, context)) ||
    !optionalValid(record, "agentRole", (candidate) => nullableShortString(candidate, context)) ||
    !optionalValid(record, "gitInfo", (candidate) => validateGitInfo(candidate, context, depth + 1)) ||
    !optionalValid(record, "name", (candidate) => nullableShortString(candidate, context))
  ) {
    return undefined;
  }
  const turns: CodexValidatedTurn[] = [];
  const turnIds = new Set<string>();
  for (const entry of turnsArray) {
    const turn = decodeTurn(entry, context, depth + 2);
    if (turn === undefined || turnIds.has(turn.id)) return undefined;
    turnIds.add(turn.id);
    turns.push(turn);
  }
  return Object.freeze({
    id,
    status,
    cliVersion,
    modelProvider,
    cwd: cwd.workspacePath,
    workspaceKey: cwd.workspaceKey,
    ephemeral: record.ephemeral,
    turns: Object.freeze(turns),
  });
}

function decodeThreadStatus(
  value: unknown,
  context: ValidationContext,
  depth: number,
): CodexValidatedThreadStatus | undefined {
  const base = exactRecord(value, ["type"], ["activeFlags"], context, depth);
  if (base === undefined || typeof base.type !== "string") return undefined;
  if (base.type === "active") {
    if (!Object.hasOwn(base, "activeFlags")) return undefined;
    const entries = denseArray(base.activeFlags, 2, context, depth + 1);
    if (entries === undefined) return undefined;
    const flags: ("waitingOnApproval" | "waitingOnUserInput")[] = [];
    for (const entry of entries) {
      if (entry !== "waitingOnApproval" && entry !== "waitingOnUserInput") return undefined;
      flags.push(entry);
    }
    return Object.freeze({ type: "active", activeFlags: Object.freeze(flags) });
  }
  if (Object.hasOwn(base, "activeFlags")) return undefined;
  if (base.type !== "notLoaded" && base.type !== "idle" && base.type !== "systemError") return undefined;
  return Object.freeze({ type: base.type, activeFlags: Object.freeze([]) });
}

function decodeTurn(value: unknown, context: ValidationContext, depth: number): CodexValidatedTurn | undefined {
  const record = exactRecord(
    value,
    ["id", "items", "status"],
    ["itemsView", "error", "startedAt", "completedAt", "durationMs"],
    context,
    depth,
  );
  if (record === undefined) return undefined;
  const id = identifier(record.id, context);
  const items = denseArray(record.items, CODEX_ADAPTER_LIMITS.maxTurnItems, context, depth + 1);
  if (
    id === undefined ||
    items === undefined ||
    typeof record.status !== "string" ||
    !TURN_STATUSES.has(record.status) ||
    (Object.hasOwn(record, "itemsView") &&
      record.itemsView !== "notLoaded" &&
      record.itemsView !== "summary" &&
      record.itemsView !== "full") ||
    !optionalValid(record, "startedAt", nullableSafeInteger) ||
    !optionalValid(record, "completedAt", nullableSafeInteger) ||
    !optionalValid(record, "durationMs", nullableSafeInteger) ||
    !validateTurnError(Object.hasOwn(record, "error") ? record.error : undefined, record.status, context, depth + 1)
  ) {
    return undefined;
  }
  const decodedItems: CodexValidatedItem[] = [];
  const itemIds = new Set<string>();
  for (const item of items) {
    const decoded = decodeThreadItem(item, context, depth + 2);
    if (decoded === undefined || itemIds.has(decoded.id)) return undefined;
    itemIds.add(decoded.id);
    decodedItems.push(decoded);
  }
  return Object.freeze({
    id,
    status: record.status as CodexValidatedTurn["status"],
    items: Object.freeze(decodedItems),
  });
}

function decodeThreadItem(value: unknown, context: ValidationContext, depth: number): CodexValidatedItem | undefined {
  const probe = inspectRecord(value, context, depth);
  if (probe === undefined || typeof probe.type !== "string") return undefined;
  switch (probe.type) {
    case "agentMessage": {
      const record = exactRecordFromInspected(probe, ["type", "id", "text"], ["phase", "memoryCitation"]);
      if (record === undefined) return undefined;
      const id = identifier(record.id, context);
      const text = boundedString(record.text, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true);
      const phase = Object.hasOwn(record, "phase") ? record.phase : null;
      if (
        id === undefined ||
        text === undefined ||
        (phase !== null && phase !== "commentary" && phase !== "final_answer") ||
        !optionalValid(record, "memoryCitation", (candidate) => validateMemoryCitation(candidate, context, depth + 1))
      ) {
        return undefined;
      }
      return Object.freeze({ classification: "agentMessage", id, text, phase });
    }
    case "plan": {
      const record = exactRecordFromInspected(probe, ["type", "id", "text"]);
      if (record === undefined) return undefined;
      const id = identifier(record.id, context);
      const text = boundedString(record.text, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true);
      return id === undefined || text === undefined ? undefined : Object.freeze({ classification: "plan", id, text });
    }
    case "reasoning": {
      const record = exactRecordFromInspected(probe, ["type", "id"], ["summary", "content"]);
      if (record === undefined) return undefined;
      const id = identifier(record.id, context);
      const summary = Object.hasOwn(record, "summary")
        ? decodeStringArray(record.summary, context, depth + 1, CODEX_ADAPTER_LIMITS.maxTurnItems)
        : Object.freeze([]);
      const content = Object.hasOwn(record, "content")
        ? decodeStringArray(record.content, context, depth + 1, CODEX_ADAPTER_LIMITS.maxTurnItems)
        : Object.freeze([]);
      return id === undefined || summary === undefined || content === undefined
        ? undefined
        : Object.freeze({ classification: "reasoning", id, summary, content });
    }
    case "commandExecution": {
      const record = exactRecordFromInspected(
        probe,
        ["type", "id", "command", "cwd", "status", "commandActions"],
        ["processId", "source", "aggregatedOutput", "exitCode", "durationMs"],
      );
      if (record === undefined) return undefined;
      const id = identifier(record.id, context);
      if (
        id === undefined ||
        boundedString(record.command, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, true) === undefined ||
        boundedString(record.cwd, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false) === undefined ||
        !optionalValid(record, "processId", (candidate) => nullableShortString(candidate, context)) ||
        (Object.hasOwn(record, "source") &&
          record.source !== "agent" &&
          record.source !== "userShell" &&
          record.source !== "unifiedExecStartup" &&
          record.source !== "unifiedExecInteraction") ||
        (record.status !== "inProgress" &&
          record.status !== "completed" &&
          record.status !== "failed" &&
          record.status !== "declined") ||
        !validateCommandActions(record.commandActions, context, depth + 1) ||
        !optionalValid(record, "aggregatedOutput", (candidate) =>
          nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes),
        ) ||
        !optionalValid(record, "exitCode", nullableSignedInt32) ||
        !optionalValid(record, "durationMs", nullableSafeInteger)
      ) {
        return undefined;
      }
      return Object.freeze({ classification: "operation", id, itemType: "commandExecution", status: record.status });
    }
    case "fileChange": {
      const record = exactRecordFromInspected(probe, ["type", "id", "changes", "status"]);
      if (record === undefined) return undefined;
      const id = identifier(record.id, context);
      if (
        id === undefined ||
        (record.status !== "inProgress" &&
          record.status !== "completed" &&
          record.status !== "failed" &&
          record.status !== "declined") ||
        !validateFileChanges(record.changes, context, depth + 1)
      ) {
        return undefined;
      }
      return Object.freeze({ classification: "operation", id, itemType: "fileChange", status: record.status });
    }
    case "mcpToolCall": {
      const record = exactRecordFromInspected(
        probe,
        ["type", "id", "server", "tool", "status", "arguments"],
        ["appContext", "pluginId", "result", "error", "durationMs", "mcpAppResourceUri"],
      );
      if (record === undefined) return undefined;
      const id = identifier(record.id, context);
      if (
        id === undefined ||
        shortNonEmptyString(record.server, context) === undefined ||
        shortNonEmptyString(record.tool, context) === undefined ||
        (record.status !== "inProgress" && record.status !== "completed" && record.status !== "failed") ||
        !validateJsonValue(record.arguments, context, depth + 1) ||
        !optionalValid(record, "appContext", (candidate) => validateMcpAppContext(candidate, context, depth + 1)) ||
        !optionalValid(record, "pluginId", (candidate) => nullableShortString(candidate, context)) ||
        !optionalValid(record, "result", (candidate) => validateMcpResult(candidate, context, depth + 1)) ||
        !optionalValid(record, "error", (candidate) => validateMcpError(candidate, context, depth + 1)) ||
        !optionalValid(record, "durationMs", nullableSafeInteger) ||
        (Object.hasOwn(record, "mcpAppResourceUri") &&
          !nullableBoundedString(record.mcpAppResourceUri, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes))
      ) {
        return undefined;
      }
      return Object.freeze({ classification: "operation", id, itemType: "mcpToolCall", status: record.status });
    }
    case "dynamicToolCall": {
      const record = exactRecordFromInspected(
        probe,
        ["type", "id", "tool", "arguments", "status"],
        ["contentItems", "success", "durationMs", "namespace"],
      );
      if (record === undefined) return undefined;
      const id = identifier(record.id, context);
      if (
        id === undefined ||
        !optionalValid(record, "namespace", (candidate) => nullableShortString(candidate, context)) ||
        shortNonEmptyString(record.tool, context) === undefined ||
        !validateJsonValue(record.arguments, context, depth + 1) ||
        (record.status !== "inProgress" && record.status !== "completed" && record.status !== "failed") ||
        !optionalValid(record, "contentItems", (candidate) =>
          validateDynamicContentItems(candidate, context, depth + 1),
        ) ||
        (Object.hasOwn(record, "success") && record.success !== null && typeof record.success !== "boolean") ||
        !optionalValid(record, "durationMs", nullableSafeInteger)
      ) {
        return undefined;
      }
      return Object.freeze({ classification: "operation", id, itemType: "dynamicToolCall", status: record.status });
    }
    case "userMessage": {
      const record = exactRecordFromInspected(probe, ["type", "id", "content"], ["clientId"]);
      if (record === undefined) return undefined;
      const id = identifier(record.id, context);
      let clientId: string | null | typeof ABSENT = ABSENT;
      if (Object.hasOwn(record, "clientId")) {
        if (record.clientId === null) {
          clientId = null;
        } else {
          const decodedClientId = identifier(record.clientId, context);
          if (decodedClientId === undefined) return undefined;
          clientId = decodedClientId;
        }
      }
      if (id === undefined || !validateUserInputs(record.content, context, depth + 1)) {
        return undefined;
      }
      return Object.freeze({
        classification: "userMessage",
        id,
        ...(clientId === ABSENT ? {} : { clientId }),
      });
    }
    case "hookPrompt": {
      const record = exactRecordFromInspected(probe, ["type", "id", "fragments"]);
      const id = record === undefined ? undefined : identifier(record.id, context);
      return record === undefined ||
        id === undefined ||
        !validateHookPromptFragments(record.fragments, context, depth + 1)
        ? undefined
        : Object.freeze({ classification: "unsupported", id, itemType: "hookPrompt" });
    }
    case "collabAgentToolCall": {
      const record = exactRecordFromInspected(
        probe,
        ["type", "id", "tool", "status", "senderThreadId", "receiverThreadIds", "agentsStates"],
        ["prompt", "model", "reasoningEffort"],
      );
      const id = record === undefined ? undefined : identifier(record.id, context);
      if (
        record === undefined ||
        id === undefined ||
        !COLLAB_TOOLS.has(record.tool) ||
        !COLLAB_TOOL_STATUSES.has(record.status) ||
        identifier(record.senderThreadId, context) === undefined ||
        !identifierArray(record.receiverThreadIds, context, depth + 1) ||
        !optionalValid(record, "prompt", (candidate) => nullableShortString(candidate, context)) ||
        !optionalValid(record, "model", (candidate) => nullableShortString(candidate, context)) ||
        !optionalValid(record, "reasoningEffort", (candidate) => nullableNonEmptyShortString(candidate, context)) ||
        !validateCollabAgentStates(record.agentsStates, context, depth + 1)
      ) {
        return undefined;
      }
      return Object.freeze({
        classification: "unsupported",
        id,
        itemType: "collabAgentToolCall",
        lifecycleStatus: record.status as "inProgress" | "completed" | "failed",
      });
    }
    case "subAgentActivity": {
      const record = exactRecordFromInspected(probe, ["type", "id", "kind", "agentThreadId", "agentPath"]);
      const id = record === undefined ? undefined : identifier(record.id, context);
      if (
        record === undefined ||
        id === undefined ||
        !SUBAGENT_ACTIVITY_KINDS.has(record.kind) ||
        identifier(record.agentThreadId, context) === undefined ||
        boundedString(record.agentPath, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false) === undefined
      ) {
        return undefined;
      }
      return Object.freeze({ classification: "unsupported", id, itemType: "subAgentActivity" });
    }
    case "webSearch": {
      const record = exactRecordFromInspected(probe, ["type", "id", "query"], ["action", "results"]);
      const id = record === undefined ? undefined : identifier(record.id, context);
      if (
        record === undefined ||
        id === undefined ||
        boundedString(record.query, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, true) === undefined ||
        !optionalValid(record, "action", (candidate) => validateWebSearchAction(candidate, context, depth + 1)) ||
        !optionalValid(record, "results", (candidate) => nullableJsonArray(candidate, context, depth + 1))
      ) {
        return undefined;
      }
      return Object.freeze({ classification: "unsupported", id, itemType: "webSearch" });
    }
    case "imageView": {
      const record = exactRecordFromInspected(probe, ["type", "id", "path"]);
      const id = record === undefined ? undefined : identifier(record.id, context);
      return record === undefined ||
        id === undefined ||
        boundedString(record.path, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false) === undefined
        ? undefined
        : Object.freeze({ classification: "unsupported", id, itemType: "imageView" });
    }
    case "sleep": {
      const record = exactRecordFromInspected(probe, ["type", "id", "durationMs"]);
      const id = record === undefined ? undefined : identifier(record.id, context);
      return record === undefined || id === undefined || nonNegativeSafeInteger(record.durationMs) === undefined
        ? undefined
        : Object.freeze({ classification: "unsupported", id, itemType: "sleep" });
    }
    case "imageGeneration": {
      const record = exactRecordFromInspected(
        probe,
        ["type", "id", "status", "result"],
        ["revisedPrompt", "savedPath"],
      );
      const id = record === undefined ? undefined : identifier(record.id, context);
      if (
        record === undefined ||
        id === undefined ||
        shortNonEmptyString(record.status, context) === undefined ||
        !optionalValid(record, "revisedPrompt", (candidate) =>
          nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes),
        ) ||
        boundedString(record.result, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true) === undefined ||
        (Object.hasOwn(record, "savedPath") &&
          !nullableBoundedString(record.savedPath, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes))
      ) {
        return undefined;
      }
      return Object.freeze({ classification: "unsupported", id, itemType: "imageGeneration" });
    }
    case "enteredReviewMode":
    case "exitedReviewMode": {
      const record = exactRecordFromInspected(probe, ["type", "id", "review"]);
      const id = record === undefined ? undefined : identifier(record.id, context);
      return record === undefined ||
        id === undefined ||
        boundedString(record.review, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true) === undefined
        ? undefined
        : Object.freeze({ classification: "unsupported", id, itemType: probe.type });
    }
    case "contextCompaction": {
      const record = exactRecordFromInspected(probe, ["type", "id"]);
      const id = record === undefined ? undefined : identifier(record.id, context);
      return record === undefined || id === undefined
        ? undefined
        : Object.freeze({ classification: "unsupported", id, itemType: "contextCompaction" });
    }
    default: {
      if (!validateInspectedJsonRecord(probe, context, depth)) return undefined;
      const itemType = methodString(probe.type, context);
      if (itemType === undefined) return undefined;
      const id = identifier(probe.id, context);
      return id === undefined ? undefined : Object.freeze({ classification: "unsupported", id, itemType });
    }
  }
}

function decodeSandboxPolicy(
  value: unknown,
  context: ValidationContext,
  depth: number,
): CodexAdapterSandboxPolicy | undefined {
  const probe = inspectRecord(value, context, depth);
  if (probe === undefined || typeof probe.mode !== "string") return undefined;
  switch (probe.mode) {
    case "read-only": {
      const record = exactRecordFromInspected(probe, ["mode", "networkAccess"]);
      return record === undefined || typeof record.networkAccess !== "boolean"
        ? undefined
        : Object.freeze({ mode: "read-only", networkAccess: record.networkAccess });
    }
    case "workspace-write": {
      const record = exactRecordFromInspected(probe, ["mode", "writableRoots", "networkAccess"]);
      if (record === undefined || typeof record.networkAccess !== "boolean") return undefined;
      const roots = denseArray(record.writableRoots, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth + 1);
      if (roots === undefined) return undefined;
      const writableRoots: string[] = [];
      for (const root of roots) {
        const path = workspacePathString(root, context);
        if (path === undefined) return undefined;
        writableRoots.push(path);
      }
      return Object.freeze({
        mode: "workspace-write",
        writableRoots: Object.freeze(writableRoots),
        networkAccess: record.networkAccess,
      });
    }
    case "danger-full-access": {
      const record = exactRecordFromInspected(probe, ["mode"]);
      return record === undefined ? undefined : Object.freeze({ mode: "danger-full-access" });
    }
    default:
      return undefined;
  }
}

function decodeEffectiveApprovalPolicy(
  value: unknown,
  context: ValidationContext,
  depth: number,
): "never" | "untrusted" | "on-request" | "granular" | undefined {
  if (value === "untrusted" || value === "on-request" || value === "never") {
    return shortNonEmptyString(value, context) === undefined ? undefined : value;
  }
  const record = exactRecord(value, ["granular"], [], context, depth);
  if (record === undefined) return undefined;
  const granular = exactRecord(
    record.granular,
    ["sandbox_approval", "rules", "mcp_elicitations"],
    ["skill_approval", "request_permissions"],
    context,
    depth + 1,
  );
  return granular !== undefined &&
    typeof granular.sandbox_approval === "boolean" &&
    typeof granular.rules === "boolean" &&
    (!Object.hasOwn(granular, "skill_approval") || typeof granular.skill_approval === "boolean") &&
    (!Object.hasOwn(granular, "request_permissions") || typeof granular.request_permissions === "boolean") &&
    typeof granular.mcp_elicitations === "boolean"
    ? "granular"
    : undefined;
}

function decodeEffectiveSandboxMode(
  value: unknown,
  context: ValidationContext,
  depth: number,
): CodexAdapterSandboxMode | "external-sandbox" | undefined {
  const probe = inspectRecord(value, context, depth);
  if (probe === undefined || typeof probe.type !== "string") return undefined;
  switch (probe.type) {
    case "dangerFullAccess":
      return exactRecordFromInspected(probe, ["type"]) === undefined ? undefined : "danger-full-access";
    case "readOnly": {
      const record = exactRecordFromInspected(probe, ["type"], ["networkAccess"]);
      return record !== undefined &&
        (!Object.hasOwn(record, "networkAccess") || typeof record.networkAccess === "boolean")
        ? "read-only"
        : undefined;
    }
    case "externalSandbox": {
      const record = exactRecordFromInspected(probe, ["type"], ["networkAccess"]);
      return record !== undefined &&
        (!Object.hasOwn(record, "networkAccess") ||
          record.networkAccess === "restricted" ||
          record.networkAccess === "enabled")
        ? "external-sandbox"
        : undefined;
    }
    case "workspaceWrite": {
      const record = exactRecordFromInspected(
        probe,
        ["type"],
        ["writableRoots", "networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"],
      );
      return record !== undefined &&
        optionalValid(record, "writableRoots", (candidate) =>
          stringArray(candidate, context, depth + 1, CODEX_ADAPTER_LIMITS.maxArrayItems),
        ) &&
        (!Object.hasOwn(record, "networkAccess") || typeof record.networkAccess === "boolean") &&
        (!Object.hasOwn(record, "excludeTmpdirEnvVar") || typeof record.excludeTmpdirEnvVar === "boolean") &&
        (!Object.hasOwn(record, "excludeSlashTmp") || typeof record.excludeSlashTmp === "boolean")
        ? "workspace-write"
        : undefined;
    }
    default:
      return undefined;
  }
}

function validateMemoryCitation(value: unknown, context: ValidationContext, depth: number): boolean {
  if (value === null) return true;
  const record = exactRecord(value, ["entries", "threadIds"], [], context, depth);
  if (record === undefined) return false;
  const entries = denseArray(record.entries, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth + 1);
  if (entries === undefined || !identifierArray(record.threadIds, context, depth + 1)) return false;
  for (const entry of entries) {
    const citation = exactRecord(entry, ["path", "lineStart", "lineEnd", "note"], [], context, depth + 2);
    const lineStart = citation === undefined ? undefined : nonNegativeSafeInteger(citation.lineStart);
    const lineEnd = citation === undefined ? undefined : nonNegativeSafeInteger(citation.lineEnd);
    if (
      citation === undefined ||
      lineStart === undefined ||
      lineEnd === undefined ||
      lineEnd < lineStart ||
      boundedString(citation.path, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false) === undefined ||
      boundedString(citation.note, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, true) === undefined
    ) {
      return false;
    }
  }
  return true;
}

function validateCommandActions(value: unknown, context: ValidationContext, depth: number): boolean {
  const entries = denseArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth);
  if (entries === undefined) return false;
  for (const entry of entries) {
    const probe = inspectRecord(entry, context, depth + 1);
    if (probe === undefined || typeof probe.type !== "string") return false;
    let record: Record<string, unknown> | undefined;
    switch (probe.type) {
      case "read":
        record = exactRecordFromInspected(probe, ["type", "command", "name", "path"]);
        if (
          record === undefined ||
          boundedString(record.name, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false) === undefined ||
          boundedString(record.path, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false) === undefined
        ) {
          return false;
        }
        break;
      case "listFiles":
        record = exactRecordFromInspected(probe, ["type", "command"], ["path"]);
        if (
          record === undefined ||
          !optionalValid(record, "path", (candidate) =>
            nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
          )
        ) {
          return false;
        }
        break;
      case "search":
        record = exactRecordFromInspected(probe, ["type", "command"], ["query", "path"]);
        if (
          record === undefined ||
          !optionalValid(record, "query", (candidate) =>
            nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
          ) ||
          !optionalValid(record, "path", (candidate) =>
            nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
          )
        ) {
          return false;
        }
        break;
      case "unknown":
        record = exactRecordFromInspected(probe, ["type", "command"]);
        if (record === undefined) return false;
        break;
      default:
        return false;
    }
    if (boundedString(record.command, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, true) === undefined) {
      return false;
    }
  }
  return true;
}

function validateMcpAppContext(value: unknown, context: ValidationContext, depth: number): boolean {
  if (value === null) return true;
  const record = exactRecord(
    value,
    ["connectorId"],
    ["linkId", "resourceUri", "appName", "actionName"],
    context,
    depth,
  );
  return (
    record !== undefined &&
    shortNonEmptyString(record.connectorId, context) !== undefined &&
    optionalValid(record, "linkId", (candidate) => nullableShortString(candidate, context)) &&
    optionalValid(record, "resourceUri", (candidate) =>
      nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
    ) &&
    optionalValid(record, "appName", (candidate) => nullableShortString(candidate, context)) &&
    optionalValid(record, "actionName", (candidate) => nullableShortString(candidate, context))
  );
}

function validateMcpResult(value: unknown, context: ValidationContext, depth: number): boolean {
  if (value === null) return true;
  const record = exactRecord(value, ["content"], ["structuredContent", "_meta"], context, depth);
  return (
    record !== undefined &&
    validateJsonArray(record.content, context, depth + 1) &&
    optionalValid(record, "structuredContent", (candidate) => nullableJsonValue(candidate, context, depth + 1)) &&
    optionalValid(record, "_meta", (candidate) => nullableJsonValue(candidate, context, depth + 1))
  );
}

function validateMcpError(value: unknown, context: ValidationContext, depth: number): boolean {
  if (value === null) return true;
  const record = exactRecord(value, ["message"], [], context, depth);
  return (
    record !== undefined &&
    boundedString(record.message, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, true) !== undefined
  );
}

function validateDynamicContentItems(value: unknown, context: ValidationContext, depth: number): boolean {
  if (value === null) return true;
  const entries = denseArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth);
  if (entries === undefined) return false;
  for (const entry of entries) {
    const probe = inspectRecord(entry, context, depth + 1);
    if (probe === undefined || typeof probe.type !== "string") return false;
    const valueKey = probe.type === "inputText" ? "text" : probe.type === "inputImage" ? "imageUrl" : "audioUrl";
    if (probe.type !== "inputText" && probe.type !== "inputImage" && probe.type !== "inputAudio") return false;
    const record = exactRecordFromInspected(probe, ["type", valueKey]);
    if (
      record === undefined ||
      boundedString(record[valueKey], context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true) === undefined
    ) {
      return false;
    }
  }
  return true;
}

function validateHookPromptFragments(value: unknown, context: ValidationContext, depth: number): boolean {
  const entries = denseArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth);
  if (entries === undefined) return false;
  for (const entry of entries) {
    const record = exactRecord(entry, ["text", "hookRunId"], [], context, depth + 1);
    if (
      record === undefined ||
      boundedString(record.text, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true) === undefined ||
      identifier(record.hookRunId, context) === undefined
    ) {
      return false;
    }
  }
  return true;
}

function validateCollabAgentStates(value: unknown, context: ValidationContext, depth: number): boolean {
  const states = inspectRecord(value, context, depth);
  if (states === undefined) return false;
  for (const [key, state] of Object.entries(states)) {
    if (identifier(key, context) === undefined) return false;
    const record = exactRecord(state, ["status"], ["message"], context, depth + 1);
    if (
      record === undefined ||
      !COLLAB_AGENT_STATUSES.has(record.status) ||
      !optionalValid(record, "message", (candidate) => nullableShortString(candidate, context))
    ) {
      return false;
    }
  }
  return true;
}

function validateWebSearchAction(value: unknown, context: ValidationContext, depth: number): boolean {
  if (value === null) return true;
  const probe = inspectRecord(value, context, depth);
  if (probe === undefined || typeof probe.type !== "string") return false;
  switch (probe.type) {
    case "search": {
      const record = exactRecordFromInspected(probe, ["type"], ["query", "queries"]);
      return (
        record !== undefined &&
        optionalValid(record, "query", (candidate) =>
          nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
        ) &&
        optionalValid(record, "queries", (candidate) => nullableStringArray(candidate, context, depth + 1))
      );
    }
    case "openPage": {
      const record = exactRecordFromInspected(probe, ["type"], ["url"]);
      return (
        record !== undefined &&
        optionalValid(record, "url", (candidate) =>
          nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
        )
      );
    }
    case "findInPage": {
      const record = exactRecordFromInspected(probe, ["type"], ["url", "pattern"]);
      return (
        record !== undefined &&
        optionalValid(record, "url", (candidate) =>
          nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
        ) &&
        optionalValid(record, "pattern", (candidate) =>
          nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
        )
      );
    }
    case "other":
      return exactRecordFromInspected(probe, ["type"]) !== undefined;
    default:
      return false;
  }
}

function nullableJsonArray(value: unknown, context: ValidationContext, depth: number): boolean {
  return value === null || validateJsonArray(value, context, depth);
}

function nullableStringArray(value: unknown, context: ValidationContext, depth: number): boolean {
  return value === null || stringArray(value, context, depth, CODEX_ADAPTER_LIMITS.maxArrayItems);
}

function identifierArray(value: unknown, context: ValidationContext, depth: number): boolean {
  const entries = denseArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth);
  if (entries === undefined) return false;
  for (const entry of entries) {
    if (identifier(entry, context) === undefined) return false;
  }
  return true;
}

function validateUpgradeInfo(value: unknown, context: ValidationContext, depth: number): boolean {
  if (value === null) return true;
  const record = exactRecord(value, ["model"], ["upgradeCopy", "modelLink", "migrationMarkdown"], context, depth);
  return (
    record !== undefined &&
    shortNonEmptyString(record.model, context) !== undefined &&
    optionalValid(record, "upgradeCopy", (candidate) =>
      nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
    ) &&
    optionalValid(record, "modelLink", (candidate) =>
      nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
    ) &&
    optionalValid(record, "migrationMarkdown", (candidate) =>
      nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes),
    )
  );
}

function validateAvailabilityNux(value: unknown, context: ValidationContext, depth: number): boolean {
  if (value === null) return true;
  const record = exactRecord(value, ["message"], [], context, depth);
  return (
    record !== undefined &&
    boundedString(record.message, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, true) !== undefined
  );
}

function decodeServiceTiers(value: unknown, context: ValidationContext, depth: number): readonly string[] | undefined {
  const entries = denseArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth);
  if (entries === undefined) return undefined;
  const ids: string[] = [];
  const seenIds = new Set<string>();
  for (const entry of entries) {
    const record = exactRecord(entry, ["id", "name", "description"], [], context, depth + 1);
    const id = record === undefined ? undefined : identifier(record.id, context);
    if (
      record === undefined ||
      id === undefined ||
      seenIds.has(id) ||
      shortNonEmptyString(record.name, context) === undefined ||
      boundedString(record.description, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, true) === undefined
    ) {
      return undefined;
    }
    seenIds.add(id);
    ids.push(id);
  }
  return Object.freeze(ids);
}

function decodeTokenUsage(
  value: unknown,
  context: ValidationContext,
  depth: number,
): CodexValidatedTokenUsage | undefined {
  const record = exactRecord(value, ["last", "total"], ["modelContextWindow"], context, depth);
  if (record === undefined) return undefined;
  const last = decodeTokenUsageBreakdown(record.last, context, depth + 1);
  const total = decodeTokenUsageBreakdown(record.total, context, depth + 1);
  const modelContextWindow = Object.hasOwn(record, "modelContextWindow")
    ? record.modelContextWindow === null
      ? null
      : nonNegativeSafeInteger(record.modelContextWindow)
    : null;
  return last === undefined || total === undefined || modelContextWindow === undefined
    ? undefined
    : Object.freeze({ last, total, modelContextWindow });
}

function decodeTokenUsageBreakdown(
  value: unknown,
  context: ValidationContext,
  depth: number,
): CodexValidatedTokenUsageBreakdown | undefined {
  const record = exactRecord(
    value,
    ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"],
    ["cacheWriteInputTokens"],
    context,
    depth,
  );
  if (record === undefined) return undefined;
  const inputTokens = nonNegativeSafeInteger(record.inputTokens);
  const cachedInputTokens = nonNegativeSafeInteger(record.cachedInputTokens);
  const cacheWriteInputTokens = Object.hasOwn(record, "cacheWriteInputTokens")
    ? nonNegativeSafeInteger(record.cacheWriteInputTokens)
    : 0;
  const outputTokens = nonNegativeSafeInteger(record.outputTokens);
  const reasoningOutputTokens = nonNegativeSafeInteger(record.reasoningOutputTokens);
  const totalTokens = nonNegativeSafeInteger(record.totalTokens);
  return inputTokens === undefined ||
    cachedInputTokens === undefined ||
    cacheWriteInputTokens === undefined ||
    outputTokens === undefined ||
    reasoningOutputTokens === undefined ||
    totalTokens === undefined
    ? undefined
    : Object.freeze({
        inputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens,
      });
}

function validateTurnError(value: unknown, status: string, context: ValidationContext, depth: number): boolean {
  if (value === undefined || value === null) return true;
  if (status !== "failed") return false;
  return validateTurnErrorPayload(value, context, depth);
}

function validateTurnErrorPayload(value: unknown, context: ValidationContext, depth: number): boolean {
  const record = exactRecord(value, ["message"], ["codexErrorInfo", "additionalDetails"], context, depth);
  return (
    record !== undefined &&
    boundedString(record.message, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, true) !== undefined &&
    optionalValid(record, "codexErrorInfo", (candidate) => validateCodexErrorInfo(candidate, context, depth + 1)) &&
    optionalValid(record, "additionalDetails", (candidate) =>
      nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
    )
  );
}

function validateCodexErrorInfo(value: unknown, context: ValidationContext, depth: number): boolean {
  if (value === null) return true;
  if (
    value === "contextWindowExceeded" ||
    value === "sessionBudgetExceeded" ||
    value === "usageLimitExceeded" ||
    value === "serverOverloaded" ||
    value === "cyberPolicy" ||
    value === "internalServerError" ||
    value === "unauthorized" ||
    value === "badRequest" ||
    value === "threadRollbackFailed" ||
    value === "sandboxError" ||
    value === "other"
  ) {
    return shortNonEmptyString(value, context) !== undefined;
  }
  const probe = inspectRecord(value, context, depth);
  if (probe === undefined) return false;
  for (const key of [
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ]) {
    if (!Object.hasOwn(probe, key)) continue;
    const outer = exactRecordFromInspected(probe, [key]);
    if (outer === undefined) return false;
    const detail = exactRecord(outer[key], [], ["httpStatusCode"], context, depth + 1);
    return detail !== undefined && optionalValid(detail, "httpStatusCode", nullableSafeInteger);
  }
  if (!Object.hasOwn(probe, "activeTurnNotSteerable")) return false;
  const outer = exactRecordFromInspected(probe, ["activeTurnNotSteerable"]);
  const detail =
    outer === undefined ? undefined : exactRecord(outer.activeTurnNotSteerable, ["turnKind"], [], context, depth + 1);
  return detail !== undefined && (detail.turnKind === "review" || detail.turnKind === "compact");
}

function validateSessionSource(value: unknown, context: ValidationContext, depth: number): boolean {
  if (value === "cli" || value === "vscode" || value === "exec" || value === "appServer" || value === "unknown") {
    return true;
  }
  const probe = inspectRecord(value, context, depth);
  if (probe === undefined) return false;
  if (Object.hasOwn(probe, "custom")) {
    const record = exactRecordFromInspected(probe, ["custom"]);
    return record !== undefined && shortNonEmptyString(record.custom, context) !== undefined;
  }
  if (!Object.hasOwn(probe, "subAgent")) return false;
  const outer = exactRecordFromInspected(probe, ["subAgent"]);
  return outer !== undefined && validateSubAgentSource(outer.subAgent, context, depth + 1);
}

function validateSubAgentSource(value: unknown, context: ValidationContext, depth: number): boolean {
  if (value === "review" || value === "compact" || value === "memory_consolidation") return true;
  const probe = inspectRecord(value, context, depth);
  if (probe === undefined) return false;
  if (Object.hasOwn(probe, "other")) {
    const record = exactRecordFromInspected(probe, ["other"]);
    return record !== undefined && shortNonEmptyString(record.other, context) !== undefined;
  }
  if (!Object.hasOwn(probe, "thread_spawn")) return false;
  const outer = exactRecordFromInspected(probe, ["thread_spawn"]);
  if (outer === undefined) return false;
  const record = exactRecord(
    outer.thread_spawn,
    ["parent_thread_id", "depth"],
    ["agent_path", "agent_nickname", "agent_role"],
    context,
    depth + 1,
  );
  return (
    record !== undefined &&
    identifier(record.parent_thread_id, context) !== undefined &&
    nonNegativeSafeInteger(record.depth) !== undefined &&
    optionalValid(record, "agent_path", (candidate) => nullableShortString(candidate, context)) &&
    optionalValid(record, "agent_nickname", (candidate) => nullableShortString(candidate, context)) &&
    optionalValid(record, "agent_role", (candidate) => nullableShortString(candidate, context))
  );
}

function validateGitInfo(value: unknown, context: ValidationContext, depth: number): boolean {
  if (value === null) return true;
  const record = exactRecord(value, [], ["sha", "branch", "originUrl"], context, depth);
  return (
    record !== undefined &&
    optionalValid(record, "sha", (candidate) => nullableShortString(candidate, context)) &&
    optionalValid(record, "branch", (candidate) => nullableShortString(candidate, context)) &&
    optionalValid(record, "originUrl", (candidate) =>
      nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
    )
  );
}

function validateFileChanges(value: unknown, context: ValidationContext, depth: number): boolean {
  const changes = denseArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth);
  if (changes === undefined) return false;
  for (const change of changes) {
    const record = exactRecord(change, ["path", "kind", "diff"], [], context, depth + 1);
    if (
      record === undefined ||
      boundedString(record.path, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false) === undefined ||
      boundedString(record.diff, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true) === undefined ||
      !validatePatchKind(record.kind, context, depth + 2)
    ) {
      return false;
    }
  }
  return true;
}

function validatePatchKind(value: unknown, context: ValidationContext, depth: number): boolean {
  const probe = inspectRecord(value, context, depth);
  if (probe === undefined || typeof probe.type !== "string") return false;
  if (probe.type === "add" || probe.type === "delete") {
    return exactRecordFromInspected(probe, ["type"]) !== undefined;
  }
  if (probe.type !== "update") return false;
  const record = exactRecordFromInspected(probe, ["type"], ["move_path"]);
  return (
    record !== undefined &&
    optionalValid(record, "move_path", (candidate) =>
      nullableBoundedString(candidate, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes),
    )
  );
}

function validateUserInputs(value: unknown, context: ValidationContext, depth: number): boolean {
  const entries = denseArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth);
  if (entries === undefined) return false;
  for (const entry of entries) {
    const probe = inspectRecord(entry, context, depth + 1);
    if (probe === undefined || typeof probe.type !== "string") return false;
    switch (probe.type) {
      case "text": {
        const record = exactRecordFromInspected(probe, ["type", "text"], ["text_elements"]);
        const text =
          record === undefined
            ? undefined
            : boundedString(record.text, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true);
        if (
          record === undefined ||
          text === undefined ||
          (Object.hasOwn(record, "text_elements") &&
            !validateTextElements(record.text_elements, text, context, depth + 2))
        ) {
          return false;
        }
        break;
      }
      case "image": {
        const record = exactRecordFromInspected(probe, ["type", "url"], ["detail"]);
        if (
          record === undefined ||
          boundedString(record.url, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false) === undefined ||
          (Object.hasOwn(record, "detail") &&
            record.detail !== null &&
            record.detail !== "auto" &&
            record.detail !== "low" &&
            record.detail !== "high" &&
            record.detail !== "original")
        ) {
          return false;
        }
        break;
      }
      case "localImage": {
        const record = exactRecordFromInspected(probe, ["type", "path"], ["detail"]);
        if (
          record === undefined ||
          boundedString(record.path, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false) === undefined ||
          (Object.hasOwn(record, "detail") &&
            record.detail !== null &&
            record.detail !== "auto" &&
            record.detail !== "low" &&
            record.detail !== "high" &&
            record.detail !== "original")
        ) {
          return false;
        }
        break;
      }
      case "audio": {
        const record = exactRecordFromInspected(probe, ["type", "url"]);
        if (
          record === undefined ||
          boundedString(record.url, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false) === undefined
        ) {
          return false;
        }
        break;
      }
      case "localAudio": {
        const record = exactRecordFromInspected(probe, ["type", "path"]);
        if (
          record === undefined ||
          boundedString(record.path, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false) === undefined
        ) {
          return false;
        }
        break;
      }
      case "skill":
      case "mention": {
        const record = exactRecordFromInspected(probe, ["type", "name", "path"]);
        if (
          record === undefined ||
          shortNonEmptyString(record.name, context) === undefined ||
          boundedString(record.path, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false) === undefined
        ) {
          return false;
        }
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

function validateTextElements(value: unknown, text: string, context: ValidationContext, depth: number): boolean {
  const entries = denseArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth);
  if (entries === undefined) return false;
  const textBytes = Buffer.byteLength(text, "utf8");
  for (const entry of entries) {
    const record = exactRecord(entry, ["byteRange"], ["placeholder"], context, depth + 1);
    if (
      record === undefined ||
      !optionalValid(record, "placeholder", (candidate) => nullableShortString(candidate, context))
    ) {
      return false;
    }
    const range = exactRecord(record.byteRange, ["start", "end"], [], context, depth + 2);
    const start = range === undefined ? undefined : nonNegativeSafeInteger(range.start);
    const end = range === undefined ? undefined : nonNegativeSafeInteger(range.end);
    if (range === undefined || start === undefined || end === undefined || start > end || end > textBytes) return false;
  }
  return true;
}

function textContentBlocks(
  value: unknown,
  context: ValidationContext,
  depth: number,
): readonly Readonly<{ type: "text"; text: string }>[] | undefined {
  const entries = denseArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth);
  if (entries === undefined) return undefined;
  const blocks: Readonly<{ type: "text"; text: string }>[] = [];
  for (const entry of entries) {
    const record = exactRecord(entry, ["type", "text"], [], context, depth + 1);
    const text =
      record === undefined
        ? undefined
        : boundedString(record.text, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true);
    if (record === undefined || record.type !== "text" || text === undefined) return undefined;
    blocks.push(Object.freeze({ type: "text", text }));
  }
  return Object.freeze(blocks);
}

function decodeStringArray(
  value: unknown,
  context: ValidationContext,
  depth: number,
  maxItems: number,
): readonly string[] | undefined {
  const entries = denseArray(value, maxItems, context, depth);
  if (entries === undefined) return undefined;
  const strings: string[] = [];
  for (const entry of entries) {
    const text = boundedString(entry, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true);
    if (text === undefined) return undefined;
    strings.push(text);
  }
  return Object.freeze(strings);
}

function stringArray(value: unknown, context: ValidationContext, depth: number, maxItems: number): boolean {
  return decodeStringArray(value, context, depth, maxItems) !== undefined;
}

function validateJsonArray(value: unknown, context: ValidationContext, depth: number): boolean {
  const entries = denseArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth);
  return entries !== undefined && entries.every((entry) => validateJsonValue(entry, context, depth + 1));
}

function nullableJsonValue(value: unknown, context: ValidationContext, depth: number): boolean {
  return value === null || validateJsonValue(value, context, depth);
}

function validateJsonValue(value: unknown, context: ValidationContext, depth: number): boolean {
  return snapshotJsonValue(value, context, depth) !== INVALID;
}

function snapshotJsonValue(value: unknown, context: ValidationContext, depth: number): unknown | typeof INVALID {
  if (value === null) return consumeBytes(context, 4) ? null : INVALID;
  if (typeof value === "boolean") return consumeBytes(context, value ? 4 : 5) ? value : INVALID;
  if (typeof value === "number") {
    return Number.isFinite(value) && consumeBytes(context, Buffer.byteLength(String(value), "utf8")) ? value : INVALID;
  }
  if (typeof value === "string") {
    return boundedString(value, context, CODEX_ADAPTER_LIMITS.maxItemTextBytes, true) ?? INVALID;
  }
  if (Array.isArray(value)) {
    const entries = denseArray(value, CODEX_ADAPTER_LIMITS.maxArrayItems, context, depth);
    if (entries === undefined) return INVALID;
    const snapshot: unknown[] = [];
    for (const entry of entries) {
      const decoded = snapshotJsonValue(entry, context, depth + 1);
      if (decoded === INVALID) return INVALID;
      snapshot.push(decoded);
    }
    return Object.freeze(snapshot);
  }
  const record = inspectRecord(value, context, depth);
  if (record === undefined) return INVALID;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    const decoded = snapshotJsonValue(entry, context, depth + 1);
    if (decoded === INVALID) return INVALID;
    snapshot[key] = decoded;
  }
  return Object.freeze(snapshot);
}

function validateInspectedJsonRecord(
  record: Record<string, unknown>,
  context: ValidationContext,
  depth: number,
): boolean {
  for (const entry of Object.values(record)) {
    if (!validateJsonValue(entry, context, depth + 1)) return false;
  }
  return true;
}

function boundedUnknownCorrelation(params: unknown): Readonly<{ threadId?: string; turnId?: string; itemId?: string }> {
  if (!plainObjectWithoutAccessors(params)) return Object.freeze({});
  const result: { threadId?: string; turnId?: string; itemId?: string } = {};
  for (const key of ["threadId", "turnId", "itemId"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(params, key);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    const value = descriptor.value as unknown;
    if (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= CODEX_ADAPTER_LIMITS.maxIdentifierCharacters &&
      Buffer.byteLength(value, "utf8") <= CODEX_ADAPTER_LIMITS.maxIdentifierBytes
    ) {
      result[key] = value;
    }
  }
  return Object.freeze(result);
}

const ABSENT = Symbol("absent");
const INVALID = Symbol("invalid");

function optional<T>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  decode: (value: unknown) => T | undefined,
): T | typeof ABSENT | typeof INVALID {
  if (!Object.hasOwn(record, key)) return ABSENT;
  return decode(record[key]) ?? INVALID;
}

function optionalValid(
  record: Readonly<Record<string, unknown>>,
  key: string,
  validateValue: (value: unknown) => boolean,
): boolean {
  return !Object.hasOwn(record, key) || validateValue(record[key]);
}

function createContext(maxAggregateBytes = CODEX_ADAPTER_LIMITS.maxValidationAggregateBytes): ValidationContext {
  return { seen: new WeakSet(), aggregateBytes: 0, maxAggregateBytes };
}

function validate<T>(operation: () => T | undefined): CodexValidationResult<T> {
  try {
    const value = operation();
    return value === undefined ? Object.freeze({ ok: false }) : Object.freeze({ ok: true, value });
  } catch {
    return Object.freeze({ ok: false });
  }
}

function exactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  context: ValidationContext,
  depth: number,
): Record<string, unknown> | undefined {
  const inspected = inspectRecord(value, context, depth);
  return inspected === undefined ? undefined : exactRecordFromInspected(inspected, requiredKeys, optionalKeys);
}

function inspectRecord(value: unknown, context: ValidationContext, depth: number): Record<string, unknown> | undefined {
  if (depth > CODEX_ADAPTER_LIMITS.maxObjectDepth || !plainObjectWithoutAccessors(value)) return undefined;
  if (!markSeen(value, context)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > CODEX_ADAPTER_LIMITS.maxObjectProperties || keys.some((key) => typeof key !== "string")) {
    return undefined;
  }
  if (!consumeBytes(context, 2 + Math.max(0, keys.length - 1))) return undefined;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !consumeJsonString(key, context) ||
      !consumeBytes(context, 1)
    ) {
      return undefined;
    }
    snapshot[key] = descriptor.value as unknown;
  }
  return snapshot;
}

function exactRecordFromInspected(
  record: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> | undefined {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.has(key)) || requiredKeys.some((key) => !Object.hasOwn(record, key))) {
    return undefined;
  }
  return record;
}

function denseArray(
  value: unknown,
  maxItems: number,
  context: ValidationContext,
  depth: number,
): readonly unknown[] | undefined {
  if (
    depth > CODEX_ADAPTER_LIMITS.maxObjectDepth ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maxItems ||
    !markSeen(value, context)
  ) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || (key !== "length" && !arrayIndexWithinLength(key, value.length)))) {
    return undefined;
  }
  if (!consumeBytes(context, 2 + Math.max(0, value.length - 1))) return undefined;
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    snapshot.push(descriptor.value as unknown);
  }
  return snapshot;
}

function arrayIndexWithinLength(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function markSeen(value: object, context: ValidationContext): boolean {
  if (context.seen.has(value)) return false;
  context.seen.add(value);
  return true;
}

function plainObjectWithoutAccessors(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function consumeBytes(context: ValidationContext, bytes: number): boolean {
  if (context.aggregateBytes + bytes > context.maxAggregateBytes) return false;
  context.aggregateBytes += bytes;
  return true;
}

function consumeJsonString(value: string, context: ValidationContext): boolean {
  return consumeBytes(context, Buffer.byteLength(JSON.stringify(value), "utf8"));
}

function boundedString(
  value: unknown,
  context: ValidationContext,
  maxBytes: number,
  allowEmpty: boolean,
): string | undefined {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) return undefined;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes || !consumeJsonString(value, context)) return undefined;
  return value;
}

function shortNonEmptyString(value: unknown, context: ValidationContext): string | undefined {
  return boundedString(value, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false);
}

function methodString(value: unknown, context: ValidationContext): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > CODEX_ADAPTER_LIMITS.maxMethodCharacters) {
    return undefined;
  }
  return boundedString(value, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false);
}

function identifier(value: unknown, context: ValidationContext): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > CODEX_ADAPTER_LIMITS.maxIdentifierCharacters) {
    return undefined;
  }
  return boundedString(value, context, CODEX_ADAPTER_LIMITS.maxIdentifierBytes, false);
}

function nullableIdentifier(value: unknown, context: ValidationContext): boolean {
  return value === null || identifier(value, context) !== undefined;
}

function nullableString(
  value: unknown,
  context: ValidationContext,
  maxBytes: number,
): Readonly<{ value: string | null }> | undefined {
  if (value === null) return Object.freeze({ value: null });
  const decoded = boundedString(value, context, maxBytes, true);
  return decoded === undefined ? undefined : Object.freeze({ value: decoded });
}

function nullableNonEmptyString(
  value: unknown,
  context: ValidationContext,
  maxBytes: number,
): Readonly<{ value: string | null }> | undefined {
  if (value === null) return Object.freeze({ value: null });
  const decoded = boundedString(value, context, maxBytes, false);
  return decoded === undefined ? undefined : Object.freeze({ value: decoded });
}

function nullableBoundedString(value: unknown, context: ValidationContext, maxBytes: number): boolean {
  return value === null || boundedString(value, context, maxBytes, true) !== undefined;
}

function nullableShortString(value: unknown, context: ValidationContext): boolean {
  return nullableBoundedString(value, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes);
}

function nullableNonEmptyShortString(value: unknown, context: ValidationContext): boolean {
  return value === null || shortNonEmptyString(value, context) !== undefined;
}

function workspacePathString(value: unknown, context: ValidationContext): string | undefined {
  return workspaceIdentity(value, context)?.workspacePath;
}

function workspaceIdentity(value: unknown, context: ValidationContext): WorkspaceIdentity | undefined {
  const raw = boundedString(value, context, CODEX_ADAPTER_LIMITS.maxShortStringBytes, false);
  return raw === undefined ? undefined : resolveWorkspaceIdentity(raw);
}

function approvalPolicyValue(value: unknown): CodexAdapterApprovalPolicy | undefined {
  return typeof value === "string" && APPROVAL_POLICIES.has(value) ? (value as CodexAdapterApprovalPolicy) : undefined;
}

function sandboxModeValue(value: unknown): CodexAdapterSandboxMode | undefined {
  return typeof value === "string" && SANDBOX_MODES.has(value) ? (value as CodexAdapterSandboxMode) : undefined;
}

function positiveSafeInteger(value: unknown, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum
    ? (value as number)
    : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function nullableSafeInteger(value: unknown): boolean {
  return value === null || nonNegativeSafeInteger(value) !== undefined;
}

function nullableSignedInt32(value: unknown): boolean {
  return (
    value === null ||
    (Number.isInteger(value) && (value as number) >= -2_147_483_648 && (value as number) <= 2_147_483_647)
  );
}
