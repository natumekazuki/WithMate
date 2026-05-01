import path from "node:path";

import { Codex, type Thread, type ThreadEvent, type ThreadItem, type Usage } from "@openai/codex-sdk";

import type {
  AppSettings,
  AuditLogOperation,
  AuditTransportPayload,
  AuditLogUsage,
  ChangedFile,
  CharacterReflectionOutput,
  CharacterProfile,
  DiffRow,
  LiveRunStep,
  LiveSessionRunState,
  MessageArtifact,
  RunCheck,
  Session,
  SessionMemoryDelta,
} from "../src/app-state.js";
import { getProviderAppSettings } from "../src/provider-settings-state.js";
import { mapApprovalModeToCodexPolicy } from "../src/approval-mode.js";
import {
  resolveCodexSandboxThreadOptions,
  type CodexSdkSandboxMode,
} from "../src/codex-sandbox-mode.js";
import {
  reasoningEffortLabel,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelReasoningEffort,
  type ResolvedModelSelection,
} from "../src/model-catalog.js";
import {
  createWorkspaceSnapshotIndex,
  refreshWorkspaceSnapshotIndex,
  type SnapshotCaptureStats,
  type WorkspaceSnapshotIndex,
  type WorkspaceSnapshot,
} from "./snapshot-ignore.js";
import { normalizeAllowedAdditionalDirectories } from "./additional-directories.js";
import { composeProviderPrompt, isCanceledProviderMessage } from "./provider-prompt.js";
import {
  ProviderTurnError,
  resolveRunWorkspacePath,
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
import { resolvePackagedProviderBinaryPath } from "./provider-binary-paths.js";
const MAX_DIFF_MATRIX_CELLS = 2_000_000;

function summarizeChangedFile(kind: ChangedFile["kind"], filePath: string): string {
  switch (kind) {
    case "add":
      return `${filePath} を新規作成した`;
    case "delete":
      return `${filePath} を削除した`;
    default:
      return `${filePath} を更新した`;
  }
}

function normalizeWorkspaceRelativePath(workspacePath: string, filePath: string): string {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(workspacePath, filePath);
  const relativePath = path.relative(workspacePath, resolvedPath);

  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.replace(/\\/g, "/");
  }

  return filePath.replace(/\\/g, "/");
}

function toLines(content: string | null): string[] {
  if (!content) {
    return [];
  }

  return content.split(/\r?\n/);
}

type RawDiffOp =
  | { kind: "context"; leftNumber: number; rightNumber: number; leftText: string; rightText: string }
  | { kind: "delete"; leftNumber: number; leftText: string }
  | { kind: "add"; rightNumber: number; rightText: string };

type CodexTurnStreamState = {
  items: Map<string, ThreadItem>;
  liveSteps: Map<string, LiveRunStep>;
  threadId: string | null;
  streamedAssistantText: string;
  finalAssistantText: string;
  usage: Usage | null;
  liveUsage: AuditLogUsage | null;
  streamErrorMessage: string;
};

type CodexEventRecord = Record<string, unknown>;

export type CodexThreadOptions = {
  workingDirectory: string;
  skipGitRepoCheck: true;
  sandboxMode: CodexSdkSandboxMode;
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
  model: string;
  modelReasoningEffort: ModelReasoningEffort;
  networkAccessEnabled?: boolean;
  additionalDirectories?: string[];
};

export type CodexThreadSettings = {
  options: CodexThreadOptions;
  selection: ResolvedModelSelection;
  settingsKey: string;
};

type CodexThreadConnector = Pick<Codex, "resumeThread" | "startThread">;

type CachedCodexThread = {
  thread: Thread;
  settingsKey: string;
};

function buildFallbackDiffRows(beforeLines: string[], afterLines: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  const maxLength = Math.max(beforeLines.length, afterLines.length);

  for (let index = 0; index < maxLength; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];

    if (beforeLine === afterLine && beforeLine !== undefined) {
      rows.push({
        kind: "context",
        leftNumber: index + 1,
        rightNumber: index + 1,
        leftText: beforeLine,
        rightText: afterLine,
      });
      continue;
    }

    if (beforeLine !== undefined && afterLine !== undefined) {
      rows.push({
        kind: "modify",
        leftNumber: index + 1,
        rightNumber: index + 1,
        leftText: beforeLine,
        rightText: afterLine,
      });
      continue;
    }

    if (beforeLine !== undefined) {
      rows.push({
        kind: "delete",
        leftNumber: index + 1,
        leftText: beforeLine,
      });
      continue;
    }

    rows.push({
      kind: "add",
      rightNumber: index + 1,
      rightText: afterLine ?? "",
    });
  }

  return rows;
}

