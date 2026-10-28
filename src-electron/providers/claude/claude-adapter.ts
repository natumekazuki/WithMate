import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { query, resolveSettings, type ElicitationRequest, type Options, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageOperation, ProviderUsage, LiveElicitationField, LiveElicitationRequest, LiveRunStep } from "../../../src-shared/session/runtime-state.js";
import type { MessageArtifact } from "../../../src-shared/session/session-state.js";
import { resolveModelSelection } from "../../../src-shared/settings/model-catalog.js";
import { mapApprovalModeToClaudePermissionMode } from "../../../src-shared/settings/provider-runtime-options.js";
import { composeProviderPrompt, isCanceledProviderMessage } from "../provider-prompt.js";
import { ProviderTurnError, resolveRunWorkspacePath, type GetProviderQuotaTelemetryInput, type ProviderPromptComposition, type ProviderTurnAdapter, type RunSessionTurnInput, type RunSessionTurnProgressHandler, type RunSessionTurnResult } from "../provider-runtime.js";
import { resolveDevelopmentProviderBinaryPath, resolvePackagedProviderBinaryPath } from "../provider-binary-paths.js";
import { buildProviderAgentRuntimeBindingEnv, createProviderAgentRuntimeBindingRedactor, mergeDefinedProviderEnv, type ProviderAgentRuntimeBindingRedactor } from "../provider-agent-runtime-binding.js";
import { buildManagedHttpMcpServers } from "../managed-http-mcp.js";
import { PROVIDER_TEXT_PREVIEW_LIMIT, toProviderTextPreview } from "../../session/provider-payload-limits.js";
import { buildArtifactFromOperations } from "../provider-artifact.js";
import { captureWorkspaceSnapshot } from "../../platform/snapshot-ignore.js";
import { createDisabledWorkspaceSnapshotCapture, WORKSPACE_DIFF_CAPTURE_ENABLED } from "../../files/workspace-diff-policy.js";
import { buildLiveElicitationFieldFromMcpSchema } from "../mcp-elicitation.js";
import { ProviderProgressDelivery, ProviderProgressMap } from "../provider-progress.js";
import { projectClaudeQuotaTelemetry } from "./claude-quota-telemetry.js";
import type { ListProviderModelsInput } from "../provider-runtime.js";
import type { ModelCatalogProvider } from "../../../src-shared/settings/model-catalog.js";

const require = createRequire(import.meta.url);
const CANCEL_GRACE_MS = 2_000;

type ClaudeQuery = typeof query;
type ClaudeAdapterLogInput = { level: "info" | "warn" | "error"; message: string; data?: Record<string, unknown> };

export type ClaudeAdapterOptions = {
  query?: ClaudeQuery;
  spawnProcess?: typeof spawn;
  resolveSettings?: typeof resolveSettings;
  log?: (input: ClaudeAdapterLogInput) => void;
};

type ClaudeTrace = {
  threadId: string | null;
  messages: Array<{ id: string; text: string }>;
  streamingText: string;
  streamingId: string | null;
  steps: ProviderProgressMap<LiveRunStep>;
  operations: MessageOperation[];
  redactor: ProviderAgentRuntimeBindingRedactor;
  usage: ProviderUsage | null;
  result: SDKResultMessage | null;
  errorMessage: string;
};

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function providerErrorReason(message: string, canceled: boolean): "canceled" | "auth" | "usage_limit" | "network" | "provider_unavailable" | "unknown" {
  if (canceled) return "canceled";
  if (/auth|login|sign.?in|credential|unauthorized/i.test(message)) return "auth";
  if (/usage limit|rate limit|out of usage|quota|billing limit/i.test(message)) return "usage_limit";
  if (/network|ECONN|ETIMEDOUT|fetch failed/i.test(message)) return "network";
  if (/unavailable|overloaded|service down/i.test(message)) return "provider_unavailable";
  return "unknown";
}

function summarizeTool(name: string, input: unknown): string {
  const argumentsValue = objectOf(input);
  const target = textOf(argumentsValue.file_path) || textOf(argumentsValue.path) || textOf(argumentsValue.command);
  return target ? `${name}: ${toProviderTextPreview(target, 300)}` : name;
}

