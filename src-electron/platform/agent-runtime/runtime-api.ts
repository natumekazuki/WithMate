import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import path from "node:path";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type {
  RuntimeBuildChannel,
  RuntimeDiscoveryClock,
  RuntimeDiscoveryTimers,
} from "../runtime-discovery/runtime-discovery-contract.js";
import {
  publishRuntimeDiscoveryEntry,
  readRuntimeDiscoveryCredential,
  type RuntimeDiscoveryRegistryPublication,
  type RuntimePathSecurity,
} from "../runtime-discovery/runtime-discovery-registry.js";
import { secureWindowsRuntimePath } from "../runtime-path-security.js";
import type { AgentRuntimeBindingRegistry } from "../../providers/agent-runtime-binding.js";
import type { ProviderAgentRuntimeTurnCoordinator } from "../../providers/provider-agent-runtime-turn-coordinator.js";
import { ManagedHttpMcpHost } from "./managed-http-mcp-host.js";
import {
  AGENT_RUNTIME_KIND,
  AGENT_RUNTIME_DISCOVERY_SCHEMA_VERSION,
  verifyRuntimeIdentity,
  normalizeAgentRuntimeApiBaseUrl,
  type AgentRuntimeConnection,
} from "./runtime-client.js";
import {
  createAgentRuntimeChallenge,
  createAgentRuntimeOwnerChallenge,
  WITHMATE_AGENT_RUNTIME_NONCE_HEADER,
  WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER,
  WITHMATE_AGENT_RUNTIME_GENERATION_HEADER,
  WITHMATE_AGENT_RUNTIME_CHALLENGE_HEADER,
  WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
  WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES,
  WITHMATE_AGENT_RUNTIME_EXCHANGE_SCHEMA_VERSION,
} from "./runtime-exchange.js";

/** 通信エンベロープから取り出してアプリケーションのルーターへ渡す操作と、呼び出し元の束縛情報。 */
export type AgentRuntimeExtensionRequest = {
  method: "GET" | "POST";
  path: string;
  body: unknown;
  transport: "cli" | "mcp";
  bindingReference?: string;
  turnCapability?: string;
};
/** 拡張操作のルーターが決定した HTTP ステータスと JSON 応答値。 */
export type AgentRuntimeExtensionResponse = { status: number; value: unknown };
/** ランタイム操作の主体となるセッションの識別情報と、任意の作業ディレクトリ情報。 */
export type AgentRuntimeActorSession = {
  id: string;
  providerId: string;
  characterId?: string;
  sessionKind?: string;
  workspacePath?: string;
  allowedAdditionalDirectories?: string[];
};
/** 起動済みのランタイム API の接続先と所有者の識別情報、および管理 MCP の停止制御を保持する。 */
export type AgentRuntimeApiHandle = {
  baseUrl: string;
  applicationInstanceId: string;
  runtimeGenerationId: string;
  managedMcp: ManagedHttpMcpHost;
  /** 管理 MCP と API の受付を停止し、この起動で公開したレジストリ登録を撤回する。 */
  stop(): Promise<void>;
};
/** API の所有者、検出レジストリ、受付上限、および操作の委譲先を指定する起動設定。 */
export type StartAgentRuntimeApiOptions = {
  applicationInstanceId: string;
  buildChannel: RuntimeBuildChannel;
  processStartedAt?: string;
  registryDirectoryPath?: string;
  runtimePathSecurity?: RuntimePathSecurity;
  maxBodyBytes?: number;
  maxConcurrentRequests?: number;
  clock?: RuntimeDiscoveryClock;
  timers?: RuntimeDiscoveryTimers;
  agentRuntimeBindingRegistry: AgentRuntimeBindingRegistry;
  providerAgentRuntimeTurns: ProviderAgentRuntimeTurnCoordinator;
  /** 認証済みの拡張操作を処理する。対応する操作がなければ null を返す。 */
  routeAgentRuntimeExtension(
    request: AgentRuntimeExtensionRequest,
  ):
    | Promise<AgentRuntimeExtensionResponse | null>
    | AgentRuntimeExtensionResponse
    | null;
};