function buildDiffRows(beforeContent: string | null, afterContent: string | null): DiffRow[] {
  const beforeLines = toLines(beforeContent);
  const afterLines = toLines(afterContent);

  if (beforeLines.length === 0 && afterLines.length === 0) {
    return [];
  }

  const cellCount = (beforeLines.length + 1) * (afterLines.length + 1);
  if (cellCount > MAX_DIFF_MATRIX_CELLS) {
    return buildFallbackDiffRows(beforeLines, afterLines);
  }

  const lcs: number[][] = Array.from({ length: beforeLines.length + 1 }, () =>
    Array.from({ length: afterLines.length + 1 }, () => 0),
  );

  for (let left = beforeLines.length - 1; left >= 0; left -= 1) {
    for (let right = afterLines.length - 1; right >= 0; right -= 1) {
      lcs[left][right] =
        beforeLines[left] === afterLines[right]
          ? lcs[left + 1][right + 1] + 1
          : Math.max(lcs[left + 1][right], lcs[left][right + 1]);
    }
  }

  const operations: RawDiffOp[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < beforeLines.length && rightIndex < afterLines.length) {
    if (beforeLines[leftIndex] === afterLines[rightIndex]) {
      operations.push({
        kind: "context",
        leftNumber: leftIndex + 1,
        rightNumber: rightIndex + 1,
        leftText: beforeLines[leftIndex],
        rightText: afterLines[rightIndex],
      });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    if (lcs[leftIndex][rightIndex + 1] >= lcs[leftIndex + 1][rightIndex]) {
      operations.push({
        kind: "add",
        rightNumber: rightIndex + 1,
        rightText: afterLines[rightIndex],
      });
      rightIndex += 1;
      continue;
    }

    operations.push({
      kind: "delete",
      leftNumber: leftIndex + 1,
      leftText: beforeLines[leftIndex],
    });
    leftIndex += 1;
  }

  while (leftIndex < beforeLines.length) {
    operations.push({
      kind: "delete",
      leftNumber: leftIndex + 1,
      leftText: beforeLines[leftIndex],
    });
    leftIndex += 1;
  }

  while (rightIndex < afterLines.length) {
    operations.push({
      kind: "add",
      rightNumber: rightIndex + 1,
      rightText: afterLines[rightIndex],
    });
    rightIndex += 1;
  }

  const rows: DiffRow[] = [];

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.kind === "context") {
      rows.push({
        kind: "context",
        leftNumber: operation.leftNumber,
        rightNumber: operation.rightNumber,
        leftText: operation.leftText,
        rightText: operation.rightText,
      });
      continue;
    }

    const block: RawDiffOp[] = [];
    let cursor = index;
    while (cursor < operations.length && operations[cursor].kind !== "context") {
      block.push(operations[cursor]);
      cursor += 1;
    }

    const deletes = block.filter((entry): entry is Extract<RawDiffOp, { kind: "delete" }> => entry.kind === "delete");
    const adds = block.filter((entry): entry is Extract<RawDiffOp, { kind: "add" }> => entry.kind === "add");
    const pairedCount = Math.min(deletes.length, adds.length);

    for (let pairIndex = 0; pairIndex < pairedCount; pairIndex += 1) {
      rows.push({
        kind: "modify",
        leftNumber: deletes[pairIndex].leftNumber,
        rightNumber: adds[pairIndex].rightNumber,
        leftText: deletes[pairIndex].leftText,
        rightText: adds[pairIndex].rightText,
      });
    }

    for (let deleteIndex = pairedCount; deleteIndex < deletes.length; deleteIndex += 1) {
      rows.push({
        kind: "delete",
        leftNumber: deletes[deleteIndex].leftNumber,
        leftText: deletes[deleteIndex].leftText,
      });
    }

    for (let addIndex = pairedCount; addIndex < adds.length; addIndex += 1) {
      rows.push({
        kind: "add",
        rightNumber: adds[addIndex].rightNumber,
        rightText: adds[addIndex].rightText,
      });
    }

    index = cursor - 1;
  }

  return rows;
}

function inferChangedFileKind(beforeContent: string | null, afterContent: string | null): ChangedFile["kind"] | null {
  if (beforeContent === null && afterContent !== null) {
    return "add";
  }

  if (beforeContent !== null && afterContent === null) {
    return "delete";
  }

  if (beforeContent !== null && afterContent !== null && beforeContent !== afterContent) {
    return "edit";
  }

  return null;
}

