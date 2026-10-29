import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenCodeClient, OpenCodeEvent, PermissionRuleset, SessionInfo, SessionMessageInfo } from "@opencode/client";
import { composeProviderPrompt } from "../provider-prompt.js";
import { buildProviderAgentRuntimeBindingEnv, createProviderAgentRuntimeBindingRedactor, mergeDefinedProviderEnv } from "../provider-agent-runtime-binding.js";
import { buildManagedHttpMcpServers } from "../managed-http-mcp.js";
import { resolveDevelopmentProviderBinaryPath, resolvePackagedProviderBinaryPath } from "../provider-binary-paths.js";
import { ProviderTurnError, resolveRunWorkspacePath, type GetProviderQuotaTelemetryInput, type ProviderTurnAdapter, type RunSessionTurnInput, type RunSessionTurnProgressHandler, type RunSessionTurnResult } from "../provider-runtime.js";
import { OpenCodeTransport, type OpenCodeTransportOptions } from "./opencode-transport.js";
import { OPENCODE_VERSION } from "./opencode-environment.js";
import { resolveOpenCodeModelRef, validateOpenCodeModel } from "./opencode-model.js";
import { OpenCodeTurnProjection } from "./opencode-events.js";
import { buildOpenCodeElicitation } from "./opencode-interactions.js";
import { migrateOpenCodeThread, sameOpenCodeOwner } from "./opencode-thread-migration.js";
import type { ListProviderModelsInput } from "../provider-runtime.js";
import type { ModelCatalogProvider } from "../../../src-shared/settings/model-catalog.js";
import type { ProviderQuotaTelemetry } from "../../../src-shared/session/runtime-state.js";

const require = createRequire(import.meta.url);
type Transport = Pick<OpenCodeTransport, "start" | "close" | "whenClosed"> & { readonly secrets?: readonly string[] };
export type OpenCodeAdapterOptions = {
  legacyDatabasePath?: string;
  executable?: string;
  createTransport?: (options: OpenCodeTransportOptions) => Transport;
  log?: (input: { level: "warn" | "error"; kind: string; message: string; data?: unknown }) => void;
};

export function resolveOpenCodeBinaryPath(): string {
  const binary = resolvePackagedProviderBinaryPath("opencode") ?? resolveDevelopmentProviderBinaryPath("opencode", require.resolve);
  if (!binary) throw new Error("OpenCode native executable is unavailable for this platform");
  return binary;
}

export function buildOpenCodePermissions(additionalDirectories: string[]): PermissionRuleset {
  const permissions: PermissionRuleset = [{ action: "opencode_session_move", resource: "*", effect: "deny" }];
  for (const directory of new Set(additionalDirectories)) {
    if (!path.isAbsolute(directory) || /[*?]/.test(directory)) throw new Error(`Invalid OpenCode additional directory: ${directory}`);
    permissions.push({ action: "external_directory", resource: path.join(directory, "*"), effect: "allow" });
  }
  return permissions;
}

const NATIVE_THREAD_PREFIX = "native:";

function abortError(): Error { return new Error("OpenCode turn canceled"); }

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function preflightOpenCodeInbox(client: OpenCodeClient, root: SessionInfo, workspacePath: string, owner: NonNullable<RunSessionTurnInput["runtimeOwner"]>, signal?: AbortSignal): Promise<void> {
  if (root.parentID || path.resolve(root.location.directory) !== path.resolve(workspacePath) || !sameOpenCodeOwner(root.metadata?.withmateOwner, owner)) {
    throw new Error("OpenCode thread owner or workspace does not match this Session");
  }
  const entries = await client.session.inbox.list({ sessionID: root.id }, { signal });
  for (const entry of entries) {
    if (entry.type !== "user" || !sameOpenCodeOwner(entry.payload.metadata?.withmateOwner, owner) || entry.payload.metadata?.withmateRequestID !== entry.id) {
      throw new Error("OpenCode inbox contains an input with unknown ownership");
    }
    await client.session.inbox.cancel({ sessionID: root.id, inboxID: entry.id }, { signal });
  }
  if ((await client.session.inbox.list({ sessionID: root.id }, { signal })).length) throw new Error("OpenCode inbox cancellation was not confirmed");
}