function commandOf(name: string, input: unknown, redactor: ProviderAgentRuntimeBindingRedactor): string | null {
  if (name !== "Bash") return null;
  const command = textOf(objectOf(input).command);
  const sanitized = redactor.sanitizeText(command, PROVIDER_TEXT_PREVIEW_LIMIT).slice(0, PROVIDER_TEXT_PREVIEW_LIMIT);
  const preview = (command.length > PROVIDER_TEXT_PREVIEW_LIMIT
    ? `${sanitized}\n...[truncated ${command.length - PROVIDER_TEXT_PREVIEW_LIMIT} chars; originalLength=${command.length}]`
    : sanitized) || null;
  // Detach the bounded preview from the native command's backing string.
  return command.length > PROVIDER_TEXT_PREVIEW_LIMIT
    ? JSON.parse(JSON.stringify(preview)) as string
    : preview;
}


function usageFromResult(result: SDKResultMessage, resumed: boolean): ProviderUsage {
  // modelUsage includes subagents, but its totals can include older turns after resume.
  const models = resumed ? [] : Object.values(result.modelUsage ?? {});
  const inputTokens = models.length > 0
    ? models.reduce((sum, usage) => sum + usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens, 0)
    : result.usage.input_tokens + result.usage.cache_read_input_tokens + result.usage.cache_creation_input_tokens;
  const cachedInputTokens = models.length > 0
    ? models.reduce((sum, usage) => sum + usage.cacheReadInputTokens, 0)
    : result.usage.cache_read_input_tokens;
  const outputTokens = models.length > 0
    ? models.reduce((sum, usage) => sum + usage.outputTokens, 0)
    : result.usage.output_tokens;
  const reasoningOutputTokens = models.reduce((sum, usage) => sum + (usage.thinkingTokens ?? 0), 0);
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens: inputTokens + outputTokens };
}

function assistantText(trace: ClaudeTrace): string {
  return trace.messages.map((message) => message.text).filter(Boolean).join("\n\n");
}

function liveText(trace: ClaudeTrace): string {
  return [assistantText(trace), trace.streamingText].filter(Boolean).join("\n\n")
    || (trace.result?.subtype === "success" && !trace.result.is_error ? trace.result.result : "");
}

function signalRace<T>(promise: Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => undefined);
    return Promise.reject(new Error("Canceled"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Canceled"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function closeQuery(iterator: ReturnType<ClaudeQuery>, force: boolean): Promise<void> {
  if (force) {
    iterator.close?.();
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const graceful = Promise.resolve(iterator.return?.()).then(() => true, () => false);
    const timed = new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), CANCEL_GRACE_MS); });
    if (!await Promise.race([graceful, timed])) iterator.close?.();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function claudeQuestionRequest(requestId: string, input: Record<string, unknown>): LiveElicitationRequest {
  const questions = Array.isArray(input.questions) ? input.questions.map(objectOf) : [];
  const fields: LiveElicitationField[] = questions.flatMap<LiveElicitationField>((question, index) => {
    const options = Array.isArray(question.options) ? question.options.map(objectOf) : [];
    const title = textOf(question.question) || `Question ${index + 1}`;
    if (options.length === 0) return [{ type: "text", name: String(index), title, required: true }];
    const choices = options.map((option) => ({
      value: textOf(option.label),
      label: textOf(option.description) ? `${textOf(option.label)} — ${textOf(option.description)}` : textOf(option.label),
    }));
    const selection: LiveElicitationField = question.multiSelect === true
      ? { type: "multi-select", name: String(index), title, required: true, options: choices, allowFreeText: true }
      : { type: "select", name: String(index), title, required: true, options: choices, allowFreeText: true };
    return [selection];
  });
  return { requestId, provider: "claude", kind: "question", mode: "form", message: "Claude has a question", fields };
}