function compareSnapshotChanges(beforeSnapshot: WorkspaceSnapshot, afterSnapshot: WorkspaceSnapshot): Array<{
  path: string;
  kind: ChangedFile["kind"];
}> {
  const paths = new Set<string>([...beforeSnapshot.keys(), ...afterSnapshot.keys()]);
  const changes: Array<{ path: string; kind: ChangedFile["kind"] }> = [];

  for (const filePath of paths) {
    const kind = inferChangedFileKind(beforeSnapshot.get(filePath) ?? null, afterSnapshot.get(filePath) ?? null);
    if (!kind) {
      continue;
    }

    changes.push({ path: filePath, kind });
  }

  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function collectCompletedFileChangeItems(items: ThreadItem[]): Array<Extract<ThreadItem, { type: "file_change" }>> {
  return items.filter(
    (item): item is Extract<ThreadItem, { type: "file_change" }> =>
      item.type === "file_change" && item.status === "completed",
  );
}

function collectCompletedFileChangePaths(workspacePath: string, items: ThreadItem[]): string[] {
  const paths = new Set<string>();

  for (const item of collectCompletedFileChangeItems(items)) {
    for (const change of item.changes) {
      paths.add(normalizeWorkspaceRelativePath(workspacePath, change.path));
    }
  }

  return Array.from(paths).sort((left, right) => left.localeCompare(right));
}

function hasBroadFilesystemChangeSource(items: ThreadItem[]): boolean {
  return items.some((item) => {
    if ("status" in item && item.status !== "completed") {
      return false;
    }

    return item.type === "command_execution" || item.type === "mcp_tool_call";
  });
}

function buildChangedFilesFromSources(
  workspacePath: string,
  items: ThreadItem[],
  beforeSnapshot: WorkspaceSnapshot,
  afterSnapshot: WorkspaceSnapshot,
  useSnapshotFallback: boolean,
): ChangedFile[] {
  const explicitChanges = collectCompletedFileChangeItems(items)
    .flatMap((item) => item.changes)
    .map((change) => {
      const kind: ChangedFile["kind"] = change.kind === "update" ? "edit" : change.kind;
      const displayPath = normalizeWorkspaceRelativePath(workspacePath, change.path);

      return {
        kind,
        path: displayPath,
      };
    });

  const mergedChanges = new Map<string, ChangedFile["kind"]>();
  for (const change of explicitChanges) {
    mergedChanges.set(change.path, change.kind);
  }

  if (useSnapshotFallback) {
    for (const change of compareSnapshotChanges(beforeSnapshot, afterSnapshot)) {
      if (!mergedChanges.has(change.path)) {
        mergedChanges.set(change.path, change.kind);
      }
    }
  }

  return Array.from(mergedChanges.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([filePath, kind]) => {
      const beforeContent = beforeSnapshot.get(filePath) ?? null;
      const afterContent = afterSnapshot.get(filePath) ?? null;

      return {
        kind,
        path: filePath,
        summary: summarizeChangedFile(kind, filePath),
        diffRows: buildDiffRows(kind === "add" ? null : beforeContent, kind === "delete" ? null : afterContent),
      };
    });
}

function toActivitySummary(items: ThreadItem[]): string[] {
  const summary: string[] = [];

  for (const item of items) {
    switch (item.type) {
      case "command_execution":
        if (item.status === "completed") {
          summary.push(`command: ${item.command}`);
        }
        break;
      case "mcp_tool_call":
        if (item.status === "completed") {
          summary.push(`mcp: ${item.server}/${item.tool}`);
        }
        break;
      case "web_search":
        summary.push(`web: ${item.query}`);
        break;
      case "todo_list":
        if (item.items.length > 0) {
          summary.push(`todo: ${item.items.filter((entry) => entry.completed).length}/${item.items.length} completed`);
        }
        break;
      case "reasoning":
        if (item.text.trim()) {
          summary.push(item.text.trim());
        }
        break;
      default:
        break;
    }
  }

  return summary.slice(0, 6);
}

function collectAssistantText(items: Iterable<ThreadItem>): string {
  const parts: string[] = [];

  for (const item of items) {
    if (item.type !== "agent_message") {
      continue;
    }

    if (item.text.trim().length === 0) {
      continue;
    }

    parts.push(item.text);
  }

  return parts.join("\n\n");
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

function toAuditOperations(items: ThreadItem[]): AuditLogOperation[] {
  const operations: AuditLogOperation[] = [];

  for (const item of items) {
    switch (item.type) {
      case "command_execution":
        operations.push({
          type: item.type,
          summary: item.command,
          details: item.aggregated_output || (typeof item.exit_code === "number" ? `exit code: ${item.exit_code}` : undefined),
        });
        break;
      case "file_change":
        for (const change of item.changes) {
          operations.push({
            type: item.type,
            summary: `${change.kind}: ${change.path}`,
          });
        }
        break;
      case "mcp_tool_call":
        operations.push({
          type: item.type,
          summary: `${item.server}/${item.tool}`,
          details: item.error?.message ?? stringifyUnknown(item.result?.structured_content ?? item.arguments),
        });
        break;
      case "web_search":
        operations.push({
          type: item.type,
          summary: item.query,
        });
        break;
      case "todo_list":
        operations.push({
          type: item.type,
          summary: `${item.items.filter((entry) => entry.completed).length}/${item.items.length} completed`,
          details: item.items.map((entry) => `${entry.completed ? "[x]" : "[ ]"} ${entry.text}`).join("\n"),
        });
        break;
      case "reasoning":
        operations.push({
          type: item.type,
          summary: item.text,
        });
        break;
      case "error":
        operations.push({
          type: item.type,
          summary: item.message,
        });
        break;
      case "agent_message":
        operations.push({
          type: item.type,
          summary: item.text,
        });
        break;
      default:
        operations.push({
          type: "unknown",
          summary: stringifyUnknown(item) ?? "unknown item",
        });
        break;
    }
  }

  return operations;
}

function toAuditUsage(usage: Usage | null): AuditLogUsage | null {
  if (!usage) {
    return null;
  }

  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
  };
}

function toLiveStepStatus(value: string | undefined): LiveRunStep["status"] {
  if (value === "completed") {
    return "completed";
  }

  if (value === "failed") {
    return "failed";
  }

  return "in_progress";
}

function buildLiveStep(item: ThreadItem): LiveRunStep | null {
  switch (item.type) {
    case "command_execution":
      return {
        id: item.id,
        type: item.type,
        summary: item.command,
        details: item.aggregated_output || undefined,
        status: toLiveStepStatus(item.status),
      };
    case "file_change":
      return {
        id: item.id,
        type: item.type,
        summary: item.changes.map((change) => `${change.kind}: ${change.path}`).join("\n"),
        status: toLiveStepStatus(item.status),
      };
    case "mcp_tool_call":
      return {
        id: item.id,
        type: item.type,
        summary: `${item.server}/${item.tool}`,
        details: item.error?.message ?? stringifyUnknown(item.result?.structured_content ?? item.arguments),
        status: toLiveStepStatus(item.status),
      };
    case "web_search":
      return {
        id: item.id,
        type: item.type,
        summary: item.query,
        status: "completed",
      };
    case "todo_list":
      return {
        id: item.id,
        type: item.type,
        summary: `${item.items.filter((entry) => entry.completed).length}/${item.items.length} completed`,
        details: item.items.map((entry) => `${entry.completed ? "[x]" : "[ ]"} ${entry.text}`).join("\n"),
        status: "completed",
      };
    case "reasoning":
      return {
        id: item.id,
        type: item.type,
        summary: item.text,
        status: "completed",
      };
    case "error":
      return {
        id: item.id,
        type: item.type,
        summary: item.message,
        status: "failed",
      };
    case "agent_message":
      return null;
    default:
      return null;
  }
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
    backgroundTasks: [],
    usage,
    errorMessage,
    approvalRequest: null,
    elicitationRequest: null,
  });
}

