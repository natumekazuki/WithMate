import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { RuntimeBuildChannel, RuntimeDiscoveryClock, RuntimeDiscoveryTimers } from "../runtime-discovery/runtime-discovery-contract.js";
import { publishRuntimeDiscoveryEntry, readRuntimeDiscoveryCredential, type RuntimeDiscoveryRegistryPublication, type RuntimePathSecurity } from "../runtime-discovery/runtime-discovery-registry.js";
import { secureWindowsRuntimePath } from "../runtime-path-security.js";
import type { AgentRuntimeBindingRegistry } from "../../providers/agent-runtime-binding.js";
import type { ProviderAgentRuntimeTurnCoordinator } from "../../providers/provider-agent-runtime-turn-coordinator.js";
import { ManagedHttpMcpHost } from "./managed-http-mcp-host.js";
import { AGENT_RUNTIME_KIND, AGENT_RUNTIME_DISCOVERY_SCHEMA_VERSION, verifyRuntimeIdentity, normalizeAgentRuntimeApiBaseUrl, type AgentRuntimeConnection } from "./runtime-client.js";
import { createAgentRuntimeChallenge, createAgentRuntimeOwnerChallenge, WITHMATE_AGENT_RUNTIME_NONCE_HEADER,
  WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER, WITHMATE_AGENT_RUNTIME_GENERATION_HEADER,
  WITHMATE_AGENT_RUNTIME_CHALLENGE_HEADER, WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
  WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES, WITHMATE_AGENT_RUNTIME_EXCHANGE_SCHEMA_VERSION } from "./runtime-exchange.js";

export type AgentRuntimeExtensionRequest = {
  method: "GET" | "POST"; path: string; body: unknown; transport: "cli" | "mcp";
  bindingReference?: string; turnCapability?: string;
};
export type AgentRuntimeExtensionResponse = { status: number; value: unknown };
export type AgentRuntimeActorSession = {
  id: string; providerId: string; characterId?: string; sessionKind?: string;
  workspacePath?: string; allowedAdditionalDirectories?: string[];
};
export type AgentRuntimeApiHandle = {
  baseUrl: string; applicationInstanceId: string; runtimeGenerationId: string;
  managedMcp: ManagedHttpMcpHost;
  stop(): Promise<void>;
};
export type StartAgentRuntimeApiOptions = {
  applicationInstanceId: string; buildChannel: RuntimeBuildChannel; processStartedAt?: string;
  registryDirectoryPath?: string; runtimePathSecurity?: RuntimePathSecurity;
  maxBodyBytes?: number; maxConcurrentRequests?: number;
  clock?: RuntimeDiscoveryClock; timers?: RuntimeDiscoveryTimers;
  agentRuntimeBindingRegistry: AgentRuntimeBindingRegistry;
  providerAgentRuntimeTurns: ProviderAgentRuntimeTurnCoordinator;
  routeAgentRuntimeExtension(request: AgentRuntimeExtensionRequest): Promise<AgentRuntimeExtensionResponse | null> | AgentRuntimeExtensionResponse | null;
};