function mcpElicitationRequest(requestId: string, request: ElicitationRequest): LiveElicitationRequest | null {
  if (request.mode === "url") {
    return { requestId, provider: "claude", mode: "url", message: request.message, source: request.serverName, fields: [], url: request.url };
  }
  const schema = objectOf(request.requestedSchema);
  const properties = objectOf(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
  const fields: LiveElicitationField[] = [];
  for (const [name, unknownSpec] of Object.entries(properties)) {
    const field = buildLiveElicitationFieldFromMcpSchema(name, unknownSpec, required.has(name));
    if (!field) return null;
    fields.push(field);
  }
  return { requestId, provider: "claude", mode: "form", message: request.message, source: request.serverName, fields };
}

async function buildUserMessage(prompt: ProviderPromptComposition, uuid: ReturnType<typeof randomUUID>): Promise<SDKUserMessage> {
  const images = await Promise.all(prompt.imagePaths.map(async (imagePath) => {
    const suffix = extname(imagePath).toLowerCase();
    const mime: "image/png" | "image/webp" | "image/jpeg" | "image/gif" = suffix === ".png" ? "image/png"
      : suffix === ".webp" ? "image/webp"
        : suffix === ".gif" ? "image/gif"
          : suffix === ".jpg" || suffix === ".jpeg" ? "image/jpeg"
            : (() => { throw new Error(`Unsupported Claude image type: ${suffix}`); })();
    return { type: "image" as const, source: { type: "base64" as const, media_type: mime, data: (await readFile(imagePath)).toString("base64") } };
  }));
  return {
    type: "user", uuid, parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text: prompt.inputBodyText }, ...images] },
  };
}

export function resolveClaudeBinaryPath(): string {
  const packaged = resolvePackagedProviderBinaryPath("claude");
  if (packaged) return packaged;
  const development = resolveDevelopmentProviderBinaryPath("claude", require.resolve);
  if (development) return development;
  throw new Error("Claude native executable is unavailable for this platform");
}

export class ClaudeAdapter implements ProviderTurnAdapter {
  private readonly runQuery: ClaudeQuery;
  private readonly spawnProcess: typeof spawn;
  private readonly inspectSettings: typeof resolveSettings;
  private readonly log?: ClaudeAdapterOptions["log"];

  constructor(options: ClaudeAdapterOptions = {}) {
    this.runQuery = options.query ?? query;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.inspectSettings = options.resolveSettings ?? resolveSettings;
    this.log = options.log;
  }

  composePrompt(input: RunSessionTurnInput): ProviderPromptComposition {
    return composeProviderPrompt(input);
  }