function createCodexTurnStreamState(threadId: string | null): CodexTurnStreamState {
  return {
    items: new Map<string, ThreadItem>(),
    liveSteps: new Map<string, LiveRunStep>(),
    threadId,
    streamedAssistantText: "",
    finalAssistantText: "",
    usage: null,
    liveUsage: null,
    streamErrorMessage: "",
  };
}

function readStringProperty(source: unknown, keys: string[]): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }

  const record = source as CodexEventRecord;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }

  return null;
}

function readStringFromUnknown(source: unknown): string | null {
  if (typeof source === "string") {
    return source;
  }

  if (Array.isArray(source)) {
    const parts = source
      .map((item) => readStringFromUnknown(item))
      .filter((item): item is string => item !== null);
    return parts.length > 0 ? parts.join("") : null;
  }

  if (!source || typeof source !== "object") {
    return null;
  }

  const record = source as CodexEventRecord;
  const directValue = readStringProperty(record, [
    "delta",
    "text_delta",
    "message_delta",
    "content_delta",
    "deltaContent",
    "text",
    "content",
    "value",
    "output",
  ]);
  if (directValue !== null) {
    return directValue;
  }

  for (const key of ["delta", "data", "message", "item", "content", "output", "part"]) {
    const nestedValue = readStringFromUnknown(record[key]);
    if (nestedValue !== null) {
      return nestedValue;
    }
  }

  return null;
}

function readCodexAssistantDelta(event: ThreadEvent): string | null {
  const record = event as unknown as CodexEventRecord;
  const eventType = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (!eventType.includes("delta")) {
    return null;
  }

  const isAssistantTextDelta =
    eventType.includes("agent_message")
    || eventType.includes("assistant")
    || eventType.includes("message")
    || eventType.includes("output_text");
  if (!isAssistantTextDelta) {
    return null;
  }

  return readStringFromUnknown(record);
}

function getLiveAssistantText(state: CodexTurnStreamState): string {
  return state.finalAssistantText || state.streamedAssistantText;
}