const payloadSchema = z
  .object({
    schemaVersion: z.literal(WITHMATE_AGENT_RUNTIME_EXCHANGE_SCHEMA_VERSION),
    apiSecret: z.string(),
    adapter: z.enum(["cli", "mcp"]),
    adapterSecret: z.string(),
    bindingReference: z.string().optional(),
    turnCapability: z.string().optional(),
    operation: z
      .object({
        method: z.enum(["GET", "POST"]),
        path: z.string().startsWith("/v1/"),
        body: z.unknown(),
      })
      .strict(),
  })
  .strict();
/** バイト数が等しい秘密値同士を、比較の実行時間が一致箇所に依存しない方法で照合する。 */
function equalSecret(value: string, secret: string): boolean {
  const actual = Buffer.from(value);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
/** 応答を送信できる場合に限り、指定されたステータスで JSON を返す。 */
function reply(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
/** 受信した実バイト数で上限を検査した後、UTF-8 の要求本文を JSON として読み込む。 */
async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length;
    if (bytes > maxBytes) throw new RangeError("Runtime request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/** 登録ファイルのパスを所有者専用にする。Windows では ACL、その他では種別と所有者の検査後にパーミッションを設定する。 */
const secureRuntimePath: RuntimePathSecurity = async (target, kind) => {
  if (process.platform === "win32") {
    await secureWindowsRuntimePath(target, kind);
    return;
  }
  const info = await lstat(target);
  if (
    info.isSymbolicLink() ||
    (kind === "directory" ? !info.isDirectory() : !info.isFile()) ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    throw new Error("Runtime path owner or type is invalid.");
  await chmod(target, kind === "directory" ? 0o700 : 0o600);
};

/** 共通ツールランタイムは通信と検出だけを担う。アプリケーションのストレージは開かない。 */
export async function startAgentRuntimeApi(
  options: StartAgentRuntimeApiOptions,
): Promise<AgentRuntimeApiHandle> {
  const runtimeGenerationId = randomUUID();
  const apiSecret = randomBytes(32).toString("base64url");
  const secrets = {
    cli: randomBytes(32).toString("base64url"),
    mcp: randomBytes(32).toString("base64url"),
  };
  let address: AddressInfo | null = null;
  let stopping = false;
  let activeRequests = 0;
  let largeRequests = 0;
  let publication: RuntimeDiscoveryRegistryPublication | undefined;
  let managedMcp: ManagedHttpMcpHost | undefined;
  /** ループバック用の HTTP サーバー。要求単位で取得した受付枠を、成功・失敗にかかわらず解放する。 */
  const server = createServer((request, response) => {
    let smallAdmitted = false;
    let largeAdmitted = false;
    let dispatched = false;
    /** ローカル接続を検証し、状態確認または拡張操作を処理する。拡張操作は所有者の確認と認証を経てルーターへ渡す。 */
    const route = async () => {
      /** 操作の委譲前に拒否した要求に、永続効果がないことを付けて返す。 */
      const error = (status: number, code: string) =>
        reply(response, status, { ok: false, code, effect: "none" });
      if (stopping) return error(503, "RUNTIME_UNAVAILABLE");
      if (
        request.socket.remoteAddress !== "127.0.0.1" ||
        request.headers.host !== `127.0.0.1:${address?.port}` ||
        request.headers.origin !== undefined
      )
        return error(403, "RUNTIME_FORBIDDEN");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/status") {
        const nonce = url.searchParams.get("nonce");
        if (!nonce || nonce.length > 256)
          return error(400, "RUNTIME_INVALID_REQUEST");
        return reply(response, 200, {
          applicationInstanceId: options.applicationInstanceId,
          runtimeGenerationId,
          challenge: {
            nonce,
            ownerHmacSha256: createAgentRuntimeOwnerChallenge(
              apiSecret,
              options.applicationInstanceId,
              runtimeGenerationId,
              nonce,
            ),
          },
        });
      }
      if (url.pathname !== WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH)
        return error(404, "RUNTIME_ROUTE_NOT_FOUND");
      if (
        request.method !== "POST" ||
        request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
          "application/json"
      )
        return error(405, "RUNTIME_INVALID_REQUEST");
      const nonce = request.headers[WITHMATE_AGENT_RUNTIME_NONCE_HEADER];
      if (
        typeof nonce !== "string" ||
        !nonce ||
        nonce.length > 256 ||
        request.headers[WITHMATE_AGENT_RUNTIME_GENERATION_HEADER] !==
          runtimeGenerationId ||
        request.headers[WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER] !==
          options.applicationInstanceId
      )
        return error(401, "RUNTIME_UNAUTHORIZED");
      const length = request.headers["content-length"];
      const small =
        typeof length === "string" &&
        /^\d+$/.test(length) &&
        Number.isSafeInteger(Number(length)) &&
        Number(length) <= (options.maxBodyBytes ?? 256 * 1024);
      if (small) {
        if (activeRequests >= (options.maxConcurrentRequests ?? 8))
          return error(429, "RUNTIME_BUSY");
        activeRequests++;
        smallAdmitted = true;
      } else {
        if (largeRequests >= 1) return error(429, "RUNTIME_BUSY");
        largeRequests++;
        largeAdmitted = true;
      }
      request.setTimeout(310_000);
      response.setTimeout(310_000);
      response.writeEarlyHints({
        link: `<${WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH}>; rel=preconnect`,
        [WITHMATE_AGENT_RUNTIME_GENERATION_HEADER]: runtimeGenerationId,
        [WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER]:
          options.applicationInstanceId,
        [WITHMATE_AGENT_RUNTIME_CHALLENGE_HEADER]: createAgentRuntimeChallenge(
          apiSecret,
          runtimeGenerationId,
          nonce,
        ),
      });
      const parsed = payloadSchema.safeParse(
        await readBody(
          request,
          small
            ? (options.maxBodyBytes ?? 256 * 1024)
            : WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES,
        ),
      );
      if (!parsed.success) return error(400, "RUNTIME_INVALID_REQUEST");
      const payload = parsed.data;
      if (
        !equalSecret(payload.apiSecret, apiSecret) ||
        !equalSecret(payload.adapterSecret, secrets[payload.adapter])
      )
        return error(401, "RUNTIME_UNAUTHORIZED");
      // 用語集は本文のサイズにかかわらず、一回のディスパッチを許可する。
      if (
        !largeAdmitted &&
        payload.operation.path.startsWith("/v1/glossary/")
      ) {
        if (largeRequests >= 1) return error(429, "RUNTIME_BUSY");
        largeRequests++;
        largeAdmitted = true;
      }
      dispatched = true;
      const result = await options.routeAgentRuntimeExtension({
        ...payload.operation,
        transport: payload.adapter,
        bindingReference: payload.bindingReference,
        turnCapability: payload.turnCapability,
      });
      if (!result) return error(404, "RUNTIME_ROUTE_NOT_FOUND");
      reply(response, result.status, result.value);
    };
    void route()
      .catch((cause) =>
        reply(
          response,
          cause instanceof RangeError
            ? 413
            : cause instanceof SyntaxError
              ? 400
              : 500,
          {
            ok: false,
            code:
              cause instanceof RangeError
                ? "RUNTIME_REQUEST_TOO_LARGE"
                : "RUNTIME_REQUEST_FAILED",
            effect: dispatched ? "unknown" : "none",
          },
        ),
      )
      .finally(() => {
        if (smallAdmitted) activeRequests--;
        if (largeAdmitted) largeRequests--;
      });
  });
  server.requestTimeout = 310_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const connection: AgentRuntimeConnection = {
      api: {
        baseUrl,
        apiSecret,
        applicationInstanceId: options.applicationInstanceId,
        runtimeGenerationId,
      },
      credential: { adapter: "mcp", adapterSecret: secrets.mcp },
    };
    managedMcp = new ManagedHttpMcpHost({
      connection,
      bindingRegistry: options.agentRuntimeBindingRegistry,
      turns: options.providerAgentRuntimeTurns,
    });
    await managedMcp.start();
    const publishedAt = (options.clock?.now() ?? new Date()).toISOString();
    publication = await publishRuntimeDiscoveryEntry({
      /** 同種の既存登録が記載の認証情報で応答するか確かめる。他種の登録はこの確認で回収対象にしない。 */
      challenge: async (entry, slotDirectoryPath) => {
        // 別種のランタイムの登録は廃止しない。
        if (entry.runtimeKind !== AGENT_RUNTIME_KIND) return true;
        try {
          const serialized = await readRuntimeDiscoveryCredential(
            {
              entry,
              slotDirectoryPath,
              slotName: path.basename(slotDirectoryPath),
            },
            "mcp",
          );
          if (!serialized) return false;
          const envelope = JSON.parse(serialized);
          const credential = envelope.credential;
          if (
            envelope.applicationInstanceId !== entry.applicationInstanceId ||
            envelope.runtimeGenerationId !== entry.runtimeGenerationId ||
            envelope.runtimeKind !== AGENT_RUNTIME_KIND ||
            !credential ||
            typeof credential.baseUrl !== "string" ||
            !normalizeAgentRuntimeApiBaseUrl(credential.baseUrl) ||
            typeof credential.apiSecret !== "string"
          )
            return false;
          return await verifyRuntimeIdentity(
            {
              baseUrl: credential.baseUrl,
              apiSecret: credential.apiSecret,
              applicationInstanceId: entry.applicationInstanceId,
              runtimeGenerationId: entry.runtimeGenerationId,
            },
            fetch,
            AbortSignal.timeout(2_000),
          );
        } catch {
          return false;
        }
      },
      rootDirectoryPath: options.registryDirectoryPath,
      security: options.runtimePathSecurity ?? secureRuntimePath,
      clock: options.clock,
      timers: options.timers,
      identity: {
        applicationInstanceId: options.applicationInstanceId,
        runtimeKind: AGENT_RUNTIME_KIND,
        runtimeGenerationId,
      },
      buildChannel: options.buildChannel,
      process: {
        pid: process.pid,
        startedAt: options.processStartedAt ?? publishedAt,
      },
      credentialDocuments: (["cli", "mcp"] as const).map((adapter) => ({
        adapterKind: adapter,
        document: {
          schemaVersion: "withmate-runtime-credential-v1",
          applicationInstanceId: options.applicationInstanceId,
          runtimeKind: AGENT_RUNTIME_KIND,
          adapterKind: adapter,
          runtimeGenerationId,
          credential: {
            schemaVersion: AGENT_RUNTIME_DISCOVERY_SCHEMA_VERSION,
            adapter,
            baseUrl,
            apiSecret,
            adapterSecret: secrets[adapter],
            applicationInstanceId: options.applicationInstanceId,
            runtimeGenerationId,
          },
        },
      })),
    });
    publication.startHeartbeat();
    let stopPromise: Promise<void> | undefined;
    return {
      baseUrl,
      applicationInstanceId: options.applicationInstanceId,
      runtimeGenerationId,
      managedMcp,
      /** 最初の停止処理を共有し、管理 MCP の停止に失敗しても API と公開登録を後始末する。 */
      stop() {
        return (stopPromise ??= (async () => {
          stopping = true;
          try {
            await managedMcp!.stop();
          } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
            await publication!.unpublish();
            await publication!.cleanupGeneration();
          }
        })());
      },
    };
  } catch (error) {
    stopping = true;
    await managedMcp?.stop().catch(() => undefined);
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (publication) {
      await publication.unpublish();
      await publication.cleanupGeneration();
    }
    throw error;
  }
}
