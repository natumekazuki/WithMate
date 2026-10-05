import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { query, resolveSettings, type ElicitationRequest, type Options, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AuditLogOperation, AuditLogUsage, AuditTransportPayload, LiveElicitationField, LiveElicitationRequest, LiveRunStep } from "../../../src-shared/session/runtime-state.js";
import { resolveModelSelection } from "../../../src-shared/settings/model-catalog.js";
import { composeProviderPrompt, isCanceledProviderMessage } from "../provider-prompt.js";
import {
  ProviderTurnError,
  PROVIDER_SCHEMA_BACKGROUND_STRUCTURED_PROMPT_POLICY,
  resolveRunWorkspacePath,
  type ExtractSessionMemoryInput,
  type ExtractSessionMemoryResult,
  type ProviderPromptComposition,
  type ProviderTurnAdapter,
  type RunBackgroundStructuredPromptInput,
  type RunBackgroundStructuredPromptResult,
  type RunSessionTurnInput,
  type RunSessionTurnProgressHandler,
  type RunSessionTurnResult,
} from "../provider-runtime.js";
import { parseSessionMemoryDeltaText } from "../../session/session-memory-extraction.js";
import { resolveDevelopmentProviderBinaryPath, resolvePackagedProviderBinaryPath } from "../provider-binary-paths.js";
import { buildProviderAgentRuntimeBindingEnv, createProviderAgentRuntimeBindingRedactor, mergeDefinedProviderEnv, type ProviderAgentRuntimeBindingRedactor } from "../provider-agent-runtime-binding.js";
import { boundAuditRawItem, BoundedAuditRawItems, toAuditTextPreview } from "../../session/audit-payload-limits.js";
import { buildArtifactFromOperations } from "../provider-artifact.js";
import { captureWorkspaceSnapshot } from "../../platform/snapshot-ignore.js";
import { createDisabledWorkspaceSnapshotCapture, WORKSPACE_DIFF_CAPTURE_ENABLED } from "../../files/workspace-diff-policy.js";
import { buildLiveElicitationFieldFromMcpSchema } from "../mcp-elicitation.js";

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
  steps: Map<string, LiveRunStep>;
  operations: AuditLogOperation[];
  rawItems: BoundedAuditRawItems;
  redactor: ProviderAgentRuntimeBindingRedactor;
  usage: AuditLogUsage | null;
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
  return target ? `${name}: ${toAuditTextPreview(target, 300)}` : name;
}

function commandOf(name: string, input: unknown): string | null {
  return name === "Bash" ? textOf(objectOf(input).command) || null : null;
}

function appendRaw(trace: ClaudeTrace, type: string, data: Record<string, unknown>): void {
  trace.rawItems.append(boundAuditRawItem(trace.redactor.sanitize({ type, data })));
}