  async listModels(input: ListProviderModelsInput): Promise<ModelCatalogProvider> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const timer = setTimeout(abort, 30_000);
    let iterator: ReturnType<ClaudeQuery> | undefined;
    let childExited: Promise<void> | undefined;
    let closeInput!: () => void;
    const inputClosed = new Promise<void>((resolve) => { closeInput = resolve; });
    async function* emptyInput(): AsyncGenerator<SDKUserMessage> { await inputClosed; }
    try {
      controller.signal.throwIfAborted();
      const settings = await signalRace(this.inspectSettings({ cwd: input.workspacePath, settingSources: [] }), controller.signal);
      if (settings.sources.some((source) => source.source === "managed")) throw new Error("Managed settings prevent metadata-only discovery");
      controller.signal.throwIfAborted();
      iterator = this.runQuery({ prompt: emptyInput(), options: {
        cwd: input.workspacePath, pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
        env: mergeDefinedProviderEnv(process.env, {}),
        tools: [], mcpServers: {}, strictMcpConfig: true,
        settingSources: [], settings: { disableAllHooks: true }, persistSession: false,
        abortController: controller,
        spawnClaudeCodeProcess: (options) => {
          const child = this.spawnProcess(options.command, options.args, {
            cwd: options.cwd, env: options.env, signal: options.signal,
            stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
          });
          child.stderr?.on("error", () => undefined);
          child.stderr?.resume();
          childExited = new Promise<void>((resolve) => {
            child.once("close", () => resolve());
            child.once("error", () => { if (child.pid === undefined) resolve(); });
          });
          return child;
        },
      } });
      const metadata = await signalRace(iterator.supportedModels(), controller.signal);
      const models = metadata.map((model) => ({ id: model.value, label: model.displayName,
        reasoningEfforts: model.supportsEffort ? model.supportedEffortLevels ?? [] : [], defaultReasoningEffort: "" }));
      return { id: "claude", label: "Claude", models, defaultModelId: models[0]?.id ?? "", defaultReasoningEffort: "" };
    } catch {
      throw new Error(controller.signal.aborted ? "Claude model discovery canceled" : "Claude models could not be retrieved");
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      closeInput();
      try { iterator?.close(); }
      catch { throw new Error("Claude model discovery process cleanup failed"); }
      finally {
        controller.abort();
        if (childExited) await childExited;
      }
    }
  }

  async getProviderQuotaTelemetry(input: GetProviderQuotaTelemetryInput) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, 30_000);
    let iterator: ReturnType<ClaudeQuery> | null = null;
    let childExited: Promise<void> | null = null;
    let closeInput!: () => void;
    const inputClosed = new Promise<void>((resolve) => { closeInput = resolve; });
    async function* emptyInput(): AsyncGenerator<SDKUserMessage> { await inputClosed; }
    try {
      if (controller.signal.aborted) throw new Error("Canceled");
      // Managed policy can force hooks and MCP before any prompt is supplied.
      const settings = await signalRace(this.inspectSettings({ cwd: process.cwd(), settingSources: [] }), controller.signal);
      if (settings.sources.some((source) => source.source === "managed")) throw new Error("Claude quota retrieval is unavailable with managed settings");
      if (controller.signal.aborted) throw new Error("Canceled");
      iterator = this.runQuery({ prompt: emptyInput(), options: {
        cwd: process.cwd(),
        pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
        env: mergeDefinedProviderEnv(process.env, {}),
        tools: [], mcpServers: {}, strictMcpConfig: true,
        settingSources: [], settings: { disableAllHooks: true }, persistSession: false,
        abortController: controller,
        spawnClaudeCodeProcess: (options) => {
          const child = this.spawnProcess(options.command, options.args, {
            cwd: options.cwd, env: options.env, signal: options.signal,
            stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
          });
          child.stderr?.on("error", () => undefined);
          child.stderr?.resume();
          childExited = new Promise<void>((resolve) => {
            child.once("close", () => resolve());
            child.once("error", () => { if (child.pid === undefined) resolve(); });
          });
          return child;
        },
      } });
      await signalRace(iterator.initializationResult(), controller.signal);
      return projectClaudeQuotaTelemetry(await signalRace(iterator.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), controller.signal));
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      closeInput();
      try { iterator?.close(); }
      finally {
        controller.abort();
        if (childExited) await childExited;
      }
    }
  }
  async invalidateSessionThread(): Promise<void> { /* One process per turn; no cached thread. */ }
  async invalidateAllSessionThreads(): Promise<void> { /* One process per turn; no cached thread. */ }

  private makeTrace(threadId: string | null, redactor = createProviderAgentRuntimeBindingRedactor(null)): ClaudeTrace {
    return { threadId, messages: [], streamingText: "", streamingId: null, steps: new ProviderProgressMap(), operations: [], redactor, usage: null, result: null, errorMessage: "" };
  }

  private receive(message: SDKMessage, trace: ClaudeTrace, resumed = false): void {
    if (message.type === "system" && message.subtype === "init") {
      trace.threadId = message.session_id;
      return;
    }
    if (message.type === "stream_event" && !message.parent_tool_use_id) {
      const event = message.event;
      if (event.type === "message_start") {
        trace.streamingId = event.message.id;
        trace.streamingText = "";
      }
      if (event.type === "message_stop") {
        trace.streamingId = null;
      }
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        trace.streamingText += event.delta.text;
      }
      return;
    }
    if (message.type === "assistant" && !message.parent_tool_use_id) {
      const content = message.message.content;
      const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      if (text && !trace.messages.some((entry) => entry.id === message.uuid)) {
        trace.messages.push({ id: message.uuid, text });
        trace.operations.push({ id: message.uuid, type: "agent_message", summary: toProviderTextPreview(text, 300) ?? "", details: toProviderTextPreview(text), truncated: text.length > PROVIDER_TEXT_PREVIEW_LIMIT });
      }
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        const command = commandOf(block.name, block.input, trace.redactor);
        const summary = command ?? summarizeTool(block.name, block.input);
        const step: LiveRunStep = { id: block.id, type: command === null ? "tool_call" : "command_execution", summary, status: "in_progress" };
        trace.steps.set(block.id, step);
        trace.operations.push(step);
      }
      if (text && trace.streamingId === message.message.id) {
        trace.streamingText = "";
      }
      if (message.error) trace.errorMessage = message.error;
      return;
    }
    if (message.type === "user" && !message.parent_tool_use_id && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue;
        const step = trace.steps.get(block.tool_use_id);
        const failed = block.is_error === true;
        if (step) {
          const rawOutput = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          const output = rawOutput === undefined ? undefined : trace.redactor.sanitizeText(rawOutput);
          const details = toProviderTextPreview(output);
          const completed: LiveRunStep = { ...step, status: failed ? "failed" : "completed", details,
            ...(output !== undefined ? { truncated: output.length > PROVIDER_TEXT_PREVIEW_LIMIT } : {}),
            ...(failed && details !== undefined ? { error: { message: details } } : {}) };
          trace.steps.set(step.id, completed);
          const index = trace.operations.findIndex((operation) => operation.id === step.id);
          if (index >= 0) trace.operations[index] = completed;
        }
      }
      return;
    }
    if (message.type === "result") {
      trace.result = message;
      trace.threadId = message.session_id;
      trace.usage = usageFromResult(message, resumed);
      if (message.subtype !== "success") trace.errorMessage = message.errors.join("\n") || message.subtype;
      else if (message.is_error) trace.errorMessage = message.result;
    }
  }

  private addExecutionChecks(artifact: MessageArtifact | undefined, input: RunSessionTurnInput, trace: ClaudeTrace): void {
    if (!artifact) return;
    const state = trace.result?.fast_mode_state;
    const speed = input.executionOptions.codexSpeed === "standard" ? "Standard"
      : state === "on" ? "Fast"
        : state ? `Standard (Fast ${state})` : "Fast (Requested)";
    artifact.runChecks.push({ label: "speed", value: speed });
    artifact.runChecks.push({ label: "reviewer", value: input.executionOptions.codexReviewer });
  }

  private result(input: RunSessionTurnInput, trace: ClaudeTrace): RunSessionTurnResult {
    const redactor = createProviderAgentRuntimeBindingRedactor(input.agentRuntimeBinding);
    const text = liveText(trace);
    const operations = redactor.sanitize(trace.operations);
    const emptySnapshot = createDisabledWorkspaceSnapshotCapture();
    const artifact = buildArtifactFromOperations({
      session: input.session,
      executionOptions: input.executionOptions,
      operations,
      usage: trace.usage,
      threadId: trace.threadId,
      beforeSnapshot: emptySnapshot.snapshot,
      afterSnapshot: emptySnapshot.snapshot,
      beforeSnapshotStats: emptySnapshot.stats,
      afterSnapshotStats: emptySnapshot.stats,
      providerCatalog: input.providerCatalog,
      selection: resolveModelSelection(input.providerCatalog, input.executionOptions.model, input.executionOptions.reasoningEffort),
    });
    this.addExecutionChecks(artifact, input, trace);
    return {
      threadId: trace.threadId,
      assistantText: redactor.sanitizeText(text),
      lastNonEmptyAssistantMessageText: redactor.sanitizeText(trace.streamingText || trace.messages.at(-1)?.text || text),
      artifact: redactor.sanitize(artifact),
      usage: trace.usage,
    };
  }

  async runSessionTurn(input: RunSessionTurnInput, onProgress?: RunSessionTurnProgressHandler): Promise<RunSessionTurnResult> {
    const permissionMode = mapApprovalModeToClaudePermissionMode(input.executionOptions.approvalMode, input.executionOptions.codexReviewer);
    const prompt = this.composePrompt(input);
    const redactor = createProviderAgentRuntimeBindingRedactor(input.agentRuntimeBinding);
    const trace = this.makeTrace(input.session.threadId || null, redactor);
    const workspacePath = resolveRunWorkspacePath(input);
    const selection = resolveModelSelection(input.providerCatalog, input.executionOptions.model, input.executionOptions.reasoningEffort);
    const controller = new AbortController();
    let childExited: Promise<void> | null = null;
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) controller.abort();
    let approvalRequest: { requestId: string; provider: string; kind: string; title: string; summary: string; decisionMode: "direct-decision" } | null = null;
    let elicitationRequest: LiveElicitationRequest | null = null;
    let interactionTail: Promise<void> = Promise.resolve();
    const enqueueInteraction = <T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T> | T): Promise<T> => {
      const pending = interactionTail.then(() => {
        if (signal.aborted) throw new Error("Canceled");
        return action(signal);
      });
      // Keep the single pending service slot occupied until its actual request settles.
      interactionTail = pending.then(() => undefined, () => undefined);
      return signalRace(pending, signal);
    };
    let progressFailure: unknown;
    const progressDelivery = new ProviderProgressDelivery(onProgress, (error) => {
      progressFailure ??= error;
      controller.abort();
    });
    const progress = (): Promise<void> => {
      if (controller.signal.aborted || !onProgress) return Promise.resolve();
      const steps = trace.steps.takeProgress(redactor);
      const state = {
        sessionId: input.session.id,
        threadId: trace.threadId ?? "",
        assistantText: redactor.sanitizeText(liveText(trace)),
        steps: steps.snapshot,
        backgroundTasks: [],
        usage: trace.usage,
        errorMessage: redactor.sanitizeText(trace.errorMessage),
        approvalRequest: redactor.sanitize(approvalRequest),
        elicitationRequest: redactor.sanitize(elicitationRequest),
      };
      return progressDelivery.deliver(state, { steps: steps.changes, backgroundTasks: { upserts: [], removes: [] } });
    };
    const options: Options = {
      cwd: workspacePath,
      title: input.session.taskTitle || "WithMate session",
      pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
      env: mergeDefinedProviderEnv(process.env, buildProviderAgentRuntimeBindingEnv(input.agentRuntimeBinding)),
      model: selection.resolvedModel,
      ...(selection.resolvedReasoningEffort ? { effort: selection.resolvedReasoningEffort as Options["effort"] } : {}),
      permissionMode,
      allowDangerouslySkipPermissions: input.executionOptions.approvalMode === "never",
      settings: { fastMode: input.executionOptions.codexSpeed === "fast" },
      resume: input.session.threadId || undefined,
      systemPrompt: { type: "preset", preset: "claude_code", append: prompt.systemBodyText, snapshot: false },
      additionalDirectories: prompt.additionalDirectories,
      settingSources: ["user", "project", "local"],
      ...(input.agentRuntimeBinding?.managedMcp
        ? { mcpServers: buildManagedHttpMcpServers(input.agentRuntimeBinding) }
        : {}),
      includePartialMessages: true,
      abortController: controller,
      spawnClaudeCodeProcess: (spawnOptions) => {
        const child = this.spawnProcess(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          signal: spawnOptions.signal,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        child.stderr?.on("error", () => undefined);
        child.stderr?.resume();
        childExited = new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.once("error", () => {
            // AbortError may precede exit. Only a failed spawn has no child to await.
            if (child.pid === undefined) resolve();
          });
        });
        return child;
      },
      hooks: {
        PreToolUse: [{ hooks: [async (hookInput) => {
          if (hookInput.hook_event_name !== "PreToolUse") return {};
          if (controller.signal.aborted) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Canceled" } };
          const readOnly = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
          if (readOnly.has(hookInput.tool_name)) return {};
          if (permissionMode === "dontAsk") return {};
          if (permissionMode !== "default" && hookInput.tool_name !== "AskUserQuestion") return {};
          return { hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: "WithMate approval required",
          } };
        }] }],
      },
      canUseTool: async (toolName, toolInput, context) => {
        if (controller.signal.aborted || context.signal.aborted) return { behavior: "deny", message: "Canceled" };
        if (permissionMode === "dontAsk") return { behavior: "deny", message: "Only preapproved tools are allowed" };
        const requestId = context.toolUseID || `${input.session.id}:${Date.now()}`;
        if (toolName === "AskUserQuestion") {
          if (!input.onElicitationRequest) return { behavior: "deny", message: "Question UI is unavailable" };
          try {
            const textPosition = redactor.sanitizeText(liveText(trace)).length;
            const answer = await enqueueInteraction(AbortSignal.any([controller.signal, context.signal]), async (signal) => {
              elicitationRequest = { ...redactor.sanitize(claudeQuestionRequest(requestId, toolInput)), textPosition };
              await progress();
              try { return await input.onElicitationRequest!(elicitationRequest, signal); }
              finally { elicitationRequest = null; void progress().catch(() => undefined); }
            });
            if (answer.action !== "accept") return { behavior: "deny", message: "Question declined" };
            const questions = Array.isArray(toolInput.questions) ? toolInput.questions.map(objectOf) : [];
            const entries = questions.map((question, index) => {
              const value = answer.content?.[String(index)];
              return [textOf(question.question), Array.isArray(value) ? value.join(", ") : value] as const;
            });
            if (entries.some(([question, value]) => !question || typeof value !== "string" || !value.trim())) {
              return { behavior: "deny", message: "Question answer is incomplete" };
            }
            const answers = Object.fromEntries(entries);
            return { behavior: "allow", updatedInput: { ...toolInput, answers } };
          } catch { return { behavior: "deny", message: "Canceled" }; }
        }
        if (!input.onApprovalRequest) {
          return { behavior: "deny", message: "Tool approval is unavailable" };
        }
        try {
          const decision = await enqueueInteraction(AbortSignal.any([controller.signal, context.signal]), async (signal) => {
            approvalRequest = redactor.sanitize({ requestId, provider: "claude", kind: toolName, title: `Allow ${toolName}?`, summary: summarizeTool(toolName, toolInput), decisionMode: "direct-decision" });
            void progress().catch(() => undefined);
            try { return await input.onApprovalRequest!(approvalRequest, signal); }
            finally { approvalRequest = null; void progress().catch(() => undefined); }
          });
          return decision === "approve" ? { behavior: "allow" } : { behavior: "deny", message: "Denied by user" };
        } catch { return { behavior: "deny", message: "Canceled" }; }
      },
      onElicitation: async (request, context) => {
        if (!input.onElicitationRequest || controller.signal.aborted) return { action: "decline" };
        const projected = redactor.sanitize(mcpElicitationRequest(context.requestId, request));
        if (!projected) return { action: "decline" };
        projected.textPosition = redactor.sanitizeText(liveText(trace)).length;
        try {
          const answer = await enqueueInteraction(AbortSignal.any([controller.signal, context.signal]), async (signal) => {
            elicitationRequest = projected;
            await progress();
            try { return await input.onElicitationRequest!(projected, signal); }
            finally { elicitationRequest = null; void progress().catch(() => undefined); }
          });
          return answer.action === "accept"
            ? projected.mode === "url" ? { action: "accept" } : { action: "accept", content: answer.content ?? {} }
            : { action: answer.action };
        } catch { return { action: "cancel" }; }
      },
    };
    const snapshotRoots = [workspacePath, ...prompt.additionalDirectories];
    const before = WORKSPACE_DIFF_CAPTURE_ENABLED
      ? await captureWorkspaceSnapshot(snapshotRoots).catch(() => createDisabledWorkspaceSnapshotCapture())
      : createDisabledWorkspaceSnapshotCapture();
    let iterator: ReturnType<ClaudeQuery> | null = null;
    const userMessageId = randomUUID();
    let releaseInput!: () => void;
    const inputReleased = new Promise<void>((resolve) => { releaseInput = resolve; });
    try {
      const userMessage = await buildUserMessage(prompt, userMessageId);
      if (controller.signal.aborted) throw new Error("Canceled");
      async function* sdkInput(): AsyncGenerator<SDKUserMessage> {
        yield userMessage;
        // A transcript-only notification can emit a result before this send runs.
        // Do not let that result close the SDK's approval/hook input channel.
        await inputReleased;
      }
      iterator = this.runQuery({ prompt: sdkInput(), options });
      let burst = 0;
      while (true) {
        const next = await signalRace(iterator.next(), controller.signal);
        if (next.done) break;
        if (next.value.type === "result") {
          const terminal = next.value;
          const matchesInput = terminal.user_message_uuid === userMessageId || terminal.user_message_uuids?.includes(userMessageId);
          const sessionFailure = !terminal.user_message_uuid && !terminal.user_message_uuids?.length && !terminal.origin
            && (terminal.subtype !== "success" || terminal.is_error);
          if (!matchesInput && !sessionFailure) continue;
        }
        this.receive(next.value, trace, Boolean(input.session.threadId));
        if (next.value.type === "system" && next.value.subtype === "init") {
          if (next.value.permissionMode && next.value.permissionMode !== permissionMode) {
            throw new Error(`Claude did not apply the requested permission mode (${permissionMode}); active mode: ${next.value.permissionMode}.`);
          }
          if (input.executionOptions.codexSpeed === "fast" && next.value.fast_mode_state === "off" && next.value.fast_mode_disabled_reason !== "pending") {
            throw new Error(`Claude Fast mode is unavailable (${next.value.fast_mode_disabled_reason ?? "disabled"}). Select Standard to continue.`);
          }
        }
        await signalRace(progress(), controller.signal);
        if (trace.result) break;
        if (++burst >= 32) { burst = 0; await signalRace(new Promise<void>(resolve => setImmediate(resolve)), controller.signal); }
      }
      if (progressFailure) throw progressFailure;
      if (controller.signal.aborted) throw new Error("Canceled");
      if (!trace.result) throw new Error("Claude stream ended before a result");
      if (trace.result.subtype !== "success" || trace.result.is_error) throw new Error(trace.errorMessage || "Claude turn failed");
      const result = this.result(input, trace);
      const after = WORKSPACE_DIFF_CAPTURE_ENABLED
        ? await captureWorkspaceSnapshot(snapshotRoots).catch(() => createDisabledWorkspaceSnapshotCapture())
        : createDisabledWorkspaceSnapshotCapture();
      result.artifact = redactor.sanitize(buildArtifactFromOperations({
        session: input.session,
        executionOptions: input.executionOptions,
        operations: result.artifact?.operationTimeline ?? [],
        usage: result.usage,
        threadId: result.threadId,
        beforeSnapshot: before.snapshot,
        afterSnapshot: after.snapshot,
        beforeSnapshotStats: before.stats,
        afterSnapshotStats: after.stats,
        providerCatalog: input.providerCatalog,
        selection,
      }));
      this.addExecutionChecks(result.artifact, input, trace);
      return result;
    } catch (error) {
      const failure = progressFailure ?? error;
      const message = failure instanceof Error ? failure.message : String(failure);
      const canceled = !progressFailure && (controller.signal.aborted || isCanceledProviderMessage(message));
      trace.errorMessage = message;
      throw new ProviderTurnError(redactor.sanitizeText(message), this.result(input, trace), canceled, providerErrorReason(message, canceled));
    } finally {
      releaseInput();
      input.signal?.removeEventListener("abort", abort);
      if (progressFailure !== undefined && childExited && input.onCleanupPending) {
        input.onCleanupPending(childExited);
      }
      try {
        if (iterator) await closeQuery(iterator, controller.signal.aborted || !trace.result);
      } finally {
        controller.abort();
        if (childExited && (input.signal?.aborted || (progressFailure !== undefined && !input.onCleanupPending))) {
          await childExited;
        }
      }
    }
  }


}