const payloadSchema = z.object({
  schemaVersion: z.literal(WITHMATE_AGENT_RUNTIME_EXCHANGE_SCHEMA_VERSION),
  apiSecret: z.string(), adapter: z.enum(["cli", "mcp"]), adapterSecret: z.string(),
  bindingReference: z.string().optional(), turnCapability: z.string().optional(),
  operation: z.object({ method: z.enum(["GET", "POST"]), path: z.string().startsWith("/v1/"), body: z.unknown() }).strict(),
}).strict();
function equalSecret(value: string, secret: string): boolean {
  const actual = Buffer.from(value); const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function reply(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
async function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length; if (bytes > maxBytes) throw new RangeError("Runtime request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const secureRuntimePath: RuntimePathSecurity = async (target, kind) => {
  if (process.platform === "win32") { await secureWindowsRuntimePath(target, kind); return; }
  const info = await lstat(target);
  if (info.isSymbolicLink() || (kind === "directory" ? !info.isDirectory() : !info.isFile())
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Runtime path owner or type is invalid.");
  await chmod(target, kind === "directory" ? 0o700 : 0o600);
};

/** The shared tool runtime owns transport and discovery only; it never opens application storage. */
export async function startAgentRuntimeApi(options: StartAgentRuntimeApiOptions): Promise<AgentRuntimeApiHandle> {
  const runtimeGenerationId = randomUUID();
  const apiSecret = randomBytes(32).toString("base64url");
  const secrets = { cli: randomBytes(32).toString("base64url"), mcp: randomBytes(32).toString("base64url") };
  let address: AddressInfo | null = null; let stopping = false; let activeRequests = 0; let largeRequests = 0;
  let publication: RuntimeDiscoveryRegistryPublication | undefined;
  let managedMcp: ManagedHttpMcpHost | undefined;
  const server = createServer((request, response) => {
    let smallAdmitted = false; let largeAdmitted = false; let dispatched = false;
    const route = async () => {
      const error = (status: number, code: string) => reply(response, status, { ok: false, code, effect: "none" });
      if (stopping) return error(503, "RUNTIME_UNAVAILABLE");
      if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== `127.0.0.1:${address?.port}`
        || request.headers.origin !== undefined) return error(403, "RUNTIME_FORBIDDEN");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/status") {
        const nonce = url.searchParams.get("nonce");
        if (!nonce || nonce.length > 256) return error(400, "RUNTIME_INVALID_REQUEST");
        return reply(response, 200, { applicationInstanceId: options.applicationInstanceId, runtimeGenerationId,
          challenge: { nonce, ownerHmacSha256: createAgentRuntimeOwnerChallenge(apiSecret, options.applicationInstanceId, runtimeGenerationId, nonce) } });
      }
      if (url.pathname !== WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH) return error(404, "RUNTIME_ROUTE_NOT_FOUND");
      if (request.method !== "POST" || request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") return error(405, "RUNTIME_INVALID_REQUEST");
      const nonce = request.headers[WITHMATE_AGENT_RUNTIME_NONCE_HEADER];
      if (typeof nonce !== "string" || !nonce || nonce.length > 256
        || request.headers[WITHMATE_AGENT_RUNTIME_GENERATION_HEADER] !== runtimeGenerationId
        || request.headers[WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER] !== options.applicationInstanceId) return error(401, "RUNTIME_UNAUTHORIZED");
      const length = request.headers["content-length"];
      const small = typeof length === "string" && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) && Number(length) <= (options.maxBodyBytes ?? 256 * 1024);
      if (small) { if (activeRequests >= (options.maxConcurrentRequests ?? 8)) return error(429, "RUNTIME_BUSY"); activeRequests++; smallAdmitted = true; }
      else { if (largeRequests >= 1) return error(429, "RUNTIME_BUSY"); largeRequests++; largeAdmitted = true; }
      request.setTimeout(310_000); response.setTimeout(310_000);
      response.writeEarlyHints({
        link: `<${WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH}>; rel=preconnect`,
        [WITHMATE_AGENT_RUNTIME_GENERATION_HEADER]: runtimeGenerationId,
        [WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER]: options.applicationInstanceId,
        [WITHMATE_AGENT_RUNTIME_CHALLENGE_HEADER]: createAgentRuntimeChallenge(apiSecret, runtimeGenerationId, nonce),
      });
      const parsed = payloadSchema.safeParse(await readBody(request, small ? (options.maxBodyBytes ?? 256 * 1024) : WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES));
      if (!parsed.success) return error(400, "RUNTIME_INVALID_REQUEST");
      const payload = parsed.data;
      if (!equalSecret(payload.apiSecret, apiSecret) || !equalSecret(payload.adapterSecret, secrets[payload.adapter])) return error(401, "RUNTIME_UNAUTHORIZED");
      // Glossary permits one dispatch regardless of body size.
      if (!largeAdmitted && payload.operation.path.startsWith("/v1/glossary/")) {
        if (largeRequests >= 1) return error(429, "RUNTIME_BUSY"); largeRequests++; largeAdmitted = true;
      }
      dispatched = true;
      const result = await options.routeAgentRuntimeExtension({ ...payload.operation, transport: payload.adapter,
        bindingReference: payload.bindingReference, turnCapability: payload.turnCapability });
      if (!result) return error(404, "RUNTIME_ROUTE_NOT_FOUND");
      reply(response, result.status, result.value);
    };
    void route().catch((cause) => reply(response, cause instanceof RangeError ? 413 : cause instanceof SyntaxError ? 400 : 500,
      { ok: false, code: cause instanceof RangeError ? "RUNTIME_REQUEST_TOO_LARGE" : "RUNTIME_REQUEST_FAILED", effect: dispatched ? "unknown" : "none" })).finally(() => {
        if (smallAdmitted) activeRequests--; if (largeAdmitted) largeRequests--;
      });
  });
  server.requestTimeout = 310_000; server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const connection: AgentRuntimeConnection = { api: { baseUrl, apiSecret, applicationInstanceId: options.applicationInstanceId, runtimeGenerationId },
      credential: { adapter: "mcp", adapterSecret: secrets.mcp } };
    managedMcp = new ManagedHttpMcpHost({ connection, bindingRegistry: options.agentRuntimeBindingRegistry, turns: options.providerAgentRuntimeTurns });
    await managedMcp.start();
    const publishedAt = (options.clock?.now() ?? new Date()).toISOString();
    publication = await publishRuntimeDiscoveryEntry({
      challenge: async (entry, slotDirectoryPath) => {
        // Do not retire registrations of another runtime kind.
        if (entry.runtimeKind !== AGENT_RUNTIME_KIND) return true;
        try {
          const serialized = await readRuntimeDiscoveryCredential({ entry, slotDirectoryPath, slotName: path.basename(slotDirectoryPath) }, "mcp");
          if (!serialized) return false;
          const envelope = JSON.parse(serialized);
          const credential = envelope.credential;
          if (envelope.applicationInstanceId !== entry.applicationInstanceId || envelope.runtimeGenerationId !== entry.runtimeGenerationId
            || envelope.runtimeKind !== AGENT_RUNTIME_KIND || !credential || typeof credential.baseUrl !== "string"
            || !normalizeAgentRuntimeApiBaseUrl(credential.baseUrl) || typeof credential.apiSecret !== "string") return false;
          return await verifyRuntimeIdentity({ baseUrl: credential.baseUrl, apiSecret: credential.apiSecret,
            applicationInstanceId: entry.applicationInstanceId, runtimeGenerationId: entry.runtimeGenerationId }, fetch, AbortSignal.timeout(2_000));
        } catch { return false; }
      },
      rootDirectoryPath: options.registryDirectoryPath, security: options.runtimePathSecurity ?? secureRuntimePath,
      clock: options.clock, timers: options.timers,
      identity: { applicationInstanceId: options.applicationInstanceId, runtimeKind: AGENT_RUNTIME_KIND, runtimeGenerationId },
      buildChannel: options.buildChannel, process: { pid: process.pid, startedAt: options.processStartedAt ?? publishedAt },
      credentialDocuments: (["cli", "mcp"] as const).map((adapter) => ({ adapterKind: adapter, document: {
        schemaVersion: "withmate-runtime-credential-v1", applicationInstanceId: options.applicationInstanceId,
        runtimeKind: AGENT_RUNTIME_KIND, adapterKind: adapter, runtimeGenerationId,
        credential: { schemaVersion: AGENT_RUNTIME_DISCOVERY_SCHEMA_VERSION, adapter, baseUrl, apiSecret,
          adapterSecret: secrets[adapter], applicationInstanceId: options.applicationInstanceId, runtimeGenerationId },
      } })),
    });
    publication.startHeartbeat();
    let stopPromise: Promise<void> | undefined;
    return { baseUrl, applicationInstanceId: options.applicationInstanceId, runtimeGenerationId, managedMcp,
      stop() {
        return stopPromise ??= (async () => {
          stopping = true;
          try { await managedMcp!.stop(); }
          finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            await publication!.unpublish(); await publication!.cleanupGeneration();
          }
        })();
      } };
  } catch (error) {
    stopping = true;
    await managedMcp?.stop().catch(() => undefined);
    server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (publication) { await publication.unpublish(); await publication.cleanupGeneration(); }
    throw error;
  }
}