/** Read only the current request's suffix; prior-turn outcomes are never terminal evidence. */
async function readCurrentMessages(client: OpenCodeClient, sessionID: string, requestID: string, signal: AbortSignal): Promise<SessionMessageInfo[]> {
  const suffix: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  const visited = new Set<string>();
  do {
    const page = await client.message.list({ sessionID, order: "desc", limit: 100, ...(cursor ? { cursor } : {}) }, { signal });
    for (const message of page.data) {
      if (message.id === requestID) {
        if (message.type !== "user" || message.metadata?.withmateRequestID !== requestID) throw new Error("OpenCode request attribution mismatch");
        return suffix.reverse();
      }
      suffix.push(message);
    }
    cursor = page.cursor.next ?? undefined;
    if (cursor && visited.has(cursor)) throw new Error("OpenCode messages cursor did not advance");
    if (cursor) visited.add(cursor);
  } while (cursor);
  throw new Error("OpenCode current input has not been delivered");
}

export class OpenCodeAdapter implements ProviderTurnAdapter {
  private readonly active = new Map<string, { controller: AbortController; transports: Transport[] }>();
  private readonly pendingCleanups = new Map<string, { workspace: string; threadId: string; completion: Promise<void> }>();
  constructor(private readonly options: OpenCodeAdapterOptions = {}) {}
  composePrompt(input: RunSessionTurnInput) { return composeProviderPrompt(input); }
  async listModels(input: ListProviderModelsInput): Promise<ModelCatalogProvider> {
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    signal.throwIfAborted();
    this.assertCleanupComplete(input.workspacePath);
    const transport = (this.options.createTransport ?? ((options) => new OpenCodeTransport(options)))({
      executable: this.options.executable, cwd: input.workspacePath,
      env: mergeDefinedProviderEnv(process.env, {}),
    });
    try {
      const client = await transport.start(signal);
      const location = { directory: input.workspacePath };
      const catalog = await client.model.list({ location }, { signal });
      const models = catalog.data.filter((model) => model.enabled).map((model) => ({
        id: `${model.providerID}/${model.id}`, label: model.name, sourceLabel: model.providerID,
        reasoningEfforts: model.variants.map((variant) => variant.id), defaultReasoningEffort: "",
      }));
      const preferred = models.length ? await client.model.default({ location }, { signal }) : null;
      const preferredId = preferred?.data ? `${preferred.data.providerID}/${preferred.data.id}` : "";
      return { id: "opencode", label: "OpenCode", models,
        defaultModelId: models.find((model) => model.id === preferredId)?.id ?? models[0]?.id ?? "", defaultReasoningEffort: "" };
    } catch {
      throw new Error(signal.aborted ? "OpenCode model discovery canceled" : `OpenCode models could not be retrieved. Check the installed OpenCode ${OPENCODE_VERSION} CLI and its standalone provider configuration.`);
    } finally {
      try { await transport.close(); }
      catch {
        const id = randomUUID();
        const completion = transport.whenClosed();
        this.pendingCleanups.set(id, { workspace: path.resolve(input.workspacePath), threadId: "", completion });
        void completion.then(() => this.pendingCleanups.delete(id));
        throw new Error("OpenCode model discovery process cleanup failed");
      }
    }
  }
  async getProviderQuotaTelemetry(input: GetProviderQuotaTelemetryInput): Promise<ProviderQuotaTelemetry | null> {
    const workspace = process.cwd();
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    signal.throwIfAborted();
    this.assertCleanupComplete(workspace);
    const transport = (this.options.createTransport ?? ((options) => new OpenCodeTransport(options)))({
      executable: this.options.executable, cwd: workspace,
      env: mergeDefinedProviderEnv(process.env, {}),
    });
    try {
      const client = await transport.start(signal);
      const response = await client.experimental.usage.limits({ location: { directory: workspace } }, { signal });
      signal.throwIfAborted();
      const go = response.data?.go;
      if (!go) return null;
      const rateLimits = (["rolling", "weekly", "monthly"] as const).map((quotaKey) => {
        const meter = go[quotaKey];
        const reset = new Date(meter.resetsAt);
        if (!Number.isFinite(meter.percent) || meter.percent < 0 || meter.percent > 100 || !Number.isFinite(reset.getTime())) {
          throw new Error("Invalid OpenCode Go allowance");
        }
        return { quotaKey, label: quotaKey === "monthly" ? "Monthly" : quotaKey === "weekly" ? "7d" : "5h",
          usedPercentage: meter.percent, resetDate: reset.toISOString(),
          ...(quotaKey === "monthly" ? {} : { windowDurationMinutes: quotaKey === "weekly" ? 10080 : 300 }) };
      });
      return { provider: "opencode", updatedAt: new Date().toISOString(), snapshots: [], rateLimits, status: "ready" };
    } catch {
      throw new Error(signal.aborted ? "OpenCode Go quota retrieval canceled" : "OpenCode Go quota could not be retrieved");
    } finally {
      try { await transport.close(); }
      catch {
        const id = randomUUID();
        const completion = transport.whenClosed();
        this.pendingCleanups.set(id, { workspace: path.resolve(workspace), threadId: "", completion });
        void completion.then(() => this.pendingCleanups.delete(id));
        throw new Error("OpenCode Go quota process cleanup failed");
      }
    }
  }
  private assertCleanupComplete(workspacePath: string, sessionId?: string, threadId?: string | null): void {
    for (const [ownerId, cleanup] of this.pendingCleanups) {
      if (ownerId === sessionId || cleanup.workspace === path.resolve(workspacePath) || (threadId && cleanup.threadId === threadId)) {
        throw new Error("OpenCode Session, workspace or thread is still terminating");
      }
    }
  }
  async invalidateSessionThread(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    active.controller.abort();
    await Promise.all(active.transports.map((transport) => transport.close()));
  }
  async invalidateAllSessionThreads(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.invalidateSessionThread(id)));
  }

  async runSessionTurn(input: RunSessionTurnInput, onProgress?: RunSessionTurnProgressHandler): Promise<RunSessionTurnResult> {
    if (this.active.has(input.session.id)) throw new Error("OpenCode Session is still running or terminating");
    const workspacePath = resolveRunWorkspacePath(input);
    this.assertCleanupComplete(workspacePath, input.session.id, input.session.threadId);
    if (!input.runtimeOwner?.id || !input.runtimeOwner.incarnationId) throw new Error("OpenCode runtime owner is required");
    if (input.executionOptions.approvalMode !== "on-request" && input.executionOptions.approvalMode !== "never") throw new Error("Unsupported OpenCode approval mode");
    const owner = input.runtimeOwner;
    const prompt = this.composePrompt(input);
    const model = resolveOpenCodeModelRef(input.executionOptions.model, input.executionOptions.reasoningEffort);
    const environment = mergeDefinedProviderEnv(process.env, buildProviderAgentRuntimeBindingEnv(input.agentRuntimeBinding));
    const environmentSecrets = Object.entries(environment).filter(([name]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(name)).map(([, value]) => value);
    let redactor = createProviderAgentRuntimeBindingRedactor(input.agentRuntimeBinding, environmentSecrets);
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    let transport: Transport;
    try {
      transport = (this.options.createTransport ?? ((options) => new OpenCodeTransport(options)))({ executable: this.options.executable, cwd: workspacePath, env: environment });
    } catch (error) {
      input.signal?.removeEventListener("abort", abort);
      throw new ProviderTurnError(redactor.sanitizeText(error instanceof Error ? error.message : String(error)), { threadId: input.session.threadId || null, assistantText: "", usage: null }, controller.signal.aborted, controller.signal.aborted ? "canceled" : "provider_unavailable");
    }
    const transports = [transport];
    this.active.set(input.session.id, { controller, transports });
    const signal = controller.signal;
    const requestID = `msg_${randomUUID()}`;
    const metadata = { withmateOwner: { schema: 1, ...owner }, withmateRequestID: requestID };
    let threadReference = input.session.threadId || "";
    let rootID = threadReference.startsWith(NATIVE_THREAD_PREFIX) ? threadReference.slice(NATIVE_THREAD_PREFIX.length) : threadReference;
    let projection = new OpenCodeTurnProjection(rootID);
    let client: OpenCodeClient | undefined;
    let iterator: AsyncIterator<OpenCodeEvent> | undefined;
    let terminal = false;
    let nativeCanceled = false;
    let dispatched = false;
    let interactionFailure: unknown;
    let interactionTail = Promise.resolve();
    let interactionsClosed = false;
    const interactionControllers = new Map<string, AbortController>();
    const closeInteractions = () => {
      interactionsClosed = true;
      for (const pending of interactionControllers.values()) pending.abort();
    };
    const result = (): RunSessionTurnResult => ({ threadId: threadReference || null, assistantText: redactor.sanitizeText(projection.assistantText), usage: projection.tokenUsage,
      artifact: redactor.sanitize({ title: "OpenCode", activitySummary: [], operationTimeline: [...projection.steps.values()], changedFiles: [], runChecks: [] }) });
    const publish = async () => {
      if (!onProgress) return;
      const steps = redactor.sanitize([...projection.steps.values()]);
      await onProgress({ sessionId: input.session.id, threadId: threadReference, turnId: requestID, assistantText: redactor.sanitizeText(projection.assistantText), reasoningText: redactor.sanitizeText(projection.reasoningText),
        steps, backgroundTasks: [], usage: projection.tokenUsage, errorMessage: "", approvalRequest: null, elicitationRequest: null }, { steps: { upserts: steps, removes: [] }, backgroundTasks: { upserts: [], removes: [] } });
    };
    try {
      client = await transport.start(signal);
      redactor = createProviderAgentRuntimeBindingRedactor(input.agentRuntimeBinding, [...environmentSecrets, ...(transport.secrets ?? [])]);
      const native = client;
      const location = { directory: workspacePath };
      const info = await validateOpenCodeModel(native, model, location, input.attachments, signal);
      for (const attachment of input.attachments) await access(attachment.absolutePath);
      const canonicalDirectories = await Promise.all(prompt.additionalDirectories.map((directory) => realpath(directory)));
      const permissions = buildOpenCodePermissions([...prompt.additionalDirectories, ...canonicalDirectories]);
      let root: SessionInfo;
      if (rootID && !threadReference.startsWith(NATIVE_THREAD_PREFIX)) {
        const databasePath = this.options.legacyDatabasePath;
        if (!databasePath) throw new Error("The existing WithMate OpenCode database is required to continue this conversation.");
        await access(databasePath);
        const legacy = (this.options.createTransport ?? ((options) => new OpenCodeTransport(options)))({
          executable: resolveOpenCodeBinaryPath(), cwd: workspacePath, databasePath, env: mergeDefinedProviderEnv(process.env, {}),
        });
        transports.push(legacy);
        const source = await legacy.start(signal);
        redactor = createProviderAgentRuntimeBindingRedactor(input.agentRuntimeBinding, [...environmentSecrets, ...transports.flatMap((item) => item.secrets ?? [])]);
        await preflightOpenCodeInbox(source, await source.session.get({ sessionID: rootID }, { signal }), workspacePath, owner, signal);
        root = await migrateOpenCodeThread({ source, target: native, rootID, workspacePath, runtimeOwner: owner, signal });
      } else {
        root = rootID ? await native.session.get({ sessionID: rootID }, { signal }) : await native.session.create({ location, metadata: { withmateOwner: metadata.withmateOwner }, model, permissions }, { signal });
      }
      rootID = root.id;
      threadReference = `${NATIVE_THREAD_PREFIX}${rootID}`;
      projection = new OpenCodeTurnProjection(rootID);
      await preflightOpenCodeInbox(native, root, workspacePath, owner, signal);
      await native.session.switchModel({ sessionID: rootID, model }, { signal });
      await native.session.update({ sessionID: rootID, permissions }, { signal });
      const servers = buildManagedHttpMcpServers(input.agentRuntimeBinding);
      if (servers) {
        for (const [name, server] of Object.entries(servers)) await native.mcp.add({ server: name, location, config: { type: "remote", url: server.url, headers: server.headers, oauth: false } }, { signal });
        const deadline = Date.now() + 10_000;
        while (true) {
          const connected = await native.mcp.list({ location }, { signal });
          const statuses = Object.keys(servers).map((name) => connected.data.find((entry) => entry.name === name)?.status.status);
          if (statuses.every((status) => status === "connected")) break;
          if (Date.now() >= deadline || statuses.some((status) => status !== "pending" && status !== "connected")) throw new Error("OpenCode managed MCP connection failed");
          await withSignal(new Promise<void>((resolve) => setTimeout(resolve, 100)), signal);
        }
      }
      iterator = native.event.subscribe({ signal })[Symbol.asyncIterator]();
      const connected = await withSignal(iterator.next(), signal);
      if (connected.done || connected.value.type !== "server.connected") throw new Error("OpenCode event stream did not establish a connection");
      const owned = new Set([rootID]);
      const belongs = async (sessionID: string): Promise<boolean> => {
        const visited = new Set<string>();
        let current = sessionID;
        while (current && visited.size < 32 && !visited.has(current)) {
          if (owned.has(current)) { owned.add(sessionID); return true; }
          visited.add(current);
          let child: SessionInfo;
          try { child = await native.session.get({ sessionID: current }, { signal }); }
          catch { return false; }
          if (path.resolve(child.location.directory) !== path.resolve(workspacePath)) return false;
          current = child.parentID ?? "";
        }
        return false;
      };
      const enqueue = (id: string, action: (signal: AbortSignal) => Promise<void>) => {
        if (interactionControllers.has(id)) return;
        const pending = new AbortController();
        const abortPending = () => pending.abort();
        signal.addEventListener("abort", abortPending, { once: true });
        interactionControllers.set(id, pending);
        interactionTail = interactionTail.then(async () => {
          if (!pending.signal.aborted && !interactionsClosed) await action(pending.signal);
        }).catch((error: unknown) => { if (!pending.signal.aborted && !interactionsClosed) { interactionFailure = error; controller.abort(); } }).finally(() => {
          signal.removeEventListener("abort", abortPending); interactionControllers.delete(id);
        });
      };
      dispatched = true;
      // Prompt admission is intentionally not used as the completion result.
      const admission = native.session.prompt({ sessionID: rootID, id: requestID, text: prompt.logicalPrompt.composedText,
        metadata, files: input.attachments.map((attachment) => ({ uri: pathToFileURL(attachment.absolutePath).href, name: path.basename(attachment.absolutePath) })), resume: true }, { signal });
      void admission.catch(() => undefined);
      const admitted = await withSignal(admission, signal);
      if (admitted.id !== requestID || admitted.sessionID !== rootID) throw new Error("OpenCode prompt admission identity does not match this request");
      let delivered = false;
      while (!terminal) {
        const next = await withSignal(iterator.next(), signal);
        if (next.done) throw new Error("OpenCode event stream disconnected before root completion");
        const event = next.value;
        if (event.type === "permission.replied") interactionControllers.get(`permission:${event.data.requestID}`)?.abort();
        if (event.type === "form.replied" || event.type === "form.cancelled") interactionControllers.get(`form:${event.data.id}`)?.abort();
        if (event.type === "permission.asked") {
          const request = event.data;
          if (!await belongs(request.sessionID)) {
            await native.permission.reply({ sessionID: request.sessionID, requestID: request.id, decision: "reject" }, { signal });
            throw new Error("OpenCode permission request ownership is unknown");
          }
          enqueue(`permission:${request.id}`, async (pendingSignal) => {
            const decision = request.action === "opencode_session_move" ? "deny" : input.executionOptions.approvalMode === "never" ? "approve" : await withSignal(Promise.resolve(input.onApprovalRequest?.(redactor.sanitize({ requestId: randomUUID(), provider: "opencode", kind: request.action, title: "OpenCode permission", summary: request.message ?? request.resources.join("\n"), details: JSON.stringify(request.metadata), decisionMode: "direct-decision" }), pendingSignal) ?? "deny"), pendingSignal);
            if (!pendingSignal.aborted && !interactionsClosed) await native.permission.reply({ sessionID: request.sessionID, requestID: request.id, decision: decision === "approve" ? "once" : "reject" }, { signal: pendingSignal });
          });
          continue;
        }
        if (event.type === "form.created") {
          const form = event.data.form;
          if (!await belongs(form.sessionID)) {
            await native.session.form.cancel({ sessionID: form.sessionID, formID: form.id }, { signal });
            throw new Error("OpenCode form ownership is unknown");
          }
          let request;
          try { request = redactor.sanitize(buildOpenCodeElicitation(form, randomUUID())); }
          catch (error) { await native.session.form.cancel({ sessionID: form.sessionID, formID: form.id }, { signal }); throw error; }
          enqueue(`form:${form.id}`, async (pendingSignal) => {
            const response = await withSignal(Promise.resolve(input.onElicitationRequest?.(request, pendingSignal) ?? { action: "cancel" as const }), pendingSignal);
            if (pendingSignal.aborted || interactionsClosed) return;
            if (response.action === "accept") await native.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer: response.content ?? {} }, { signal: pendingSignal });
            else await native.session.form.cancel({ sessionID: form.sessionID, formID: form.id }, { signal: pendingSignal });
          });
          continue;
        }
        if (!("sessionID" in event.data) || !await belongs(event.data.sessionID)) continue;
        if (event.type === "session.inbox.delivered" && event.data.sessionID === rootID && event.data.inboxID === requestID) delivered = true;
        if (delivered) { projection.apply(event); await publish(); }
        if (event.data.sessionID !== rootID || !delivered) continue;
        if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
          // The root turn has ended; late answers must not reach native while the final snapshot is read.
          closeInteractions();
          const messages = await readCurrentMessages(native, rootID, requestID, signal);
          projection.replaceMessages(messages);
          const idle = [...messages].reverse().find((message) => message.type === "idle");
          if (!idle || idle.type !== "idle") throw new Error("OpenCode root completion has no matching idle outcome");
          nativeCanceled = idle.outcome === "interrupted";
          if (idle.outcome !== "succeeded" || event.type !== "session.execution.succeeded") throw new Error(`OpenCode root ${idle.outcome}: ${JSON.stringify(idle.error ?? ("error" in event.data ? event.data.error : ""))}`);
          terminal = true;
          const lastResponse = [...messages].reverse().find((message) => message.type === "assistant" && message.tokens);
          if (info.limit.context > 0 && lastResponse?.type === "assistant" && lastResponse.tokens) await input.onSessionContextTelemetry?.({ provider: "opencode", sessionId: input.session.id, updatedAt: new Date().toISOString(), tokenLimit: info.limit.context,
            currentTokens: lastResponse.tokens.input + lastResponse.tokens.cache.read + lastResponse.tokens.cache.write + lastResponse.tokens.output + lastResponse.tokens.reasoning, messagesLength: messages.length });
        }
      }
      await publish();
      return result();
    } catch (error) {
      redactor = createProviderAgentRuntimeBindingRedactor(input.agentRuntimeBinding, [...environmentSecrets, ...transports.flatMap((item) => item.secrets ?? [])]);
      if (client && rootID && dispatched) {
        const cleanupController = new AbortController();
        const timer = setTimeout(() => cleanupController.abort(), 2_000);
        try {
          const inbox = await client.session.inbox.list({ sessionID: rootID }, { signal: cleanupController.signal });
          if (inbox.some((entry) => entry.id === requestID && entry.type === "user" && sameOpenCodeOwner(entry.payload.metadata?.withmateOwner, owner) && entry.payload.metadata?.withmateRequestID === requestID)) {
            await client.session.inbox.cancel({ sessionID: rootID, inboxID: requestID }, { signal: cleanupController.signal });
          }
          await client.session.interrupt({ sessionID: rootID, resume: false }, { signal: cleanupController.signal });
        } catch { /* Next-run preflight must verify any remaining inbox item. */ }
        finally { clearTimeout(timer); }
      }
      const failure = interactionFailure ?? error;
      const detail = redactor.sanitizeText(failure instanceof Error ? failure.message : String(failure));
      const message = /auth|unauthori[sz]ed|api.?key|credential/i.test(detail)
        ? `${detail}\nConfigure the provider in OpenCode with opencode auth login --standalone, then retry in WithMate.` : detail;
      const canceled = nativeCanceled || signal.aborted && !interactionFailure;
      const reason = canceled ? "canceled" : /auth|unauthori[sz]ed|api.?key|credential/i.test(message) ? "auth" : /quota|rate.?limit|usage.?limit|insufficient/i.test(message) ? "usage_limit" : /unavailable|model|variant|executable|version/i.test(message) ? "provider_unavailable" : /network|disconnect|fetch|ECONN/i.test(message) ? "network" : "unknown";
      throw new ProviderTurnError(message, result(), canceled, reason);
    } finally {
      closeInteractions();
      controller.abort();
      input.signal?.removeEventListener("abort", abort);
      void iterator?.return?.().catch(() => undefined);
      await interactionTail;
      try { await Promise.all(transports.map((item) => item.close())); this.active.delete(input.session.id); }
      catch (error) {
        this.options.log?.({ level: "warn", kind: "opencode.cleanup", message: redactor.sanitizeText(error instanceof Error ? error.message : String(error)) });
        const completion = Promise.all(transports.map((item) => item.whenClosed())).then(() => {
          if (this.active.get(input.session.id)?.transports === transports) this.active.delete(input.session.id);
          if (this.pendingCleanups.get(input.session.id)?.completion === completion) this.pendingCleanups.delete(input.session.id);
        });
        this.pendingCleanups.set(input.session.id, { workspace: path.resolve(workspacePath), threadId: threadReference, completion });
        input.onCleanupPending?.(completion);
      }
    }
  }
}
