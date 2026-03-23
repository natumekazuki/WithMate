import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  CopilotClient,
  approveAll,
  type CopilotSession,
  type PermissionHandler,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";

import type { AuditLogOperation, AuditLogUsage, LiveRunStep } from "../src/app-state.js";
import { getProviderAppSettings } from "../src/app-state.js";
import { normalizeApprovalMode } from "../src/approval-mode.js";
import { resolveModelSelection, type ResolvedModelSelection } from "../src/model-catalog.js";
import { composeProviderPrompt, isCanceledProviderMessage } from "./provider-prompt.js";
import {
  ProviderTurnError,
  type ProviderPromptComposition,
  type ProviderTurnAdapter,
  type RunSessionTurnInput,
  type RunSessionTurnProgressHandler,
  type RunSessionTurnResult,
} from "./provider-runtime.js";

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

function buildCopilotClientKey(providerId: string, input: RunSessionTurnInput): string {
  const codingApiKey = getProviderAppSettings(input.appSettings, providerId).apiKey.trim();
  return JSON.stringify([providerId, codingApiKey || null]);
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

function buildPermissionHandler(approvalMode: string): PermissionHandler {
  switch (normalizeApprovalMode(approvalMode)) {
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
      return (request) => (
        isReadOnlyPermissionRequest(request)
          ? toPermissionDecision("approved")
          : toPermissionDecision("denied-no-approval-rule-and-could-not-request-from-user")
      );
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
  });
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
    clientKey: string,
  ): {
    config: SessionConfig;
    selection: ResolvedModelSelection;
    settingsKey: string;
  } {
    const selection = resolveModelSelection(input.providerCatalog, input.session.model, input.session.reasoningEffort);
    const config: SessionConfig = {
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort === "minimal" ? "low" : selection.resolvedReasoningEffort,
      workingDirectory: input.session.workspacePath,
      streaming: true,
      onPermissionRequest: buildPermissionHandler(input.session.approvalMode),
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
      ]),
    };
  }

  private async getSession(input: RunSessionTurnInput): Promise<{ session: CopilotSession; selection: ResolvedModelSelection }> {
    const { client, clientKey } = this.getClient(input.providerCatalog.id, input);
    const nextSettings = this.buildSessionConfig(input, clientKey);
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

  private buildTurnResult(
    prompt: ProviderPromptComposition,
    threadId: string | null,
    assistantText: string,
    steps: Map<string, LiveRunStep>,
    usage: AuditLogUsage | null,
    events: SessionEvent[],
  ): RunSessionTurnResult {
    return {
      threadId,
      assistantText,
      systemPromptText: prompt.systemPromptText,
      inputPromptText: prompt.inputPromptText,
      composedPromptText: prompt.composedPromptText,
      operations: toCommandOperations(steps),
      rawItemsJson: JSON.stringify(events, null, 2),
      usage,
    };
  }

  private async runSessionTurnOnce(
    input: RunSessionTurnInput,
    prompt: ProviderPromptComposition,
    onProgress?: RunSessionTurnProgressHandler,
  ): Promise<RunSessionTurnResult> {
    if (input.attachments.length > 0) {
      throw new Error("Copilot provider はまだ file / folder / image 添付に対応していないよ。");
    }

    const cliPath = resolveCopilotCliPath();
    let session: CopilotSession;
    try {
      ({ session } = await this.getSession(input));
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
          systemPromptText: prompt.systemPromptText,
          inputPromptText: prompt.inputPromptText,
          composedPromptText: prompt.composedPromptText,
          operations: [],
          rawItemsJson: buildCopilotBootstrapDebugItems(input, cliPath, "session-bootstrap", message),
          usage: null,
        },
        Boolean(input.signal?.aborted) || isCanceledProviderMessage(message),
      );
    }
    const liveSteps = new Map<string, LiveRunStep>();
    const permissionToStepId = new Map<string, string>();
    const toolNamesByCallId = new Map<string, string>();
    const events: SessionEvent[] = [];
    let assistantText = "";
    let usage: AuditLogUsage | null = null;
    let streamErrorMessage = "";
    let progressChain = Promise.resolve();
    const scheduleLiveState = () => {
      progressChain = progressChain.then(() =>
        emitLiveState(onProgress, input.session.id, session.sessionId, liveSteps, assistantText, usage, streamErrorMessage),
      );
      return progressChain;
    };

    const updateCommandStep = (nextState: CopilotCommandStepState) => {
      liveSteps.set(nextState.stepId, {
        id: nextState.stepId,
        type: "command_execution",
        summary: nextState.summary,
        details: nextState.details,
        status: nextState.status,
      });
    };

    await emitLiveState(onProgress, input.session.id, session.sessionId, liveSteps, assistantText, usage, streamErrorMessage);

    const unsubscribe = session.on((event) => {
      events.push(event);

      switch (event.type) {
        case "assistant.message_delta":
          if (!event.data.parentToolCallId) {
            assistantText += event.data.deltaContent;
          }
          break;
        case "assistant.message":
          if (!event.data.parentToolCallId) {
            assistantText = event.data.content;
          }
          break;
        case "assistant.usage":
          usage = toAuditUsageFromCopilot(event.data);
          break;
        case "session.error":
          streamErrorMessage = event.data.message;
          break;
        case "permission.requested": {
          const request = event.data.permissionRequest;
          if (request.kind === "shell") {
            const stepId = request.toolCallId ?? event.data.requestId;
            permissionToStepId.set(event.data.requestId, stepId);
            toolNamesByCallId.set(stepId, "shell");
            updateCommandStep({
              stepId,
              summary: request.fullCommandText,
              details: request.warning,
              status: "pending",
            });
          }
          break;
        }
        case "permission.completed": {
          const stepId = permissionToStepId.get(event.data.requestId);
          if (!stepId) {
            break;
          }

          const current = liveSteps.get(stepId);
          if (!current) {
            break;
          }

          updateCommandStep({
            stepId,
            summary: current.summary,
            details: appendDetail(current.details, `permission: ${event.data.result.kind}`),
            status: event.data.result.kind === "approved" ? "in_progress" : "failed",
          });
          break;
        }
        case "tool.execution_start":
          toolNamesByCallId.set(event.data.toolCallId, event.data.toolName);
          if (event.data.toolName === "shell") {
            const current = liveSteps.get(event.data.toolCallId);
            updateCommandStep({
              stepId: event.data.toolCallId,
              summary: current?.summary ?? extractShellCommandFromArguments(event.data.arguments) ?? "shell",
              details: current?.details,
              status: "in_progress",
            });
          }
          break;
        case "tool.execution_partial_result": {
          const current = liveSteps.get(event.data.toolCallId);
          if (!current) {
            break;
          }

          updateCommandStep({
            stepId: current.id,
            summary: current.summary,
            details: appendDetail(current.details, event.data.partialOutput),
            status: "in_progress",
          });
          break;
        }
        case "tool.execution_complete":
          if (liveSteps.has(event.data.toolCallId) || toolNamesByCallId.get(event.data.toolCallId) === "shell") {
            const current = liveSteps.get(event.data.toolCallId);
            updateCommandStep({
              stepId: event.data.toolCallId,
              summary: current?.summary ?? "shell",
              details: appendDetail(current?.details, extractToolExecutionDetails(event)),
              status: event.data.success ? "completed" : "failed",
            });
          }
          break;
        default:
          break;
      }

      void scheduleLiveState();
    });

    const handleAbort = () => {
      void session.abort().catch(() => undefined);
    };

    input.signal?.addEventListener("abort", handleAbort, { once: true });

    try {
      const finalMessage = await session.sendAndWait(
        {
          prompt: prompt.composedPromptText,
        },
        180_000,
      );
      await progressChain;

      if (finalMessage?.data.content && !assistantText.trim()) {
        assistantText = finalMessage.data.content;
      }

      if (streamErrorMessage) {
        const partialResult = this.buildTurnResult(
          prompt,
          session.sessionId,
          assistantText,
          liveSteps,
          usage,
          events,
        );
        throw new ProviderTurnError(
          streamErrorMessage,
          partialResult,
          Boolean(input.signal?.aborted) || isCanceledProviderMessage(streamErrorMessage),
        );
      }

      return this.buildTurnResult(prompt, session.sessionId, assistantText, liveSteps, usage, events);
    } catch (error) {
      if (error instanceof ProviderTurnError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const partialResult = this.buildTurnResult(prompt, session.sessionId, assistantText, liveSteps, usage, events);
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
}
