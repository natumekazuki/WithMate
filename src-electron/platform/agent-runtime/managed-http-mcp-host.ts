import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  AgentRuntimeBindingRegistry,
  ProviderAgentRuntimeBindingProjection,
} from "../../providers/agent-runtime-binding.js";
import type {
  ProviderAgentRuntimeTurnCoordinator,
  ProviderAgentRuntimeTurnHandle,
} from "../../providers/provider-agent-runtime-turn-coordinator.js";
import { WITHMATE_MANAGED_MCP_TOKEN_HEADER } from "../../providers/managed-http-mcp.js";
import { buildProviderAgentRuntimeBindingEnv } from "../../providers/provider-agent-runtime-binding.js";
import { createWithMateGlossaryMcpServer } from "../mcp/withmate-glossary-mcp.js";
import { createWithMateSessionMcpServer } from "../mcp/withmate-session-mcp.js";
import {
  callAgentRuntime,
  type AgentRuntimeConnection,
} from "./runtime-client.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES } from "./runtime-exchange.js";

/** 一つの MCP セッションのサーバーと HTTP トランスポート、および要求 ID ごとの応答送信待ち。 */
type Endpoint = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  deliveries: Map<RequestId, Promise<void>>;
};

/** プロバイダーの一回のターンに束縛した認証情報、MCP セッション、受付状態。 */
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

/** 管理 MCP を開くランタイム接続と、束縛・ターンの有効性を確認するための依存。 */
export type ManagedHttpMcpHostOptions = {
  connection: AgentRuntimeConnection;
  bindingRegistry: Pick<
    AgentRuntimeBindingRegistry,
    "resolve" | "resolveIdentity" | "subscribeChanges"
  >;
  turns: Pick<ProviderAgentRuntimeTurnCoordinator, "admit" | "end">;
};

/** 送信前の応答に JSON-RPC のエラーを返す。送信済みまたは切断済みなら何もしない。 */
function reply(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message },
    }),
  );
}

/** 受信バイト数の上限を強制し、UTF-8 の要求本文を JSON として読み込む。 */
async function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
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

