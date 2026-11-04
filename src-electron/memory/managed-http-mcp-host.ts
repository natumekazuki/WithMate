import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { AgentRuntimeBindingRegistry, ProviderAgentRuntimeBindingProjection } from "../providers/agent-runtime-binding.js";
import type { ProviderAgentRuntimeTurnCoordinator, ProviderAgentRuntimeTurnHandle } from "../providers/provider-agent-runtime-turn-coordinator.js";
import { WITHMATE_MANAGED_MCP_TOKEN_HEADER } from "../providers/managed-http-mcp.js";
import { buildProviderAgentRuntimeBindingEnv } from "../providers/provider-agent-runtime-binding.js";
import { createWithMateMemoryMcpServer } from "../platform/mcp/withmate-memory-mcp.js";
import { createWithMateGlossaryMcpServer } from "../platform/mcp/withmate-glossary-mcp.js";
import { createWithMateSessionGraphMcpServer } from "../platform/mcp/withmate-session-graph-mcp.js";
import { callWithMateMemoryRuntime, type WithMateMemoryRuntimeConnection } from "../platform/mcp/withmate-memory-runtime-client.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES } from "../platform/memory/memory-runtime-exchange.js";
import { backgroundMemoryToolOperations } from "../../src-shared/agent-runtime/background-operations.js";
import { supportsBackgroundRegistration, type BackgroundRegistration } from "../providers/background-registration.js";
import { backgroundOperationFailure, classifyBackgroundFailure, type BackgroundFailure } from "../providers/background-failure.js";

type Endpoint = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  deliveries: Map<RequestId, Promise<void>>;
};

type TurnConnection = {
  token: string;
  binding: ProviderAgentRuntimeBindingProjection;
  handle: ProviderAgentRuntimeTurnHandle;
  abort: AbortController;
  endpoints: Map<string, Endpoint>;
  activeRequests: number;
  initializing: Set<string>;
  removeAbortListener?: () => void;
};

export type SessionHistoryMcpRegistration = {
  toolOperations: Readonly<Record<string, string>>;
  createServer: (deps: {
    env: Record<string, string>;
    connection: WithMateMemoryRuntimeConnection;
    runtimeCall: typeof callWithMateMemoryRuntime;
  }, allowedOperations: readonly string[]) => McpServer;
};

export type ManagedHttpMcpHostOptions = {
  connection: WithMateMemoryRuntimeConnection;
  fallbackAdmissionSecret: string;
  bindingRegistry: Pick<AgentRuntimeBindingRegistry, "resolve" | "resolveIdentity" | "subscribeChanges">;
  turns: Pick<ProviderAgentRuntimeTurnCoordinator, "admit" | "end">;
  sessionHistory?: SessionHistoryMcpRegistration;
  backgroundRegistration?: BackgroundRegistration;
  onBackgroundOperationFailure?: (bindingId: string, failure: BackgroundFailure) => void;
};

function reply(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
}

async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new RangeError("MCP request is too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function responseDelivery(response: ServerResponse): Promise<void> {
  const delivery = new Promise<void>((resolve, reject) => {
    const finish = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("MCP response was not delivered.")); };
    const close = () => response.writableFinished ? finish() : fail();
    const cleanup = () => {
      response.off("finish", finish);
      response.off("error", fail);
      response.off("close", close);
    };
    response.once("finish", finish);
    response.once("error", fail);
    response.once("close", close);
  });
  void delivery.catch(() => undefined);
  return delivery;
}