function applyCodexTurnEvent(state: CodexTurnStreamState, event: ThreadEvent): void {
  const assistantDelta = readCodexAssistantDelta(event);
  if (assistantDelta !== null) {
    state.streamedAssistantText += assistantDelta;
  }

  switch (event.type) {
    case "thread.started":
      state.threadId = event.thread_id;
      break;
    case "turn.completed":
      state.usage = event.usage;
      state.liveUsage = toAuditUsage(event.usage);
      break;
    case "turn.failed":
      state.streamErrorMessage = event.error.message;
      break;
    case "error":
      state.streamErrorMessage = event.message;
      break;
    case "item.started":
    case "item.updated":
    case "item.completed": {
      state.items.set(event.item.id, event.item);
      if (event.item.type === "agent_message") {
        const itemAssistantText = collectAssistantText(state.items.values());
        if (itemAssistantText.trim().length > 0) {
          state.finalAssistantText = itemAssistantText;
        }
      }

      const liveStep = buildLiveStep(event.item);
      if (liveStep) {
        state.liveSteps.set(liveStep.id, liveStep);
      }
      break;
    }
    default:
      break;
  }
}

export function collectCodexAssistantTextFromEventsForTesting(events: ThreadEvent[]): string {
  const state = createCodexTurnStreamState(null);
  for (const event of events) {
    applyCodexTurnEvent(state, event);
  }
  return getLiveAssistantText(state);
}

export function collectCodexAssistantTextSnapshotsFromEventsForTesting(events: ThreadEvent[]): string[] {
  const state = createCodexTurnStreamState(null);
  const snapshots: string[] = [];
  for (const event of events) {
    applyCodexTurnEvent(state, event);
    snapshots.push(getLiveAssistantText(state));
  }
  return snapshots;
}

function buildCodexTransportPayload(prompt: ProviderPromptComposition): AuditTransportPayload {
  const fields = [
    {
      label: "thread.runStreamed.text",
      value: prompt.logicalPrompt.composedText,
    },
  ];

  if (prompt.imagePaths.length > 0) {
    fields.push({
      label: "thread.runStreamed.images",
      value: prompt.imagePaths.join("\n"),
    });
  }

  if (prompt.additionalDirectories.length > 0) {
    fields.push({
      label: "thread.additionalDirectories",
      value: prompt.additionalDirectories.join("\n"),
    });
  }

  return {
    summary: "Codex thread.runStreamed payload",
    fields,
  };
}

function toRunChecks(
  session: Session,
  usage: Usage | null,
  threadId: string | null,
  providerCatalog: ModelCatalogProvider,
  selection: ResolvedModelSelection,
  beforeSnapshotStats: SnapshotCaptureStats,
  afterSnapshotStats: SnapshotCaptureStats,
): RunCheck[] {
  const checks: RunCheck[] = [
    { label: "provider", value: providerCatalog.label },
    { label: "approval", value: session.approvalMode },
    { label: "model", value: selection.resolvedModel },
    { label: "reasoning", value: reasoningEffortLabel(selection.resolvedReasoningEffort) },
  ];

  if (threadId) {
    checks.push({ label: "thread", value: threadId });
  }

  if (usage) {
    checks.push({ label: "tokens", value: `${usage.input_tokens}/${usage.output_tokens}` });
  }

  const beforeSnapshotWarning = summarizeSnapshotWarning(beforeSnapshotStats);
  if (beforeSnapshotWarning) {
    checks.push({ label: "snapshot before", value: beforeSnapshotWarning });
  }

  const afterSnapshotWarning = summarizeSnapshotWarning(afterSnapshotStats);
  if (afterSnapshotWarning) {
    checks.push({ label: "snapshot after", value: afterSnapshotWarning });
  }

  return checks;
}

function summarizeSnapshotWarning(stats: SnapshotCaptureStats): string {
  const warnings: string[] = [];
  if (stats.skippedBinaryOrOversizeFiles > 0) {
    warnings.push(`binary/oversize ${stats.skippedBinaryOrOversizeFiles}`);
  }
  if (stats.skippedByLimitFiles > 0) {
    warnings.push(`limit skipped ${stats.skippedByLimitFiles}`);
  }
  if (stats.hitFileCountLimit) {
    warnings.push("file limit hit");
  }
  if (stats.hitTotalBytesLimit) {
    warnings.push("size limit hit");
  }

  return warnings.join(", ");
}

async function buildArtifact(
  session: Session,
  workspacePath: string,
  items: ThreadItem[],
  usage: Usage | null,
  threadId: string | null,
  beforeSnapshot: WorkspaceSnapshot,
  afterSnapshot: WorkspaceSnapshot,
  beforeSnapshotStats: SnapshotCaptureStats,
  afterSnapshotStats: SnapshotCaptureStats,
  useSnapshotFallback: boolean,
  providerCatalog: ModelCatalogProvider,
  selection: ResolvedModelSelection,
): Promise<MessageArtifact | undefined> {
  const changedFiles = buildChangedFilesFromSources(
    workspacePath,
    items,
    beforeSnapshot,
    afterSnapshot,
    useSnapshotFallback,
  );
  const activitySummary = toActivitySummary(items);
  const operationTimeline = toAuditOperations(items);
  const runChecks = toRunChecks(
    session,
    usage,
    threadId,
    providerCatalog,
    selection,
    beforeSnapshotStats,
    afterSnapshotStats,
  );

  if (changedFiles.length === 0 && operationTimeline.length === 0 && runChecks.length === 0) {
    return undefined;
  }

  return {
    title: session.taskTitle,
    activitySummary,
    operationTimeline,
    changedFiles,
    runChecks,
  };
}

