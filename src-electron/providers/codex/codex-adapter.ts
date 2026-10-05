import path from "node:path";
import { createRequire } from "node:module";
import {
  CODEX_APP_SERVER_ARGUMENTS,
  CodexAppServerRpcError,
  CodexAppServerTransport,
} from "./app-server-transport.js";
import { CodexTurnInteractions } from "./codex-app-server-interactions.js";

import type { AppSettings } from "../../../src-shared/settings/provider-settings-state.js";
import type {
  AuditTransportPayload,
  AuditLogUsage,
  ChangedFile,
  DiffRow,
  RunCheck,
} from "../../../src-shared/session/runtime-state.js";
import type {
  MessageArtifact,
  Session,
} from "../../../src-shared/session/session-state.js";
import type { SessionExecutionOptions } from "../../../src-shared/session/session-execution-options.js";
import { getProviderAppSettings } from "../../../src-shared/settings/provider-settings-state.js";
import {
  mapApprovalModeToCodexPolicy,
  type ApprovalMode,
} from "../../../src-shared/settings/approval-mode.js";
import {
  resolveCodexSandboxThreadOptions,
  type CodexSandboxBaseMode,
} from "../../../src-shared/settings/codex-sandbox-mode.js";
import {
  DEFAULT_CODEX_SPEED,
  mapCodexSpeedToServiceTier,
  type CodexServiceTier,
} from "../../../src-shared/settings/codex-speed.js";
import {
  DEFAULT_CODEX_REVIEWER,
  mapCodexReviewerToApprovalsReviewer,
  type CodexApprovalsReviewer,
} from "../../../src-shared/settings/codex-reviewer.js";
import {
  reasoningEffortLabel,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelReasoningEffort,
  type ResolvedModelSelection,
} from "../../../src-shared/settings/model-catalog.js";
import {
  createWorkspaceSnapshotIndex,
  refreshWorkspaceSnapshotIndex,
  type SnapshotCaptureStats,
  type WorkspaceSnapshotIndex,
  type WorkspaceSnapshot,
} from "../../platform/snapshot-ignore.js";
import { normalizeAllowedAdditionalDirectories } from "../../files/additional-directories.js";
import {
  createDisabledWorkspaceSnapshotCapture,
  WORKSPACE_DIFF_CAPTURE_ENABLED,
} from "../../files/workspace-diff-policy.js";
import {
  composeProviderPrompt,
  isCanceledProviderMessage,
} from "../provider-prompt.js";
import {
  ProviderTurnError,
  resolveRunWorkspacePath,
  BACKGROUND_STRUCTURED_PROMPT_POLICY,
  type ExtractSessionMemoryResult,
  type ExtractSessionMemoryInput,
  type ProviderErrorReason,
  type ProviderPromptComposition,
  type RunBackgroundStructuredPromptInput,
  type RunBackgroundStructuredPromptResult,
  type ProviderTurnAdapter,
  type RunSessionTurnInput,
  type RunSessionTurnProgressHandler,
  type RunSessionTurnResult,
} from "../provider-runtime.js";
import { parseSessionMemoryDeltaText } from "../../session/session-memory-extraction.js";
import {
  resolveDevelopmentProviderBinaryPath,
  resolvePackagedProviderBinaryPath,
} from "../provider-binary-paths.js";
import {
  boundAuditRawItem,
  type BoundedAuditRawItem,
  stringifyBoundedAuditRawItems,
  toAuditTextPreview,
} from "../../session/audit-payload-limits.js";
import { toProviderMetadataLogData } from "../provider-metadata-log.js";
import {
  buildProviderAgentRuntimeBindingEnv,
  createProviderAgentRuntimeBindingRedactor,
  mergeDefinedProviderEnv,
  type ProviderAgentRuntimeBindingRedactor,
} from "../provider-agent-runtime-binding.js";
import type { ProviderAgentRuntimeBindingProjection } from "../agent-runtime-binding.js";
import {
  buildChangedFilesFromSources as buildChangedFilesProjection,
  buildCodexProviderMetadata as buildProviderMetadataProjection,
  buildCodexStableRawItems as buildStableRawItemsProjection,
  toAuditOperations as toAuditOperationsProjection,
} from "./codex-event-projection.js";
import {
  applyCodexTurnEvent,
  createCodexTurnStreamState,
  collectCodexAssistantResponseFromItems,
  getLiveCodexAssistantText,
  type CodexTurnStreamState,
  type CodexTurnItem,
} from "./codex-turn-events.js";
const MAX_DIFF_MATRIX_CELLS = 2_000_000;

function summarizeChangedFile(
  kind: ChangedFile["kind"],
  filePath: string,
): string {
  switch (kind) {
    case "add":
      return `${filePath} created`;
    case "delete":
      return `${filePath} deleted`;
    default:
      return `${filePath} updated`;
  }
}