/** HTTP 応答の送信完了を待つ。送信を終える前にエラーや切断が起きた場合は失敗とする。 */
function responseDelivery(response: ServerResponse): Promise<void> {
  /** 応答の完了・エラー・切断を、一度だけ決着する送信結果として扱う。 */
  const delivery = new Promise<void>((resolve, reject) => {
    /** イベントの購読を解除し、応答の送信完了を通知する。 */
    const finish = () => {
      cleanup();
      resolve();
    };
    /** イベントの購読を解除し、応答を送信できなかったことを通知する。 */
    const fail = () => {
      cleanup();
      reject(new Error("MCP response was not delivered."));
    };
    /** 接続終了時に、応答の送信まで完了したかどうかを区別する。 */
    const close = () => (response.writableFinished ? finish() : fail());
    /** 結果が確定した応答から送信監視のイベントリスナーを外す。 */
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

/** ローカル HTTP 上で用語集と Session の MCP を提供し、利用権限を有効なプロバイダーターンに限定する。 */
export class ManagedHttpMcpHost {
  readonly #options: ManagedHttpMcpHostOptions;
  readonly #connections = new Map<string, TurnConnection>();
  readonly #server = createServer((request, response) => {
    void this.#route(request, response).catch(() =>
      reply(response, 500, "MCP request failed."),
    );
  });
  readonly #unsubscribe: () => void;
  #address: AddressInfo | null = null;
  #stopping = false;

  /** HTTP の受付上限時間を設定し、束縛世代の変更で対応するターンの接続を失効させる。 */
  constructor(options: ManagedHttpMcpHostOptions) {
    this.#options = options;
    this.#server.requestTimeout = 10_000;
    this.#server.headersTimeout = 10_000;
    this.#unsubscribe = options.bindingRegistry.subscribeChanges((change) => {
      for (const context of this.#connections.values()) {
        if (
          context.handle.actorSessionId === change.actorSessionId &&
          context.handle.providerId === change.providerId &&
          context.binding.executionGeneration !== change.executionGeneration
        ) {
          this.release(context.handle);
        }
      }
    });
  }

  /** ループバックの空きポートで待ち受け、接続情報を発行できるようにする。 */
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

  /** 有効なターンに固定した二つの MCP URL とトークンを返す。同じターンで再発行すると既存の接続を使う。 */
  issue(
    binding: ProviderAgentRuntimeBindingProjection,
    handle: ProviderAgentRuntimeTurnHandle,
    signal?: AbortSignal,
  ): NonNullable<ProviderAgentRuntimeBindingProjection["managedMcp"]> {
    if (!this.#address || this.#stopping)
      throw new Error("Managed MCP runtime is unavailable.");
    signal?.throwIfAborted();
    const existing = [...this.#connections.values()].find(
      (context) => context.handle === handle,
    );
    const candidate: TurnConnection = {
      token: randomBytes(32).toString("base64url"),
      binding: Object.freeze({
        ...binding,
        runtimeOwner: binding.runtimeOwner
          ? Object.freeze({ ...binding.runtimeOwner })
          : undefined,
      }),
      handle,
      abort: new AbortController(),
      endpoints: new Map(),
      activeRequests: 0,
      initializing: new Set(),
    };
    if (!this.#isCurrent(candidate))
      throw new Error(
        "Managed MCP requires the captured active provider turn.",
      );
    const context = existing ?? candidate;
    this.#connections.set(context.token, context);
    if (signal && !context.removeAbortListener) {
      /** 呼び出し元の中断と同時に、このターンの接続および受付を終了する。 */
      const abort = () => this.release(handle);
      signal.addEventListener("abort", abort, { once: true });
      context.removeAbortListener = () =>
        signal.removeEventListener("abort", abort);
    }
    const baseUrl = `http://127.0.0.1:${this.#address.port}`;
    return {
      glossaryUrl: `${baseUrl}/mcp/glossary`,
      sessionUrl: `${baseUrl}/mcp/session`,
      token: context.token,
    };
  }

  /** ターンの MCP 接続を閉じ、アプリケーション側のターン受付も終了する。 */
  release(handle: ProviderAgentRuntimeTurnHandle): void {
    this.closeConnection(handle);
    this.#options.turns.end(handle);
  }

  /** ネイティブ側の処理が完了したらツールへのアクセスを閉じるが、アプリケーションによる保存の受付は終了しない。 */
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

  /** 新規受付を止め、束縛の監視を解除し、保持している MCP セッションと HTTP 接続を閉じる。 */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#unsubscribe();
    const servers = [...this.#connections.values()].flatMap((context) => [
      ...context.endpoints.values(),
    ]);
    for (const context of this.#connections.values())
      this.release(context.handle);
    await Promise.all(servers.map((endpoint) => endpoint.server.close()));
    if (!this.#address) return;
    this.#server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
    this.#address = null;
  }

  /** トークンに紐付く束縛が現在の所有者・実行世代・有効なターンと一致するか確かめる。 */
  #isCurrent(context: TurnConnection): boolean {
    if (this.#stopping || context.abort.signal.aborted) return false;
    const resolved = this.#options.bindingRegistry.resolveIdentity(
      context.binding.bindingReference,
    );
    const admitted = this.#options.turns.admit({
      actorSessionId: context.handle.actorSessionId,
      providerId: context.handle.providerId,
      turnCapability: context.handle.capability,
    });
    return (
      resolved.ok &&
      context.binding.turnCapability === context.handle.capability &&
      context.binding.runtimeOwner?.applicationInstanceId ===
        this.#options.connection.api.applicationInstanceId &&
      context.binding.runtimeOwner?.runtimeGenerationId ===
        this.#options.connection.api.runtimeGenerationId &&
      resolved.binding.bindingId === context.binding.bindingId &&
      resolved.binding.executionGeneration ===
        context.binding.executionGeneration &&
      resolved.binding.actorSessionId === context.handle.actorSessionId &&
      resolved.binding.providerId === context.handle.providerId &&
      admitted.ok &&
      admitted.handle === context.handle
    );
  }

  /** ターンの束縛を使う用語集または Session 用の MCP サーバーを作り、独立した HTTP セッションに接続する。 */
  async #createEndpoint(
    context: TurnConnection,
    pathname: string,
  ): Promise<Endpoint> {
    const deliveries = new Map<RequestId, Promise<void>>();
    const deps = {
      env: buildProviderAgentRuntimeBindingEnv(context.binding),
      connection: this.#options.connection,
      /** 個別操作の中断とターン終了のいずれも、ランタイム API への要求に伝える。 */
      runtimeCall: (
        connection: AgentRuntimeConnection,
        operation: Parameters<typeof callAgentRuntime>[1],
        options: Parameters<typeof callAgentRuntime>[2],
      ) =>
        callAgentRuntime(connection, operation, {
          ...options,
          signal: AbortSignal.any([options.signal, context.abort.signal]),
        }),
    };
    const server =
      pathname === "/mcp/glossary"
        ? createWithMateGlossaryMcpServer(deps)
        : createWithMateSessionMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      /** 終了した HTTP セッションがまだ現在の登録である場合に限り、登録から外す。 */
      onsessionclosed: () => {
        if (context.endpoints.get(pathname)?.transport === transport)
          context.endpoints.delete(pathname);
      },
    });
    await server.connect(transport);
    return { server, transport, deliveries };
  }

  /** ローカル要求のトークンと MCP セッションを照合し、初期化や操作を対応する HTTP トランスポートへ渡す。 */
  async #route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pathname = request.url;
    if (pathname !== "/mcp/glossary" && pathname !== "/mcp/session") {
      reply(response, 404, "Unknown MCP endpoint.");
      return;
    }
    if (
      request.socket.remoteAddress !== "127.0.0.1" ||
      request.headers.host !== `127.0.0.1:${this.#address?.port}` ||
      request.headers.origin !== undefined
    ) {
      reply(response, 403, "MCP requires a local non-browser client.");
      return;
    }
    const token = request.headers[WITHMATE_MANAGED_MCP_TOKEN_HEADER];
    const context =
      typeof token === "string" ? this.#connections.get(token) : undefined;
    if (!context || !this.#isCurrent(context)) {
      if (context) this.release(context.handle);
      reply(response, 401, "MCP turn credential is inactive.");
      return;
    }
    if (request.method !== "POST" && request.method !== "DELETE") {
      reply(response, 405, "MCP supports POST and DELETE.");
      return;
    }
    if (context.activeRequests >= 8) {
      reply(response, 429, "MCP request capacity exceeded.");
      return;
    }
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
      const body =
        request.method === "POST"
          ? await readBody(
              request,
              WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES,
            )
          : undefined;
      if (!this.#isCurrent(context)) {
        reply(response, 401, "MCP turn credential is inactive.");
        return;
      }
      endpoint = context.endpoints.get(pathname);
      const sessionId = request.headers["mcp-session-id"];
      if (sessionId !== undefined) {
        if (
          typeof sessionId !== "string" ||
          !endpoint ||
          endpoint.transport.sessionId !== sessionId
        ) {
          reply(response, 404, "Unknown MCP session.");
          return;
        }
      } else if (request.method === "POST" && isInitializeRequest(body)) {
        if (
          context.initializing.has(pathname) ||
          (endpoint && context.activeRequests > 1)
        ) {
          reply(response, 409, "MCP initialization is in progress.");
          return;
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
          reply(response, 401, "MCP turn credential is inactive.");
          return;
        }
        context.endpoints.set(pathname, endpoint);
      } else {
        reply(response, 400, "MCP initialization is required.");
        return;
      }
      if (
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        (body as { method?: unknown }).method === "tools/list"
      ) {
        const id = (body as { id?: unknown }).id;
        if (typeof id === "number" || typeof id === "string") {
          if (endpoint.deliveries.has(id)) {
            reply(response, 400, "Duplicate MCP request.");
            return;
          }
          trackedId = id;
          endpoint.deliveries.set(id, delivery);
        }
      }
      await endpoint.transport.handleRequest(request, response, body);
      await delivery.catch(() => undefined);
    } catch (error) {
      reply(
        response,
        error instanceof RangeError
          ? 413
          : error instanceof SyntaxError
            ? 400
            : 500,
        "MCP request failed.",
      );
    } finally {
      clearTimeout(timeout);
      if (trackedId !== undefined) endpoint?.deliveries.delete(trackedId);
      context.activeRequests -= 1;
    }
  }
}