export class CodexAdapter implements ProviderTurnAdapter {
  private readonly clients = new Map<string, Codex>();
  private readonly threads = new Map<string, CachedCodexThread>();
  private readonly workspaceSnapshotIndexes = new Map<string, WorkspaceSnapshotIndex>();

  composePrompt(input: RunSessionTurnInput): ProviderPromptComposition {
    return composeProviderPrompt(input);
  }

  async getProviderQuotaTelemetry(): Promise<null> {
    return null;
  }

  async extractSessionMemoryDelta(input: ExtractSessionMemoryInput): Promise<ExtractSessionMemoryResult> {
    const result = await this.runBackgroundStructuredPrompt(input, parseSessionMemoryDeltaText);
    return {
      threadId: result.threadId,
      rawText: result.rawText,
      delta: result.output,
      rawItemsJson: result.rawItemsJson,
      usage: result.usage,
      providerQuotaTelemetry: null,
    };
  }

  async runCharacterReflection(input: RunCharacterReflectionInput): Promise<RunCharacterReflectionResult> {
    const result = await this.runBackgroundStructuredPrompt(input, parseCharacterReflectionOutputText);
    return {
      threadId: result.threadId,
      rawText: result.rawText,
      output: result.output,
      rawItemsJson: result.rawItemsJson,
      usage: result.usage,
      providerQuotaTelemetry: null,
    };
  }

  invalidateSessionThread(sessionId: string): void {
    this.threads.delete(sessionId);
  }

  invalidateAllSessionThreads(): void {
    this.threads.clear();
    this.workspaceSnapshotIndexes.clear();
  }

  private buildBackgroundThreadOptions(input: ExtractSessionMemoryInput | RunCharacterReflectionInput) {
    return {
      workingDirectory: input.session.workspacePath,
      skipGitRepoCheck: true as const,
      sandboxMode: "read-only" as const,
      approvalPolicy: "never" as const,
      model: input.model,
      modelReasoningEffort: input.reasoningEffort,
    };
  }

  private async runBackgroundStructuredPrompt<TOutput>(
    input: ExtractSessionMemoryInput | RunCharacterReflectionInput,
    parse: (rawText: string) => TOutput | null,
  ): Promise<{
    threadId: string | null;
    rawText: string;
    output: TOutput | null;
    rawItemsJson: string;
    usage: AuditLogUsage | null;
  }> {
    const { client } = this.getClient(input.session.provider, input.appSettings);
    const thread = client.startThread(this.buildBackgroundThreadOptions(input));

    const backgroundInput = `${input.prompt.systemText}\n\n${input.prompt.userText}`.trim();
    const result = await thread.run(backgroundInput, {
      outputSchema: input.prompt.outputSchema,
      signal: AbortSignal.timeout(input.timeoutMs),
    });

    return {
      threadId: thread.id,
      rawText: result.finalResponse,
      output: parse(result.finalResponse),
      rawItemsJson: JSON.stringify({
        type: "codex-background-response",
        threadId: thread.id,
        finalResponse: result.finalResponse,
      }, null, 2),
      usage: result.usage ? toAuditUsage(result.usage) : null,
    };
  }

  private getClient(providerId: string, appSettings: AppSettings): { client: Codex; clientKey: string } {
    const codingApiKey = getProviderAppSettings(appSettings, providerId).apiKey.trim();
    const codexPathOverride = resolvePackagedProviderBinaryPath("codex");
    const clientKey = JSON.stringify([providerId, codingApiKey || null, codexPathOverride]);
    const cached = this.clients.get(clientKey);
    if (cached) {
      return { client: cached, clientKey };
    }

    const clientOptions = {
      ...(codingApiKey ? { apiKey: codingApiKey } : {}),
      ...(codexPathOverride ? { codexPathOverride } : {}),
    };
    const client = new Codex(clientOptions);
    this.clients.set(clientKey, client);
    return { client, clientKey };
  }