function usageFromResult(result: SDKResultMessage, resumed: boolean): AuditLogUsage {
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
  if (signal.aborted) return Promise.reject(new Error("Canceled"));
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
  return { requestId, provider: "claude", mode: "form", message: "Claude has a question", fields };
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

function buildImagePrompt(prompt: ProviderPromptComposition): Promise<string | AsyncIterable<SDKUserMessage>> {
  if (prompt.imagePaths.length === 0) return Promise.resolve(prompt.inputBodyText);
  return Promise.all(prompt.imagePaths.map(async (imagePath) => {
    const suffix = extname(imagePath).toLowerCase();
    const mime: "image/png" | "image/webp" | "image/jpeg" | "image/gif" = suffix === ".png" ? "image/png"
      : suffix === ".webp" ? "image/webp"
        : suffix === ".gif" ? "image/gif"
          : suffix === ".jpg" || suffix === ".jpeg" ? "image/jpeg"
            : (() => { throw new Error(`Unsupported Claude image type: ${suffix}`); })();
    return { type: "image" as const, source: { type: "base64" as const, media_type: mime, data: (await readFile(imagePath)).toString("base64") } };
  })).then((images) => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: "user" as const,
        parent_tool_use_id: null,
        message: { role: "user" as const, content: [{ type: "text" as const, text: prompt.inputBodyText }, ...images] },
      };
    },
  }));
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

  async getProviderQuotaTelemetry(): Promise<null> { return null; }
  async invalidateSessionThread(): Promise<void> { /* One process per turn; no cached thread. */ }
  async invalidateAllSessionThreads(): Promise<void> { /* One process per turn; no cached thread. */ }
  getBackgroundStructuredPromptPolicy() { return PROVIDER_SCHEMA_BACKGROUND_STRUCTURED_PROMPT_POLICY; }

  private makeTrace(threadId: string | null, redactor = createProviderAgentRuntimeBindingRedactor(null)): ClaudeTrace {
    return { threadId, messages: [], streamingText: "", streamingId: null, steps: new Map(), operations: [], rawItems: new BoundedAuditRawItems(), redactor, usage: null, result: null, errorMessage: "" };
  }

  private receive(message: SDKMessage, trace: ClaudeTrace, resumed = false): void {
    if (message.type === "system" && message.subtype === "init") {
      trace.threadId = message.session_id;
      appendRaw(trace, "session.init", { sessionId: message.session_id, model: message.model });
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
        trace.operations.push({ type: "agent_message", summary: toAuditTextPreview(text, 300) ?? "", details: toAuditTextPreview(text) });
        appendRaw(trace, "assistant.text", { id: message.uuid, text: toAuditTextPreview(text) ?? "" });
      }
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        const command = commandOf(block.name, block.input);
        const summary = command ?? summarizeTool(block.name, block.input);
        trace.steps.set(block.id, { id: block.id, type: command === null ? "tool_call" : "command_execution", summary, status: "in_progress" });
        appendRaw(trace, "tool.use", { id: block.id, name: block.name, summary });
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
          step.status = failed ? "failed" : "completed";
          trace.operations.push({ type: step.type, summary: step.summary, details: failed ? "Tool failed" : "Tool completed" });
        }
        appendRaw(trace, "tool.result", { id: block.tool_use_id, status: failed ? "failed" : "completed" });
      }
      return;
    }
    if (message.type === "result") {
      trace.result = message;
      trace.threadId = message.session_id;
      trace.usage = usageFromResult(message, resumed);
      if (message.subtype !== "success") trace.errorMessage = message.errors.join("\n") || message.subtype;
      else if (message.is_error) trace.errorMessage = message.result;
      appendRaw(trace, "turn.result", { subtype: message.subtype, isError: message.is_error, terminalReason: message.terminal_reason ?? null });
    }
  }

  private result(input: RunSessionTurnInput, prompt: ProviderPromptComposition, trace: ClaudeTrace): RunSessionTurnResult {
    const redactor = createProviderAgentRuntimeBindingRedactor(input.agentRuntimeBinding);
    const text = liveText(trace);
    const operations = redactor.sanitize(trace.operations);
    const transportPayload: AuditTransportPayload = {
      summary: "Claude Agent SDK query",
      fields: [
        { label: "systemPrompt.preset", value: "claude_code" },
        { label: "systemPrompt.append", value: prompt.systemBodyText },
        { label: "prompt", value: prompt.inputBodyText },
        ...(prompt.imagePaths.length > 0 ? [{ label: "images", value: prompt.imagePaths.join("\n") }] : []),
      ],
    };
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
    return {
      threadId: trace.threadId,
      assistantText: redactor.sanitizeText(text),
      lastNonEmptyAssistantMessageText: redactor.sanitizeText(trace.streamingText || trace.messages.at(-1)?.text || text),
      artifact: redactor.sanitize(artifact),
      logicalPrompt: redactor.sanitize(prompt.logicalPrompt),
      transportPayload: redactor.sanitize(transportPayload),
      operations,
      rawItemsJson: trace.rawItems.stringify(),
      usage: trace.usage,
    };
  }

  async runSessionTurn(input: RunSessionTurnInput, onProgress?: RunSessionTurnProgressHandler): Promise<RunSessionTurnResult> {
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
    const progress = () => {
      if (controller.signal.aborted || !onProgress) return;
      const state = {
        sessionId: input.session.id,
        threadId: trace.threadId ?? "",
        assistantText: redactor.sanitizeText(liveText(trace)),
        steps: redactor.sanitize([...trace.steps.values()]),
        backgroundTasks: [],
        usage: trace.usage,
        errorMessage: redactor.sanitizeText(trace.errorMessage),
        approvalRequest: redactor.sanitize(approvalRequest),
        elicitationRequest: redactor.sanitize(elicitationRequest),
      };
      void Promise.resolve(onProgress(state)).catch((error) => this.log?.({ level: "warn", message: "Claude progress callback failed", data: { error: redactor.sanitizeText(String(error)) } }));
    };
    const options: Options = {
      cwd: workspacePath,
      title: input.session.taskTitle || "WithMate session",
      pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
      env: mergeDefinedProviderEnv(process.env, buildProviderAgentRuntimeBindingEnv(input.agentRuntimeBinding)),
      model: selection.resolvedModel,
      effort: selection.resolvedReasoningEffort as Options["effort"],
      permissionMode: "default",
      resume: input.session.threadId || undefined,
      systemPrompt: { type: "preset", preset: "claude_code", append: prompt.systemBodyText, snapshot: false },
      additionalDirectories: prompt.additionalDirectories,
      settingSources: ["user", "project", "local"],
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
          return { hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: input.executionOptions.approvalMode === "on-request" ? "ask" : "deny",
            permissionDecisionReason: input.executionOptions.approvalMode === "on-request" ? "WithMate approval required" : "Tool approval unavailable",
          } };
        }] }],
      },
      canUseTool: async (toolName, toolInput, context) => {
        if (controller.signal.aborted || context.signal.aborted) return { behavior: "deny", message: "Canceled" };
        const requestId = context.toolUseID || `${input.session.id}:${Date.now()}`;
        if (toolName === "AskUserQuestion") {
          if (!input.onElicitationRequest) return { behavior: "deny", message: "Question UI is unavailable" };
          try {
            const answer = await enqueueInteraction(AbortSignal.any([controller.signal, context.signal]), async (signal) => {
              elicitationRequest = redactor.sanitize(claudeQuestionRequest(requestId, toolInput));
              progress();
              try { return await input.onElicitationRequest!(elicitationRequest, signal); }
              finally { elicitationRequest = null; progress(); }
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
        if (input.executionOptions.approvalMode !== "on-request" || !input.onApprovalRequest) {
          return { behavior: "deny", message: "Tool approval is unavailable" };
        }
        try {
          const decision = await enqueueInteraction(AbortSignal.any([controller.signal, context.signal]), async (signal) => {
            approvalRequest = redactor.sanitize({ requestId, provider: "claude", kind: toolName, title: `Allow ${toolName}?`, summary: summarizeTool(toolName, toolInput), decisionMode: "direct-decision" });
            progress();
            try { return await input.onApprovalRequest!(approvalRequest, signal); }
            finally { approvalRequest = null; progress(); }
          });
          return decision === "approve" ? { behavior: "allow" } : { behavior: "deny", message: "Denied by user" };
        } catch { return { behavior: "deny", message: "Canceled" }; }
      },
      onElicitation: async (request, context) => {
        if (!input.onElicitationRequest || controller.signal.aborted) return { action: "decline" };
        const projected = redactor.sanitize(mcpElicitationRequest(context.requestId, request));
        if (!projected) return { action: "decline" };
        try {
          const answer = await enqueueInteraction(AbortSignal.any([controller.signal, context.signal]), async (signal) => {
            elicitationRequest = projected;
            progress();
            try { return await input.onElicitationRequest!(projected, signal); }
            finally { elicitationRequest = null; progress(); }
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
    try {
      const sdkPrompt = await buildImagePrompt(prompt);
      if (controller.signal.aborted) throw new Error("Canceled");
      iterator = this.runQuery({ prompt: sdkPrompt, options });
      while (true) {
        const next = await signalRace(iterator.next(), controller.signal);
        if (next.done) break;
        this.receive(next.value, trace, Boolean(input.session.threadId));
        progress();
        if (trace.result) break;
      }
      if (controller.signal.aborted) throw new Error("Canceled");
      if (!trace.result) throw new Error("Claude stream ended before a result");
      if (trace.result.subtype !== "success" || trace.result.is_error) throw new Error(trace.errorMessage || "Claude turn failed");
      const result = this.result(input, prompt, trace);
      const after = WORKSPACE_DIFF_CAPTURE_ENABLED
        ? await captureWorkspaceSnapshot(snapshotRoots).catch(() => createDisabledWorkspaceSnapshotCapture())
        : createDisabledWorkspaceSnapshotCapture();
      result.artifact = redactor.sanitize(buildArtifactFromOperations({
        session: input.session,
        executionOptions: input.executionOptions,
        operations: result.operations,
        usage: result.usage,
        threadId: result.threadId,
        beforeSnapshot: before.snapshot,
        afterSnapshot: after.snapshot,
        beforeSnapshotStats: before.stats,
        afterSnapshotStats: after.stats,
        providerCatalog: input.providerCatalog,
        selection,
      }));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canceled = controller.signal.aborted || isCanceledProviderMessage(message);
      trace.errorMessage = message;
      throw new ProviderTurnError(redactor.sanitizeText(message), this.result(input, prompt, trace), canceled, providerErrorReason(message, canceled));
    } finally {
      input.signal?.removeEventListener("abort", abort);
      if (iterator) await closeQuery(iterator, controller.signal.aborted || !trace.result);
      controller.abort();
      if (input.signal?.aborted && childExited) await childExited;
    }
  }

  async runBackgroundStructuredPrompt<TOutput = unknown>(input: RunBackgroundStructuredPromptInput): Promise<RunBackgroundStructuredPromptResult<TOutput>> {
    if (input.signal?.aborted) throw new Error("Claude background request was canceled");
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, input.timeoutMs);
    // Managed hooks can run before the first prompt and cannot be disabled by
    // disableAllHooks. Do not enter the background plane when policy sources exist.
    let managedSettingsPresent = true;
    try {
      const resolved = await signalRace(this.inspectSettings({ cwd: input.workspacePath, settingSources: [] }), controller.signal);
      managedSettingsPresent = resolved.sources.some((source) => source.source === "managed");
    } catch {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      throw new Error("Claude background settings could not be verified");
    }
    if (managedSettingsPresent || controller.signal.aborted) {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      throw new Error(managedSettingsPresent ? "Claude background execution is unavailable with managed settings" : "Claude background request was canceled");
    }
    const trace = this.makeTrace(null);
    const options: Options = {
      cwd: input.workspacePath,
      pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
      title: "WithMate background",
      env: mergeDefinedProviderEnv(process.env, {}),
      model: input.model,
      effort: input.reasoningEffort as Options["effort"],
      systemPrompt: { type: "preset", preset: "claude_code", append: input.prompt.systemText, snapshot: false },
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      settings: { disableAllHooks: true },
      persistSession: false,
      outputFormat: { type: "json_schema", schema: input.prompt.outputSchema as Record<string, unknown> },
      abortController: controller,
      canUseTool: async () => ({ behavior: "deny", message: "Background tools are disabled" }),
    };
    let iterator: ReturnType<ClaudeQuery> | null = null;
    try {
      iterator = this.runQuery({ prompt: input.prompt.userText, options });
      while (true) {
        const next = await signalRace(iterator.next(), controller.signal);
        if (next.done) break;
        this.receive(next.value, trace);
        if (trace.result) break;
      }
      if (controller.signal.aborted) throw new Error("Canceled or timed out");
      if (!trace.result || trace.result.subtype !== "success" || trace.result.is_error) throw new Error(trace.errorMessage || "Claude background response failed");
      const rawText = assistantText(trace) || trace.result.result;
      const structuredOutput = trace.result.structured_output;
      if (structuredOutput === undefined || structuredOutput === null) throw new Error("Claude background structured output is missing");
      return { threadId: trace.threadId, rawText, output: structuredOutput as TOutput, structuredOutput, parsedJson: structuredOutput, rawItemsJson: trace.rawItems.stringify(), usage: trace.usage };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      if (iterator) {
        await closeQuery(iterator, controller.signal.aborted || !trace.result);
      }
      controller.abort();
    }
  }

  async extractSessionMemoryDelta(input: ExtractSessionMemoryInput): Promise<ExtractSessionMemoryResult> {
    const result = await this.runBackgroundStructuredPrompt<unknown>({
      providerId: "claude", workspacePath: input.session.workspacePath, appSettings: input.appSettings,
      model: input.model, reasoningEffort: input.reasoningEffort, timeoutMs: input.timeoutMs,
      prompt: { systemText: input.prompt.systemText, userText: input.prompt.userText, outputSchema: input.prompt.outputSchema },
    });
    const structuredText = JSON.stringify(result.structuredOutput);
    return { threadId: result.threadId, rawText: structuredText, delta: parseSessionMemoryDeltaText(structuredText), rawItemsJson: result.rawItemsJson, usage: result.usage };
  }
}