function normalizeWorkspaceRelativePath(
  workspacePath: string,
  filePath: string,
): string {
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workspacePath, filePath);
  const relativePath = path.relative(workspacePath, resolvedPath);

  if (
    relativePath &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  ) {
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
  | {
      kind: "context";
      leftNumber: number;
      rightNumber: number;
      leftText: string;
      rightText: string;
    }
  | { kind: "delete"; leftNumber: number; leftText: string }
  | { kind: "add"; rightNumber: number; rightText: string };

type CodexAdapterLogInput = {
  level: "debug" | "info" | "warn" | "error";
  kind: string;
  message: string;
  data?: unknown;
  error?: { name?: string; message: string; stack?: string };
};
type CodexAdapterLogger = (input: CodexAdapterLogInput) => void;
type CodexTransport = Pick<
  CodexAppServerTransport,
  "start" | "request" | "nextEvent" | "close" | "whenClosed"
>;
export type CodexAdapterOptions = {
  appVersion?: string;
  snapshotDeadlineMs?: number;
  createTransport?: (
    options: ConstructorParameters<typeof CodexAppServerTransport>[0],
  ) => CodexTransport;
};
const DEFAULT_CODEX_SNAPSHOT_DEADLINE_MS = 5_000;
const CODEX_SNAPSHOT_TIMEOUT = Symbol("codex-snapshot-timeout");
const require = createRequire(import.meta.url);
class CodexAuthenticationError extends Error {}

function sanitizeCodexError(error: unknown, redactor: ProviderAgentRuntimeBindingRedactor, seen = new WeakSet<Error>()): unknown {
  if (error instanceof Error) {
    if (seen.has(error)) return error;
    seen.add(error);
  }
  if (error instanceof CodexAppServerRpcError) {
    const sanitized = new CodexAppServerRpcError(error.code, redactor.sanitizeText(error.message), redactor.sanitize(error.data));
    if (error.stack) sanitized.stack = redactor.sanitizeText(error.stack);
    return sanitized;
  }
  if (error instanceof Error) {
    const message = redactor.sanitizeText(error.message);
    if (message !== error.message) Object.defineProperty(error, "message", { value: message, writable: true, configurable: true });
    if (error.stack) error.stack = redactor.sanitizeText(error.stack);
    if ("cause" in error) {
      Object.defineProperty(error, "cause", { value: sanitizeCodexError(error.cause, redactor, seen), writable: true, configurable: true });
    }
    return error;
  }
  return redactor.sanitize(error);
}

function resolveCodexApiKey(providerId: string, appSettings: AppSettings): string {
  return getProviderAppSettings(appSettings, providerId).apiKey.trim() || process.env.CODEX_API_KEY?.trim() || "";
}

async function raceWithDeadline<T, TTimeout>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: TTimeout,
): Promise<T | TTimeout> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<TTimeout>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutValue), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
export function isCodexUsageLimitMessage(message: string): boolean {
  return (
    /you['’]ve hit your usage limit\./i.test(message) &&
    /purchase more credits/i.test(message) &&
    /try again at/i.test(message)
  );
}
function resolveCodexProviderErrorReason(
  message: string,
  canceled: boolean,
): ProviderErrorReason {
  return canceled
    ? "canceled"
    : isCodexUsageLimitMessage(message)
      ? "usage_limit"
      : "unknown";
}
function collectCompletedFileChangeItems(
  items: CodexTurnItem[],
): Array<Extract<CodexTurnItem, { type: "fileChange" }>> {
  return items.filter(
    (item): item is Extract<CodexTurnItem, { type: "fileChange" }> =>
      item.type === "fileChange" && item.status === "completed",
  );
}
function collectCompletedFileChangePaths(
  workspacePath: string,
  items: CodexTurnItem[],
): string[] {
  return [
    ...new Set(
      collectCompletedFileChangeItems(items).flatMap((item) =>
        item.changes.map((change) =>
          normalizeWorkspaceRelativePath(workspacePath, change.path),
        ),
      ),
    ),
  ].sort();
}
function hasBroadFilesystemChangeSource(items: CodexTurnItem[]): boolean {
  return items.some(
    (item) =>
      item.type === "commandExecution" ||
      item.type === "mcpToolCall" ||
      item.type === "collabAgentToolCall",
  );
}
function toActivitySummary(items: CodexTurnItem[]): string[] {
  return toAuditOperationsProjection(items)
    .filter((item) => item.type !== "agent_message")
    .map((item) => item.summary)
    .slice(0, 6);
}
function parseStructuredPromptJson(rawText: string): unknown | null {
  const trimmed = rawText.trim();
  const match = trimmed.match(/^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i);
  try {
    return JSON.parse(match ? (match[1] ?? "") : trimmed);
  } catch {
    return null;
  }
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export type CodexThreadOptions = {
  workingDirectory: string;
  sandboxMode: CodexSandboxBaseMode;
  approvalPolicy: ApprovalMode;
  model: string;
  modelReasoningEffort: ModelReasoningEffort;
  networkAccessEnabled?: boolean;
  additionalDirectories?: string[];
};
function buildCodexThreadSettings(
  session: Session,
  providerCatalog: ModelCatalogProvider,
  executionOptions: SessionExecutionOptions,
  executionWorkspacePath?: string,
) {
  const selection = resolveModelSelection(
    providerCatalog,
    executionOptions.model,
    executionOptions.reasoningEffort,
  );
  const workingDirectory =
    executionWorkspacePath?.trim() || session.workspacePath;
  const sandbox = resolveCodexSandboxThreadOptions(
    executionOptions.codexSandboxMode,
  );
  const options: CodexThreadOptions = {
    workingDirectory,
    sandboxMode: sandbox.sandboxMode,
    approvalPolicy: mapApprovalModeToCodexPolicy(executionOptions.approvalMode),
    model: selection.resolvedModel,
    modelReasoningEffort: selection.resolvedReasoningEffort,
    networkAccessEnabled: sandbox.networkAccessEnabled,
    additionalDirectories: normalizeAllowedAdditionalDirectories(
      workingDirectory,
      session.allowedAdditionalDirectories,
    ),
  };
  return { options, selection };
}
function sandboxPolicy(options: CodexThreadOptions): unknown {
  if (options.sandboxMode === "danger-full-access")
    return { type: "dangerFullAccess" };
  if (options.sandboxMode === "read-only")
    return {
      type: "readOnly",
      networkAccess: options.networkAccessEnabled ?? false,
    };
  return {
    type: "workspaceWrite",
    writableRoots: [
      options.workingDirectory,
      ...(options.additionalDirectories ?? []),
    ],
    networkAccess: options.networkAccessEnabled ?? false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
function userInput(text: string, imagePaths: string[]): unknown[] {
  return [
    { type: "text", text, text_elements: [] },
    ...imagePaths.map((imagePath) => ({ type: "localImage", path: imagePath })),
  ];
}
type ActiveCodexTurn = {
  transport: CodexTransport;
  threadId: string;
  turnId: string;
  inputAvailable: boolean;
  pendingInputs: Set<Promise<{ turnId: string }>>;
  diagnostics: CodexTurnDiagnostics;
  redactor: ProviderAgentRuntimeBindingRedactor;
};
type CodexTurnDiagnostics = {
  rawItems: BoundedAuditRawItem[];
  cleanupError?: string;
};
function appendDiagnostic(diagnostics: CodexTurnDiagnostics, item: BoundedAuditRawItem): void {
  diagnostics.rawItems = JSON.parse(stringifyBoundedAuditRawItems([...diagnostics.rawItems, item])) as BoundedAuditRawItem[];
}
function workspaceKey(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function buildFallbackDiffRows(
  beforeLines: string[],
  afterLines: string[],
): DiffRow[] {
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

function buildDiffRows(
  beforeContent: string | null,
  afterContent: string | null,
): DiffRow[] {
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
    while (
      cursor < operations.length &&
      operations[cursor].kind !== "context"
    ) {
      block.push(operations[cursor]);
      cursor += 1;
    }

    const deletes = block.filter(
      (entry): entry is Extract<RawDiffOp, { kind: "delete" }> =>
        entry.kind === "delete",
    );
    const adds = block.filter(
      (entry): entry is Extract<RawDiffOp, { kind: "add" }> =>
        entry.kind === "add",
    );
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

    for (
      let deleteIndex = pairedCount;
      deleteIndex < deletes.length;
      deleteIndex += 1
    ) {
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

function inferChangedFileKind(
  beforeContent: string | null,
  afterContent: string | null,
): ChangedFile["kind"] | null {
  if (beforeContent === null && afterContent !== null) {
    return "add";
  }

  if (beforeContent !== null && afterContent === null) {
    return "delete";
  }

  if (
    beforeContent !== null &&
    afterContent !== null &&
    beforeContent !== afterContent
  ) {
    return "edit";
  }

  return null;
}

function compareSnapshotChanges(
  beforeSnapshot: WorkspaceSnapshot,
  afterSnapshot: WorkspaceSnapshot,
): Array<{
  path: string;
  kind: ChangedFile["kind"];
}> {
  const paths = new Set<string>([
    ...beforeSnapshot.keys(),
    ...afterSnapshot.keys(),
  ]);
  const changes: Array<{ path: string; kind: ChangedFile["kind"] }> = [];

  for (const filePath of paths) {
    const kind = inferChangedFileKind(
      beforeSnapshot.get(filePath) ?? null,
      afterSnapshot.get(filePath) ?? null,
    );
    if (!kind) {
      continue;
    }

    changes.push({ path: filePath, kind });
  }

  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function buildCodexTransportPayload(
  prompt: ProviderPromptComposition,
): AuditTransportPayload {
  const fields = [
    {
      label: "turn/start.text",
      value: prompt.logicalPrompt.composedText,
    },
  ];

  if (prompt.imagePaths.length > 0) {
    fields.push({
      label: "turn/start.images",
      value: prompt.imagePaths.join("\n"),
    });
  }

  if (prompt.additionalDirectories.length > 0) {
    fields.push({
      label: "sandboxPolicy.writableRoots",
      value: prompt.additionalDirectories.join("\n"),
    });
  }

  return {
    summary: "Codex turn/start payload",
    fields,
  };
}

function toRunChecks(
  executionOptions: SessionExecutionOptions,
  usage: AuditLogUsage | null,
  threadId: string | null,
  providerCatalog: ModelCatalogProvider,
  selection: ResolvedModelSelection,
  beforeSnapshotStats: SnapshotCaptureStats,
  afterSnapshotStats: SnapshotCaptureStats,
): RunCheck[] {
  const checks: RunCheck[] = [
    { label: "provider", value: providerCatalog.label },
    { label: "approval", value: executionOptions.approvalMode },
    { label: "reviewer", value: executionOptions.codexReviewer },
    buildCodexSpeedRunCheck(executionOptions.codexSpeed),
    { label: "model", value: selection.resolvedModel },
    {
      label: "reasoning",
      value: reasoningEffortLabel(selection.resolvedReasoningEffort),
    },
  ];

  if (threadId) {
    checks.push({ label: "thread", value: threadId });
  }

  if (usage) {
    checks.push({
      label: "tokens",
      value: `${usage.inputTokens}/${usage.outputTokens}`,
    });
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

export function buildCodexSpeedRunCheck(
  speed: Session["codexSpeed"],
): RunCheck {
  return { label: "speed", value: speed };
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
  executionOptions: SessionExecutionOptions,
  workspacePath: string,
  items: CodexTurnItem[],
  usage: AuditLogUsage | null,
  threadId: string | null,
  beforeSnapshot: WorkspaceSnapshot,
  afterSnapshot: WorkspaceSnapshot,
  beforeSnapshotStats: SnapshotCaptureStats,
  afterSnapshotStats: SnapshotCaptureStats,
  useSnapshotFallback: boolean,
  providerCatalog: ModelCatalogProvider,
  selection: ResolvedModelSelection,
): Promise<MessageArtifact | undefined> {
  const changedFiles = buildChangedFilesProjection(
    workspacePath,
    items,
    beforeSnapshot,
    afterSnapshot,
    useSnapshotFallback,
    {
      normalizeWorkspaceRelativePath,
      collectCompletedFileChanges: collectCompletedFileChangeItems,
      compareSnapshotChanges,
      summarizeChangedFile,
      buildDiffRows,
    },
  );
  const activitySummary = toActivitySummary(items);
  const operationTimeline = toAuditOperationsProjection(items);
  const runChecks = toRunChecks(
    executionOptions,
    usage,
    threadId,
    providerCatalog,
    selection,
    beforeSnapshotStats,
    afterSnapshotStats,
  );

  if (
    changedFiles.length === 0 &&
    operationTimeline.length === 0 &&
    runChecks.length === 0
  ) {
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
  private readonly activeTurns = new Map<string, ActiveCodexTurn>();
  private readonly pendingCleanups = new Map<CodexTransport, { sessionId?: string; workspace: string; threadId: string | null }>();
  private readonly workspaceSnapshotIndexes = new Map<
    string,
    WorkspaceSnapshotIndex
  >();
  constructor(
    private readonly logger?: CodexAdapterLogger,
    private readonly options: CodexAdapterOptions = {},
  ) {}
  private writeLog(input: CodexAdapterLogInput): void {
    try {
      this.logger?.(input);
    } catch {
      /* Logging does not control execution. */
    }
  }
  composePrompt(input: RunSessionTurnInput): ProviderPromptComposition {
    return composeProviderPrompt(input);
  }
  async getProviderQuotaTelemetry(): Promise<null> {
    return null;
  }
  getBackgroundStructuredPromptPolicy() {
    return BACKGROUND_STRUCTURED_PROMPT_POLICY;
  }
  async invalidateSessionThread(sessionId: string): Promise<void> {
    const active = this.activeTurns.get(sessionId);
    if (active) {
      active.inputAvailable = false;
      this.activeTurns.delete(sessionId);
      await active.transport.close();
    }
    await Promise.all([...this.pendingCleanups].filter(([, cleanup]) => cleanup.sessionId === sessionId).map(([transport]) => transport.close()));
  }
  async invalidateAllSessionThreads(): Promise<void> {
    const active = [...this.activeTurns.values()];
    this.activeTurns.clear();
    this.workspaceSnapshotIndexes.clear();
    await Promise.all([
      ...active.map((turn) => {
        turn.inputAvailable = false;
        return turn.transport.close();
      }),
      ...[...this.pendingCleanups.keys()].map((transport) => transport.close()),
    ]);
  }
  private assertCleanupComplete(workspacePath: string, sessionId?: string, threadId?: string | null): void {
    const workspace = workspaceKey(workspacePath);
    if ([...this.pendingCleanups.values()].some((cleanup) => cleanup.workspace === workspace
      || (sessionId !== undefined && cleanup.sessionId === sessionId)
      || (threadId && cleanup.threadId === threadId))) {
      throw new Error("Codex process cleanup is still pending; execution cannot restart yet");
    }
  }
  private createTransport(
    providerId: string,
    appSettings: AppSettings,
    workspacePath: string,
    binding?: ProviderAgentRuntimeBindingProjection | null,
    interactive = false,
  ): { transport: CodexTransport; apiKey: string } {
    const executable =
      resolvePackagedProviderBinaryPath("codex") ??
      resolveDevelopmentProviderBinaryPath("codex", (specifier) =>
        require.resolve(specifier),
      );
    if (!executable) throw new Error("Codex App Server binary was not found");
    const env = mergeDefinedProviderEnv(
      process.env,
      buildProviderAgentRuntimeBindingEnv(binding),
    );
    const apiKey = resolveCodexApiKey(providerId, appSettings);
    if (apiKey) env.CODEX_API_KEY = apiKey;
    const options = {
      executable,
      cwd: workspacePath,
      env,
      arguments: [
        ...CODEX_APP_SERVER_ARGUMENTS,
        "-c",
        `features.default_mode_request_user_input=${interactive}`,
        "-c",
        `features.request_permissions_tool=${interactive}`,
        ...(apiKey ? ["-c", 'cli_auth_credentials_store="ephemeral"'] : []),
      ],
      clientInfo: {
        name: "withmate",
        title: "WithMate",
        version: this.options.appVersion ?? "development",
      },
    };
    return { transport: this.options.createTransport?.(options) ?? new CodexAppServerTransport(options), apiKey };
  }
  async steerSessionTurn(input: {
    sessionId: string;
    expectedTurnId: string;
    userMessage: string;
    attachments: import("../../../src-shared/session/runtime-state.js").ComposerAttachment[];
  }): Promise<{ turnId: string }> {
    const active = this.activeTurns.get(input.sessionId);
    if (!active?.inputAvailable || active.turnId !== input.expectedTurnId)
      throw new Error("Codex turn is no longer accepting input");
    const attachmentText = input.attachments
      .filter((attachment) => attachment.kind !== "image")
      .map((attachment) => attachment.absolutePath)
      .join("\n");
    const steerInput = userInput(
      [input.userMessage, attachmentText].filter(Boolean).join("\n\n"),
      input.attachments.filter((attachment) => attachment.kind === "image").map((attachment) => attachment.absolutePath),
    );
    const acceptedInput = boundAuditRawItem(active.redactor.sanitize({
      type: "withmate.accepted_steer",
      data: { threadId: active.threadId, turnId: active.turnId, input: steerInput },
    }));
    const request = active.transport.request<{ turnId: string }>(
      "turn/steer",
      {
        threadId: active.threadId,
        expectedTurnId: input.expectedTurnId,
        input: steerInput,
      },
      { timeoutMs: 10_000 },
    );
    active.pendingInputs.add(request);
    try {
      const response = await request;
      if (response.turnId !== input.expectedTurnId)
        throw new Error("Codex accepted input for an unexpected turn");
      appendDiagnostic(active.diagnostics, acceptedInput);
      return { turnId: response.turnId };
    } finally {
      active.pendingInputs.delete(request);
    }
  }
  private async executeTurn(args: {
    transport: CodexTransport;
    apiKey: string;
    state: CodexTurnStreamState;
    diagnostics: CodexTurnDiagnostics;
    options: CodexThreadOptions;
    serviceTier: CodexServiceTier;
    reviewer: CodexApprovalsReviewer;
    input: unknown[];
    signal?: AbortSignal;
    outputSchema?: unknown;
    sessionInput?: RunSessionTurnInput;
    onProgress?: RunSessionTurnProgressHandler;
  }): Promise<void> {
    const { transport, state, options, signal, sessionInput } = args;
    const redactor = createProviderAgentRuntimeBindingRedactor(
      sessionInput?.agentRuntimeBinding,
      [args.apiKey],
    );
    let interactionError: unknown;
    const interactions = sessionInput
      ? new CodexTurnInteractions(
          sessionInput,
          redactor.sanitizeText,
          (error) => {
            interactionError = error;
            void transport.close().catch(() => undefined);
          },
        )
      : null;
    let active: ActiveCodexTurn | null = null;
    const progress = async () => {
      if (!sessionInput || !args.onProgress) return;
      await args.onProgress({
        sessionId: sessionInput.session.id,
        threadId: state.threadId ?? "",
        turnId: state.turnId ?? undefined,
        inputAvailable: active?.inputAvailable ?? false,
        assistantText: redactor.sanitizeText(
          toAuditTextPreview(getLiveCodexAssistantText(state)) ?? "",
        ),
        reasoningText: redactor.sanitizeText(
          toAuditTextPreview(state.reasoningText) ?? "",
        ),
        steps: redactor.sanitize([...state.liveSteps.values()]),
        backgroundTasks: [],
        usage: state.usage,
        errorMessage: redactor.sanitizeText(state.streamErrorMessage),
        approvalRequest: null,
        elicitationRequest: null,
      });
    };
    const abort = () => {
      if (active) {
        active.inputAvailable = false;
        void transport
          .request(
            "turn/interrupt",
            { threadId: active.threadId, turnId: active.turnId },
            { timeoutMs: 2_000 },
          )
          .catch(() => undefined);
      }
      interactions?.close();
      void progress().catch(() => undefined);
      void transport.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      await transport.start(signal);
      if (args.apiKey) {
        try {
          const login = await transport.request<{ type: string }>("account/login/start", { type: "apiKey", apiKey: args.apiKey }, { signal });
          if (login.type !== "apiKey") throw new Error("Codex App Server API key login response is invalid");
        } catch (error) {
          throw new CodexAuthenticationError(redactor.sanitizeText(error instanceof Error ? error.message : String(error)));
        }
      }
      const threadParams = {
        model: options.model,
        cwd: options.workingDirectory,
        approvalPolicy: options.approvalPolicy,
        approvalsReviewer: args.reviewer,
        sandbox: options.sandboxMode,
        serviceTier: args.serviceTier,
        config: {
          model_reasoning_effort: options.modelReasoningEffort,
          service_tier: args.serviceTier,
          approvals_reviewer: args.reviewer,
          ...(options.additionalDirectories?.length
            ? {
                sandbox_workspace_write: {
                  writable_roots: options.additionalDirectories,
                  network_access: options.networkAccessEnabled ?? false,
                },
              }
            : {}),
        },
      };
      const threadResponse = await transport.request<{
        thread: { id: string };
      }>(
        state.threadId ? "thread/resume" : "thread/start",
        {
          ...threadParams,
          ...(state.threadId ? { threadId: state.threadId, excludeTurns: true } : {}),
        },
        { signal },
      );
      if (
        typeof threadResponse.thread?.id !== "string" ||
        (state.threadId && state.threadId !== threadResponse.thread.id)
      )
        throw new Error("Invalid Codex App Server thread response");
      state.threadId = threadResponse.thread.id;
      const turnResponse = await transport.request<{ turn: { id: string } }>(
        "turn/start",
        {
          threadId: state.threadId,
          input: args.input,
          cwd: options.workingDirectory,
          approvalPolicy: options.approvalPolicy,
          approvalsReviewer: args.reviewer,
          sandboxPolicy: sandboxPolicy(options),
          model: options.model,
          effort: options.modelReasoningEffort,
          serviceTier: args.serviceTier,
          ...(args.outputSchema === undefined
            ? {}
            : { outputSchema: args.outputSchema }),
        },
        { signal },
      );
      if (typeof turnResponse.turn?.id !== "string")
        throw new Error("Invalid Codex App Server turn response");
      state.turnId = turnResponse.turn.id;
      if (sessionInput) {
        active = {
          transport,
          threadId: state.threadId,
          turnId: state.turnId,
          inputAvailable: true,
          pendingInputs: new Set(),
          diagnostics: args.diagnostics,
          redactor,
        };
        this.activeTurns.set(sessionInput.session.id, active);
      }
      await progress();
      while (!state.turnCompleted) {
        signal?.throwIfAborted();
        const event = await transport.nextEvent();
        const params = asRecord(event.params);
        if (event.kind === "serverRequest") {
          if (
            params.threadId !== state.threadId ||
            (params.turnId !== undefined &&
              params.turnId !== null &&
              params.turnId !== state.turnId)
          ) {
            await event.reject({
              code: -32602,
              message: "Request is outside the current turn",
            });
            continue;
          }
          if (!interactions) {
            await event.reject({
              code: -32601,
              message:
                "Interactive requests are disabled for structured background execution",
            });
            continue;
          }
          interactions.accept(event);
          continue;
        }
        if (event.method === "serverRequest/resolved") {
          if (
            params.threadId === state.threadId &&
            (typeof params.requestId === "string" ||
              typeof params.requestId === "number")
          )
            interactions?.resolve(params.requestId);
          continue;
        }
        applyCodexTurnEvent(state, event);
        if (state.turnCompleted) {
          if (active) active.inputAvailable = false;
          interactions?.close();
          if (sessionInput) this.activeTurns.delete(sessionInput.session.id);
        }
        await progress();
      }
      if (interactionError) throw interactionError;
      if (state.terminalStatus !== "completed")
        throw new Error(
          state.streamErrorMessage || "Codex turn did not complete",
        );
    } finally {
      signal?.removeEventListener("abort", abort);
      interactions?.close();
      if (active) active.inputAvailable = false;
      if (
        sessionInput &&
        this.activeTurns.get(sessionInput.session.id) === active
      )
        this.activeTurns.delete(sessionInput.session.id);
      await progress().catch((error) =>
        this.writeLog({
          level: "warn",
          kind: "codex.run.final-progress-failed",
          message: redactor.sanitizeText(error instanceof Error ? error.message : String(error)),
        }),
      );
      if (state.turnCompleted && active) {
        await Promise.allSettled([...active.pendingInputs]);
      }
      try {
        await transport.close();
      } catch (error) {
        const message = toAuditTextPreview(redactor.sanitizeText(error instanceof Error ? error.message : String(error))) ?? "Codex process cleanup failed";
        args.diagnostics.cleanupError = message;
        appendDiagnostic(args.diagnostics, { type: "withmate.process_cleanup_failed", data: { message } });
        this.writeLog({ level: "error", kind: "codex.run.cleanup-failed", message });
        this.pendingCleanups.set(transport, { sessionId: sessionInput?.session.id, workspace: workspaceKey(options.workingDirectory), threadId: state.threadId });
        const completion = transport.whenClosed().then(() => { this.pendingCleanups.delete(transport); });
        try {
          sessionInput?.onCleanupPending?.(completion);
        } catch (callbackError) {
          this.writeLog({ level: "error", kind: "codex.run.cleanup-tracking-failed", message: redactor.sanitizeText(String(callbackError)) });
        }
      }
    }
  }
  async runBackgroundStructuredPrompt<TOutput = unknown>(
    input: RunBackgroundStructuredPromptInput,
  ): Promise<RunBackgroundStructuredPromptResult<TOutput>> {
    this.assertCleanupComplete(input.workspacePath);
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)])
      : AbortSignal.timeout(input.timeoutMs);
    const sandbox = resolveCodexSandboxThreadOptions("read-only");
    const state = createCodexTurnStreamState(null);
    const diagnostics: CodexTurnDiagnostics = { rawItems: [] };
    const { transport, apiKey } = this.createTransport(
      input.providerId,
      input.appSettings,
      input.workspacePath,
    );
    const redactor = createProviderAgentRuntimeBindingRedactor(null, [apiKey]);
    await this.executeTurn({
      transport,
      apiKey,
      state,
      diagnostics,
      options: {
        workingDirectory: input.workspacePath,
        sandboxMode: sandbox.sandboxMode,
        approvalPolicy: "never",
        model: input.model,
        modelReasoningEffort: input.reasoningEffort,
        networkAccessEnabled: sandbox.networkAccessEnabled,
        additionalDirectories: normalizeAllowedAdditionalDirectories(
          input.workspacePath,
          input.additionalDirectories ?? [],
        ),
      },
      serviceTier: mapCodexSpeedToServiceTier(DEFAULT_CODEX_SPEED),
      reviewer: mapCodexReviewerToApprovalsReviewer(DEFAULT_CODEX_REVIEWER),
      input: userInput(
        `${input.prompt.systemText}\n\n${input.prompt.userText}`.trim(),
        [],
      ),
      outputSchema: input.prompt.outputSchema,
      signal,
    }).catch((error) => { throw sanitizeCodexError(error, redactor); });
    const response = collectCodexAssistantResponseFromItems(
      state.items.values(),
    );
    const rawText = redactor.sanitizeText(response.lastNonEmptyAssistantMessageText);
    const parsedJson = parseStructuredPromptJson(rawText);
    return {
      threadId: state.threadId,
      rawText,
      output: parsedJson as TOutput | null,
      parsedJson,
      rawItemsJson: stringifyBoundedAuditRawItems(
        redactor.sanitize([...diagnostics.rawItems, ...buildStableRawItemsProjection([...state.items.values()])]),
      ),
      usage: state.usage,
      providerQuotaTelemetry: null,
    };
  }
  async extractSessionMemoryDelta(
    input: ExtractSessionMemoryInput,
  ): Promise<ExtractSessionMemoryResult> {
    const result = await this.runBackgroundStructuredPrompt({
      providerId: input.session.provider,
      workspacePath: input.session.workspacePath,
      appSettings: input.appSettings,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      timeoutMs: input.timeoutMs,
      prompt: input.prompt,
    });
    return {
      threadId: result.threadId,
      rawText: result.rawText,
      delta: parseSessionMemoryDeltaText(result.rawText),
      rawItemsJson: result.rawItemsJson,
      usage: result.usage,
      providerQuotaTelemetry: null,
    };
  }
  private buildSnapshotRoots(input: RunSessionTurnInput): string[] {
    const workspacePath = resolveRunWorkspacePath(input);
    return [
      workspacePath,
      ...normalizeAllowedAdditionalDirectories(
        workspacePath,
        input.session.allowedAdditionalDirectories,
      ),
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

  private async prepareBeforeWorkspaceSnapshot(
    input: RunSessionTurnInput,
  ): Promise<{
    beforeSnapshot: WorkspaceSnapshot;
    beforeSnapshotStats: SnapshotCaptureStats;
  }> {
    if (!WORKSPACE_DIFF_CAPTURE_ENABLED) {
      const { snapshot, stats } = createDisabledWorkspaceSnapshotCapture();
      return {
        beforeSnapshot: snapshot,
        beforeSnapshotStats: stats,
      };
    }

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
    finalItems: CodexTurnItem[],
  ): Promise<{
    afterSnapshot: WorkspaceSnapshot;
    afterSnapshotStats: SnapshotCaptureStats;
    useSnapshotFallback: boolean;
  }> {
    if (!WORKSPACE_DIFF_CAPTURE_ENABLED) {
      const { snapshot, stats } = createDisabledWorkspaceSnapshotCapture();
      return {
        afterSnapshot: snapshot,
        afterSnapshotStats: stats,
        useSnapshotFallback: false,
      };
    }

    const snapshotRoots = this.buildSnapshotRoots(input);
    const indexKey = this.buildSnapshotIndexKey(snapshotRoots);
    const cachedIndex =
      this.workspaceSnapshotIndexes.get(indexKey) ??
      (await createWorkspaceSnapshotIndex(snapshotRoots));
    const candidatePaths = collectCompletedFileChangePaths(
      resolveRunWorkspacePath(input),
      finalItems,
    );
    const canUseTargetedSnapshot =
      candidatePaths.length > 0 && !hasBroadFilesystemChangeSource(finalItems);
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
    items: Map<string, CodexTurnItem>,
    usage: AuditLogUsage | null,
    threadId: string | null,
    streamedAssistantText: string,
    selection: ResolvedModelSelection,
    beforeSnapshot: WorkspaceSnapshot,
    beforeSnapshotStats: SnapshotCaptureStats,
    diagnostics: CodexTurnDiagnostics,
  ): Promise<RunSessionTurnResult> {
    const redactor = createProviderAgentRuntimeBindingRedactor(
      input.agentRuntimeBinding,
      [resolveCodexApiKey(input.providerCatalog.id, input.appSettings)],
    );
    const finalItems = Array.from(items.values());
    const providerMetadata = buildProviderMetadataProjection(finalItems);
    if (diagnostics.cleanupError) providerMetadata.push({
      provider: "codex", kind: "postprocess_degraded", source: "codex-adapter.process-cleanup",
      summary: "Codex process cleanup failed; the native turn outcome is preserved",
      payload: { message: diagnostics.cleanupError },
    });
    for (const metadata of providerMetadata) {
      this.writeLog({
        level: "warn",
        kind: "provider.unsupported-response",
        message: redactor.sanitizeText(metadata.summary),
        data: redactor.sanitize(toProviderMetadataLogData(metadata)),
      });
    }
    const {
      assistantText: itemAssistantText,
      lastNonEmptyAssistantMessageText: itemLastNonEmptyAssistantMessageText,
    } = collectCodexAssistantResponseFromItems(finalItems);
    const finalAssistantText =
      itemAssistantText.trim().length > 0
        ? itemAssistantText
        : streamedAssistantText;
    const lastNonEmptyAssistantMessageText =
      itemLastNonEmptyAssistantMessageText.trim().length > 0
        ? itemLastNonEmptyAssistantMessageText
        : streamedAssistantText;
    const snapshotResult = await raceWithDeadline(
      this.captureAfterWorkspaceSnapshot(input, finalItems),
      this.options.snapshotDeadlineMs ?? DEFAULT_CODEX_SNAPSHOT_DEADLINE_MS,
      CODEX_SNAPSHOT_TIMEOUT,
    );
    const snapshotTimedOut = snapshotResult === CODEX_SNAPSHOT_TIMEOUT;
    if (snapshotTimedOut) {
      const summary =
        "Workspace snapshot timed out after the provider turn; diff may be incomplete";
      providerMetadata.push({
        provider: "codex",
        kind: "postprocess_degraded",
        source: "codex-adapter.workspace-snapshot",
        summary,
        payload: {
          timeoutMs:
            this.options.snapshotDeadlineMs ??
            DEFAULT_CODEX_SNAPSHOT_DEADLINE_MS,
        },
      });
      this.writeLog({
        level: "warn",
        kind: "codex.run.snapshot-timeout",
        message: summary,
        data: {
          sessionId: input.session.id,
          timeoutMs:
            this.options.snapshotDeadlineMs ??
            DEFAULT_CODEX_SNAPSHOT_DEADLINE_MS,
        },
      });
    }
    const { afterSnapshot, afterSnapshotStats, useSnapshotFallback } =
      snapshotTimedOut
        ? {
            afterSnapshot: beforeSnapshot,
            afterSnapshotStats: beforeSnapshotStats,
            useSnapshotFallback: false,
          }
        : snapshotResult;
    const artifact = await buildArtifact(
      input.session,
      input.executionOptions,
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
      assistantText: redactor.sanitizeText(finalAssistantText),
      lastNonEmptyAssistantMessageText: redactor.sanitizeText(
        lastNonEmptyAssistantMessageText,
      ),
      artifact: redactor.sanitize(artifact),
      logicalPrompt: prompt.logicalPrompt,
      transportPayload: buildCodexTransportPayload(prompt),
      operations: redactor.sanitize(toAuditOperationsProjection(finalItems)),
      rawItemsJson: stringifyBoundedAuditRawItems(
        redactor.sanitize([...diagnostics.rawItems, ...buildStableRawItemsProjection(finalItems)]),
      ),
      providerMetadata: redactor.sanitize(providerMetadata),
      usage,
      providerQuotaTelemetry: null,
    };
  }

  async runSessionTurn(
    input: RunSessionTurnInput,
    onProgress?: RunSessionTurnProgressHandler,
  ): Promise<RunSessionTurnResult> {
    this.assertCleanupComplete(resolveRunWorkspacePath(input), input.session.id, input.session.threadId);
    const prompt = this.composePrompt(input);
    const state = createCodexTurnStreamState(input.session.threadId || null);
    const diagnostics: CodexTurnDiagnostics = { rawItems: [] };
    const { options, selection } = buildCodexThreadSettings(
      input.session,
      input.providerCatalog,
      input.executionOptions,
      resolveRunWorkspacePath(input),
    );
    const { beforeSnapshot, beforeSnapshotStats } =
      await this.prepareBeforeWorkspaceSnapshot(input);
    try {
      const { transport, apiKey } = this.createTransport(
        input.providerCatalog.id,
        input.appSettings,
        options.workingDirectory,
        input.agentRuntimeBinding,
        true,
      );
      await this.executeTurn({
        transport,
        apiKey,
        state,
        diagnostics,
        options,
        serviceTier: mapCodexSpeedToServiceTier(
          input.executionOptions.codexSpeed,
        ),
        reviewer: mapCodexReviewerToApprovalsReviewer(
          input.executionOptions.codexReviewer,
        ),
        input: userInput(prompt.logicalPrompt.composedText, prompt.imagePaths),
        signal: input.signal,
        sessionInput: input,
        onProgress,
      });
      return await this.buildTurnResult(
        input,
        prompt,
        state.items,
        state.usage,
        state.threadId,
        getLiveCodexAssistantText(state),
        selection,
        beforeSnapshot,
        beforeSnapshotStats,
        diagnostics,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canceled =
        Boolean(input.signal?.aborted) ||
        state.terminalStatus === "interrupted" ||
        isCanceledProviderMessage(message);
      const partial = await this.buildTurnResult(
        input,
        prompt,
        state.items,
        state.usage,
        state.threadId,
        getLiveCodexAssistantText(state),
        selection,
        beforeSnapshot,
        beforeSnapshotStats,
        diagnostics,
      );
      throw new ProviderTurnError(
        createProviderAgentRuntimeBindingRedactor(
          input.agentRuntimeBinding,
          [resolveCodexApiKey(input.providerCatalog.id, input.appSettings)],
        ).sanitizeText(message),
        partial,
        canceled,
        canceled ? "canceled" : error instanceof CodexAuthenticationError ? "auth" : resolveCodexProviderErrorReason(message, canceled),
      );
    }
  }
}