  private getThread(input: RunSessionTurnInput): { thread: Thread; selection: ResolvedModelSelection } {
    const { client, clientKey } = this.getClient(input.providerCatalog.id, input.appSettings);
    const nextSettings = buildCodexThreadSettings(
      input.session,
      input.providerCatalog,
      clientKey,
      resolveRunWorkspacePath(input),
    );
    const resolved = resolveCodexThreadForSettings({
      cached: this.threads.get(input.session.id),
      nextSettingsKey: nextSettings.settingsKey,
      threadId: input.session.threadId,
      options: nextSettings.options,
      client,
    });

    this.threads.set(input.session.id, {
      thread: resolved.thread,
      settingsKey: nextSettings.settingsKey,
    });
    return {
      thread: resolved.thread,
      selection: nextSettings.selection,
    };
  }

  private buildSnapshotRoots(input: RunSessionTurnInput): string[] {
    const workspacePath = resolveRunWorkspacePath(input);
    return [
      workspacePath,
      ...normalizeAllowedAdditionalDirectories(workspacePath, input.session.allowedAdditionalDirectories),
    ];
  }

  private buildSnapshotIndexKey(roots: readonly string[]): string {
    return JSON.stringify(
      roots.map((root) => {
        const resolved = path.resolve(root);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      }),
    );
  }

  private async prepareBeforeWorkspaceSnapshot(input: RunSessionTurnInput): Promise<{
    beforeSnapshot: WorkspaceSnapshot;
    beforeSnapshotStats: SnapshotCaptureStats;
  }> {
    const snapshotRoots = this.buildSnapshotRoots(input);
    const indexKey = this.buildSnapshotIndexKey(snapshotRoots);
    const cachedIndex = this.workspaceSnapshotIndexes.get(indexKey);

    if (!cachedIndex) {
      const index = await createWorkspaceSnapshotIndex(snapshotRoots);
      this.workspaceSnapshotIndexes.set(indexKey, index);
      return {
        beforeSnapshot: new Map(index.snapshot),
        beforeSnapshotStats: { ...index.stats },
      };
    }

    const refreshed = await refreshWorkspaceSnapshotIndex(cachedIndex);
    this.workspaceSnapshotIndexes.set(indexKey, refreshed.index);
    return {
      beforeSnapshot: refreshed.snapshot,
      beforeSnapshotStats: refreshed.stats,
    };
  }

  private async captureAfterWorkspaceSnapshot(
    input: RunSessionTurnInput,
    finalItems: ThreadItem[],
  ): Promise<{
    afterSnapshot: WorkspaceSnapshot;
    afterSnapshotStats: SnapshotCaptureStats;
    useSnapshotFallback: boolean;
  }> {
    const snapshotRoots = this.buildSnapshotRoots(input);
    const indexKey = this.buildSnapshotIndexKey(snapshotRoots);
    const cachedIndex = this.workspaceSnapshotIndexes.get(indexKey)
      ?? await createWorkspaceSnapshotIndex(snapshotRoots);
    const candidatePaths = collectCompletedFileChangePaths(resolveRunWorkspacePath(input), finalItems);
    const canUseTargetedSnapshot = candidatePaths.length > 0 && !hasBroadFilesystemChangeSource(finalItems);
    const refreshed = await refreshWorkspaceSnapshotIndex(cachedIndex, {
      candidatePaths: canUseTargetedSnapshot ? candidatePaths : undefined,
      trustCandidatePaths: canUseTargetedSnapshot,
    });
    this.workspaceSnapshotIndexes.set(indexKey, refreshed.index);

    return {
      afterSnapshot: refreshed.snapshot,
      afterSnapshotStats: refreshed.stats,
      useSnapshotFallback: !canUseTargetedSnapshot,
    };
  }

  private async buildTurnResult(
    input: RunSessionTurnInput,
    prompt: ProviderPromptComposition,
    items: Map<string, ThreadItem>,
    usage: Usage | null,
    threadId: string | null,
    streamedAssistantText: string,
    selection: ResolvedModelSelection,
    beforeSnapshot: WorkspaceSnapshot,
    beforeSnapshotStats: SnapshotCaptureStats,
  ): Promise<RunSessionTurnResult> {
    const finalItems = Array.from(items.values());
    const itemAssistantText = collectAssistantText(finalItems);
    const finalAssistantText = itemAssistantText.trim().length > 0 ? itemAssistantText : streamedAssistantText;
    const { afterSnapshot, afterSnapshotStats, useSnapshotFallback } =
      await this.captureAfterWorkspaceSnapshot(input, finalItems);
    const artifact = await buildArtifact(
      input.session,
      resolveRunWorkspacePath(input),
      finalItems,
      usage,
      threadId,
      beforeSnapshot,
      afterSnapshot,
      beforeSnapshotStats,
      afterSnapshotStats,
      useSnapshotFallback,
      input.providerCatalog,
      selection,
    );

    return {
      threadId,
      assistantText: finalAssistantText,
      artifact,
      logicalPrompt: prompt.logicalPrompt,
      transportPayload: buildCodexTransportPayload(prompt),
      operations: toAuditOperations(finalItems),
      rawItemsJson: JSON.stringify(finalItems, null, 2),
      usage: toAuditUsage(usage),
      providerQuotaTelemetry: null,
    };
  }