export class ManagedHttpMcpHost {
  readonly #options: ManagedHttpMcpHostOptions;
  readonly #connections = new Map<string, TurnConnection>();
  readonly #server = createServer((request, response) => {
    void this.#route(request, response).catch(() => reply(response, 500, "MCP request failed."));
  });
  readonly #unsubscribe: () => void;
  #address: AddressInfo | null = null;
  #stopping = false;

  constructor(options: ManagedHttpMcpHostOptions) {
    this.#options = options;
    this.#server.requestTimeout = 10_000;
    this.#server.headersTimeout = 10_000;
    this.#unsubscribe = options.bindingRegistry.subscribeChanges((change) => {
      for (const context of this.#connections.values()) {
        if (change.backgroundBindingId ? context.binding.bindingId === change.backgroundBindingId
          && context.binding.executionGeneration !== change.executionGeneration
          : !context.binding.background && context.handle.actorSessionId === change.actorSessionId
          && context.handle.providerId === change.providerId
          && context.binding.executionGeneration !== change.executionGeneration) {
          this.release(context.handle);
        }
      }
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    this.#address = this.#server.address() as AddressInfo;
  }

  issue(binding: ProviderAgentRuntimeBindingProjection, handle: ProviderAgentRuntimeTurnHandle, signal?: AbortSignal):
    NonNullable<ProviderAgentRuntimeBindingProjection["managedMcp"]> {
    if (!this.#address || this.#stopping) throw new Error("Managed MCP runtime is unavailable.");
    signal?.throwIfAborted();
    if (binding.background && !this.#options.sessionHistory) throw new Error("Session history MCP is not registered.");
    const existing = [...this.#connections.values()].find((context) => context.handle === handle);
    const candidate: TurnConnection = {
      token: randomBytes(32).toString("base64url"),
      binding: Object.freeze({ ...binding,
        memoryRuntimeOwner: binding.memoryRuntimeOwner ? Object.freeze({ ...binding.memoryRuntimeOwner }) : undefined }),
      handle,
      abort: new AbortController(),
      endpoints: new Map(),
      activeRequests: 0,
      initializing: new Set(),
    };
    if (!this.#isCurrent(candidate)) throw new Error("Managed MCP requires the captured active provider turn.");
    const context = existing ?? candidate;
    this.#connections.set(context.token, context);
    if (signal && !context.removeAbortListener) {
      const abort = () => this.release(handle);
      signal.addEventListener("abort", abort, { once: true });
      context.removeAbortListener = () => signal.removeEventListener("abort", abort);
    }
    const baseUrl = `http://127.0.0.1:${this.#address.port}`;
    return { memoryUrl: `${baseUrl}/mcp/memory`, glossaryUrl: `${baseUrl}/mcp/glossary`, sessionGraphUrl: `${baseUrl}/mcp/session-graph`,
      ...(binding.background ? { sessionHistoryUrl: `${baseUrl}/mcp/session-history` } : {}), token: context.token };
  }

  release(handle: ProviderAgentRuntimeTurnHandle): void {
    this.closeConnection(handle);
    this.#options.turns.end(handle);
  }

  /** Native completion closes tool access without ending application-save admission. */
  closeConnection(handle: ProviderAgentRuntimeTurnHandle): void {
    for (const context of this.#connections.values()) {
      if (context.handle !== handle) continue;
      this.#connections.delete(context.token);
      context.removeAbortListener?.();
      context.abort.abort();
      for (const endpoint of context.endpoints.values()) {
        void endpoint.server.close().catch(() => undefined);
      }
      context.endpoints.clear();
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#unsubscribe();
    const servers = [...this.#connections.values()].flatMap((context) => [...context.endpoints.values()]);
    for (const context of this.#connections.values()) this.release(context.handle);
    await Promise.all(servers.map((endpoint) => endpoint.server.close()));
    if (!this.#address) return;
    this.#server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
    this.#address = null;
  }

  #isCurrent(context: TurnConnection): boolean {
    if (this.#stopping || context.abort.signal.aborted) return false;
    const resolved = this.#options.bindingRegistry.resolveIdentity(context.binding.bindingReference);
    const admitted = this.#options.turns.admit({
      actorSessionId: context.handle.actorSessionId,
      providerId: context.handle.providerId,
      turnCapability: context.handle.capability,
      ...(context.binding.background ? { bindingId: context.binding.bindingId } : {}),
    });
    return resolved.ok
      && context.binding.turnCapability === context.handle.capability
      && context.binding.memoryRuntimeOwner?.applicationInstanceId === this.#options.connection.api.applicationInstanceId
      && context.binding.memoryRuntimeOwner?.runtimeGenerationId === this.#options.connection.api.runtimeGenerationId
      && resolved.binding.bindingId === context.binding.bindingId
      && resolved.binding.executionGeneration === context.binding.executionGeneration
      && resolved.binding.actorSessionId === context.handle.actorSessionId
      && resolved.binding.providerId === context.handle.providerId
      && Boolean(resolved.binding.backgroundScope) === Boolean(context.binding.background)
      && admitted.ok && admitted.handle === context.handle;
  }

  #backgroundMemoryOperations(context: TurnConnection): Readonly<Record<string, string>> {
    const resolved = this.#options.bindingRegistry.resolveIdentity(context.binding.bindingReference);
    const scope = resolved.ok ? resolved.binding.backgroundScope : undefined;
    return scope ? backgroundMemoryToolOperations(scope.purpose,
      supportsBackgroundRegistration(this.#options.backgroundRegistration, scope.purpose, scope.history.source.kind)) : {};
  }

  async #createEndpoint(context: TurnConnection, pathname: string): Promise<Endpoint> {
    const deliveries = new Map<RequestId, Promise<void>>();
    const deps = {
      env: buildProviderAgentRuntimeBindingEnv(context.binding),
      connection: this.#options.connection,
      runtimeCall: (connection: WithMateMemoryRuntimeConnection, operation: Parameters<typeof callWithMateMemoryRuntime>[1],
        options: Parameters<typeof callWithMateMemoryRuntime>[2]) => callWithMateMemoryRuntime(connection, operation, {
          ...options, signal: AbortSignal.any([options.signal, context.abort.signal]),
        }),
    };
    const server = pathname === "/mcp/memory"
      ? createWithMateMemoryMcpServer({
          ...deps,
          fallbackAdmissionSecret: this.#options.fallbackAdmissionSecret,
          toolsListDelivery: async (id) => {
            const delivery = deliveries.get(id);
            if (!delivery) throw new Error("MCP tools list delivery is missing.");
            await delivery;
          },
        }, context.binding.background ? Object.entries(this.#backgroundMemoryOperations(context))
          .filter(([, operation]) => this.#options.bindingRegistry.resolve(context.binding.bindingReference, operation).ok)
          .map(([name]) => name) : undefined)
      : pathname === "/mcp/glossary" ? createWithMateGlossaryMcpServer(deps)
      : pathname === "/mcp/session-graph" ? createWithMateSessionGraphMcpServer(deps)
      : this.#options.sessionHistory!.createServer(deps,
        Object.values(this.#options.sessionHistory!.toolOperations).filter((operation) =>
          this.#options.bindingRegistry.resolve(context.binding.bindingReference, operation).ok));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessionclosed: () => {
        if (context.endpoints.get(pathname)?.transport === transport) context.endpoints.delete(pathname);
      },
    });
    if (context.binding.background) {
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        await send(message, options);
        const stage = pathname === "/mcp/session-history" ? "history" : "registration";
        if ("result" in message && typeof message.result === "object" && message.result !== null && message.result.isError === true) {
          const failure = backgroundOperationFailure(message.result.structuredContent, stage)
            ?? classifyBackgroundFailure({ code: "BACKGROUND_OPERATION_FAILED" }, stage);
          this.#options.onBackgroundOperationFailure?.(context.binding.bindingId, failure);
        } else if ("error" in message) {
          this.#options.onBackgroundOperationFailure?.(context.binding.bindingId,
            classifyBackgroundFailure({ code: "BACKGROUND_MCP_INVALID_REQUEST" }, stage));
        }
      };
    }
    await server.connect(transport);
    return { server, transport, deliveries };
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = request.url;
    if (pathname !== "/mcp/memory" && pathname !== "/mcp/glossary" && pathname !== "/mcp/session-graph"
      && pathname !== "/mcp/session-history") {
      reply(response, 404, "Unknown MCP endpoint."); return;
    }
    if (request.socket.remoteAddress !== "127.0.0.1"
      || request.headers.host !== `127.0.0.1:${this.#address?.port}`
      || request.headers.origin !== undefined) {
      reply(response, 403, "MCP requires a local non-browser client."); return;
    }
    const token = request.headers[WITHMATE_MANAGED_MCP_TOKEN_HEADER];
    const context = typeof token === "string" ? this.#connections.get(token) : undefined;
    if (!context || !this.#isCurrent(context)) {
      if (context) this.release(context.handle);
      reply(response, 401, "MCP turn credential is inactive."); return;
    }
    if (context.binding.background ? pathname !== "/mcp/session-history" && pathname !== "/mcp/memory" : pathname === "/mcp/session-history") {
      reply(response, 403, "MCP endpoint is outside this execution scope."); return;
    }
    if (request.method !== "POST" && request.method !== "DELETE") {
      reply(response, 405, "MCP supports POST and DELETE."); return;
    }
    if (context.activeRequests >= 8) { reply(response, 429, "MCP request capacity exceeded."); return; }
    context.activeRequests += 1;
    const delivery = responseDelivery(response);
    let trackedId: RequestId | undefined;
    let endpoint: Endpoint | undefined;
    const timeout = setTimeout(() => {
      reply(response, 504, "MCP request timed out.");
      response.destroy();
    }, 310_000);
    timeout.unref();
    try {
      const body = request.method === "POST" ? await readBody(request,
        pathname !== "/mcp/memory" ? WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES : 256 * 1024) : undefined;
      if (!this.#isCurrent(context)) { reply(response, 401, "MCP turn credential is inactive."); return; }
      if ((pathname === "/mcp/session-history" || pathname === "/mcp/memory" && context.binding.background)
        && body && typeof body === "object" && !Array.isArray(body)) {
        const call = body as { method?: unknown; params?: { name?: unknown } };
        if (call.method === "tools/call") {
          const operation = typeof call.params?.name === "string"
            ? (pathname === "/mcp/session-history" ? this.#options.sessionHistory?.toolOperations
              : this.#backgroundMemoryOperations(context))?.[call.params.name] : undefined;
          if (!operation || !this.#options.bindingRegistry.resolve(context.binding.bindingReference, operation).ok) {
            reply(response, 403, "Background operation is not granted or connected.");
            this.#options.onBackgroundOperationFailure?.(context.binding.bindingId,
              classifyBackgroundFailure({ code: "SESSION_BINDING_FORBIDDEN" }, pathname === "/mcp/session-history" ? "history" : "registration"));
            return;
          }
        }
      }
      endpoint = context.endpoints.get(pathname);
      const sessionId = request.headers["mcp-session-id"];
      if (sessionId !== undefined) {
        if (typeof sessionId !== "string" || !endpoint || endpoint.transport.sessionId !== sessionId) {
          reply(response, 404, "Unknown MCP session."); return;
        }
      } else if (request.method === "POST" && isInitializeRequest(body)) {
        if (context.initializing.has(pathname) || (endpoint && context.activeRequests > 1)) {
          reply(response, 409, "MCP initialization is in progress."); return;
        }
        context.initializing.add(pathname);
        try {
          await endpoint?.server.close();
          endpoint = await this.#createEndpoint(context, pathname);
        } finally {
          context.initializing.delete(pathname);
        }
        if (!this.#isCurrent(context)) {
          await endpoint.server.close();
          reply(response, 401, "MCP turn credential is inactive."); return;
        }
        context.endpoints.set(pathname, endpoint);
      } else { reply(response, 400, "MCP initialization is required."); return; }
      if (body && typeof body === "object" && !Array.isArray(body)
        && (body as { method?: unknown }).method === "tools/list") {
        const id = (body as { id?: unknown }).id;
        if (typeof id === "number" || typeof id === "string") {
          if (endpoint.deliveries.has(id)) { reply(response, 400, "Duplicate MCP request."); return; }
          trackedId = id;
          endpoint.deliveries.set(id, delivery);
        }
      }
      await endpoint.transport.handleRequest(request, response, body);
      await delivery.catch(() => undefined);
    } catch (error) {
      reply(response, error instanceof RangeError ? 413 : error instanceof SyntaxError ? 400 : 500, "MCP request failed.");
    } finally {
      clearTimeout(timeout);
      if (trackedId !== undefined) endpoint?.deliveries.delete(trackedId);
      context.activeRequests -= 1;
    }
  }
}