  async runSessionTurn(input: RunSessionTurnInput, onProgress?: RunSessionTurnProgressHandler): Promise<RunSessionTurnResult> {
    const { thread, selection } = this.getThread(input);
    const prompt = this.composePrompt(input);
    const { beforeSnapshot, beforeSnapshotStats } = await this.prepareBeforeWorkspaceSnapshot(input);
    const turnInput =
      prompt.imagePaths.length > 0
        ? [
            { type: "text" as const, text: prompt.logicalPrompt.composedText },
            ...prompt.imagePaths.map((imagePath) => ({ type: "local_image" as const, path: imagePath })),
          ]
        : prompt.logicalPrompt.composedText;
    const streamState = createCodexTurnStreamState(thread.id);

    await emitLiveState(
      onProgress,
      input.session.id,
      streamState.threadId,
      streamState.liveSteps,
      getLiveAssistantText(streamState),
      streamState.liveUsage,
      streamState.streamErrorMessage,
    );

    try {
      const { events } = await thread.runStreamed(turnInput, {
        signal: input.signal,
      });

      for await (const event of events) {
        applyCodexTurnEvent(streamState, event);
        await emitLiveState(
          onProgress,
          input.session.id,
          streamState.threadId,
          streamState.liveSteps,
          getLiveAssistantText(streamState),
          streamState.liveUsage,
          streamState.streamErrorMessage,
        );
      }

      if (streamState.streamErrorMessage) {
        const partialResult = await this.buildTurnResult(
          input,
          prompt,
          streamState.items,
          streamState.usage,
          streamState.threadId,
          streamState.streamedAssistantText,
          selection,
          beforeSnapshot,
          beforeSnapshotStats,
        );
        throw new ProviderTurnError(
          streamState.streamErrorMessage,
          partialResult,
          Boolean(input.signal?.aborted) || isCanceledProviderMessage(streamState.streamErrorMessage),
        );
      }

      return this.buildTurnResult(
        input,
        prompt,
        streamState.items,
        streamState.usage,
        streamState.threadId,
        streamState.streamedAssistantText,
        selection,
        beforeSnapshot,
        beforeSnapshotStats,
      );
    } catch (error) {
      if (error instanceof ProviderTurnError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const partialResult = await this.buildTurnResult(
        input,
        prompt,
        streamState.items,
        streamState.usage,
        streamState.threadId,
        streamState.streamedAssistantText,
        selection,
        beforeSnapshot,
        beforeSnapshotStats,
      );
      throw new ProviderTurnError(
        message,
        partialResult,
        Boolean(input.signal?.aborted) || isCanceledProviderMessage(message),
      );
    }
  }
}

export function buildCodexThreadSettings(
  session: Session,
  providerCatalog: ModelCatalogProvider,
  clientKey: string,
  executionWorkspacePath?: string,
): CodexThreadSettings {
  const selection = resolveModelSelection(providerCatalog, session.model, session.reasoningEffort);
  const workspacePath = executionWorkspacePath?.trim() || session.workspacePath;
  const additionalDirectories = normalizeAllowedAdditionalDirectories(
    workspacePath,
    session.allowedAdditionalDirectories,
  );
  const sandboxOptions = resolveCodexSandboxThreadOptions(session.codexSandboxMode);
  const options: CodexThreadOptions = {
    workingDirectory: workspacePath,
    skipGitRepoCheck: true,
    sandboxMode: sandboxOptions.sandboxMode,
    approvalPolicy: mapApprovalModeToCodexPolicy(session.approvalMode),
    model: selection.resolvedModel,
    modelReasoningEffort: selection.resolvedReasoningEffort,
    ...(sandboxOptions.networkAccessEnabled ? { networkAccessEnabled: true } : {}),
    ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
  };

  return {
    options,
    selection,
    settingsKey: JSON.stringify([
      options.workingDirectory,
      options.sandboxMode,
      options.networkAccessEnabled ?? false,
      options.approvalPolicy,
      options.model,
      options.modelReasoningEffort,
      additionalDirectories,
      clientKey,
    ]),
  };
}

export function resolveCodexThreadForSettings(args: {
  cached: CachedCodexThread | undefined;
  nextSettingsKey: string;
  threadId: string | null;
  options: CodexThreadOptions;
  client: CodexThreadConnector;
}): { thread: Thread; reusedCached: boolean } {
  const {
    cached,
    nextSettingsKey,
    threadId,
    options,
    client,
  } = args;

  if (cached && cached.settingsKey === nextSettingsKey) {
    return {
      thread: cached.thread,
      reusedCached: true,
    };
  }

  return {
    thread: threadId?.trim()
      ? client.resumeThread(threadId, options)
      : client.startThread(options),
    reusedCached: false,
  };
}

