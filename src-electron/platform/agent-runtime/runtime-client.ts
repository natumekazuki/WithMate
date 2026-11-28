import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  createAgentRuntimeChallenge,
  createAgentRuntimeOwnerChallenge,
  WITHMATE_AGENT_RUNTIME_NONCE_HEADER,
  WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER,
  WITHMATE_AGENT_RUNTIME_GENERATION_HEADER,
  WITHMATE_AGENT_RUNTIME_CHALLENGE_HEADER,
  WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
  WITHMATE_AGENT_RUNTIME_EXCHANGE_SCHEMA_VERSION,
} from "./runtime-exchange.js";
import {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV,
  WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV,
} from "../../../src-shared/agent-runtime/agent-runtime-binding-contract.js";
import {
  getRuntimeDiscoveryLeaseState,
  isUuid,
  RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS,
  RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION,
  type RuntimeBuildChannel,
  type RuntimeDiscoveryClock,
  type RuntimeDiscoverySelectionOutcomeCode,
} from "../runtime-discovery/runtime-discovery-contract.js";
import {
  listRuntimeDiscoveryRegistryEntries,
  readRuntimeDiscoveryCredential,
  type RuntimeDiscoveryRegistryRecord,
} from "../runtime-discovery/runtime-discovery-registry.js";

/** ランタイム API に接続するアダプターの種別。認証では CLI と MCP を区別する。 */
export type AgentAdapterKind = "cli" | "mcp";
/** 共通のエージェント操作ランタイムを検出レジストリで識別する種別。 */
export const AGENT_RUNTIME_KIND = "agent-runtime";
/** アダプター用認証ドキュメントの内部ペイロードに使うスキーマ識別子。 */
export const AGENT_RUNTIME_DISCOVERY_SCHEMA_VERSION =
  "withmate-agent-runtime-discovery-v1";

/** 認証情報を含まない IPv4 ループバックの HTTP URL だけを受け付け、検索文字列・フラグメント・末尾のスラッシュを取り除く。 */
export function normalizeAgentRuntimeApiBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password
    )
      return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
/** API の接続先と、接続先のインスタンス・世代を検証するための秘密情報。 */
export type AgentApiConnection = {
  baseUrl: string;
  apiSecret: string;
  applicationInstanceId: string;
  runtimeGenerationId: string;
};

/** CLI または MCP の種別と、その種別の要求を認証するための秘密情報。 */
export type AgentAdapterCredential = {
  adapter: AgentAdapterKind;
  adapterSecret: string;
};

/** ランタイムの所有者を確かめる API 接続情報と、呼び出し元を認証する情報の組。 */
export type AgentRuntimeConnection = {
  api: AgentApiConnection;
  credential: AgentAdapterCredential;
};

/** 共通の交換エンドポイントで運ぶ、実際の拡張操作のメソッド・パス・本文。 */
export type AgentRuntimeOperation = {
  method: "GET" | "POST";
  path: string;
  body: unknown;
};

/** 接続先の確認後に受信した HTTP ステータスと JSON 値。ok は 2xx 応答を示す。 */
export type AgentRuntimeResponse = {
  ok: boolean;
  status: number;
  value: unknown;
};

/** 検出結果を説明するための候補情報。接続先 URL や認証情報は含まない。 */
export type AgentRuntimeCandidate = {
  source: "registry" | "explicit";
  applicationInstanceId: string | null;
  runtimeGenerationId: string;
  buildChannel: RuntimeBuildChannel;
  pid: number | null;
  leaseState: "fresh" | "expired" | "explicit";
  active: boolean;
};

/** 接続可能な候補を一意に選んだ結果、または候補を選べなかった理由と診断情報。 */
export type AgentRuntimeResolution =
  | {
      kind: "selected";
      connection: AgentRuntimeConnection;
      candidate: AgentRuntimeCandidate;
      candidates: AgentRuntimeCandidate[];
    }
  | {
      kind: "error";
      code: RuntimeDiscoverySelectionOutcomeCode;
      candidates: AgentRuntimeCandidate[];
    };

/** CLI や MCP の呼び出し元に公開するランタイム検出・照合の失敗コード。 */
export type AgentRuntimePublicDiscoveryCode =
  | "WITHMATE_RUNTIME_UNAVAILABLE"
  | "WITHMATE_RUNTIME_INSTANCE_MISMATCH"
  | "WITHMATE_RUNTIME_GENERATION_CHANGED"
  | "WITHMATE_RUNTIME_AMBIGUOUS"
  | "WITHMATE_RUNTIME_STALE"
  | "WITHMATE_RUNTIME_REGISTRY_CAPACITY"
  | "WITHMATE_RUNTIME_SELECTOR_INVALID"
  | "WITHMATE_RUNTIME_CREDENTIAL_UNAVAILABLE";

/** ランタイムとの通信失敗と、要求本文の送信を開始したかどうかを伝える。送信開始は操作の成立を意味しない。 */
export class AgentRuntimeExchangeError extends Error {
  readonly dispatched: boolean;
  readonly discoveryCode?: AgentRuntimePublicDiscoveryCode;

  /** 通信の失敗を記録し、該当する場合は接続先の照合に失敗した理由も残す。 */
  constructor(
    message: string,
    dispatched: boolean,
    options?: ErrorOptions & {
      discoveryCode?: AgentRuntimePublicDiscoveryCode;
    },
  ) {
    super(message, options);
    this.name = "AgentRuntimeExchangeError";
    this.dispatched = dispatched;
    this.discoveryCode = options?.discoveryCode;
  }
}

/** 検出時に期限切れ候補の応答を照合する際の既定の待機時間。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** 環境変数の前後の空白を除き、空の値を未指定として扱う。 */
function readRequiredEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  return env[name]?.trim() || undefined;
}
/** CLI と MCP のうち、要求元アダプターの認証に使う環境変数だけを読む。 */
function resolveAdapterSecret(
  env: NodeJS.ProcessEnv,
  adapter: AgentAdapterKind,
): string | undefined {
  return readRequiredEnvValue(
    env,
    adapter === "cli"
      ? "WITHMATE_AGENT_RUNTIME_CLI_API_SECRET"
      : "WITHMATE_AGENT_RUNTIME_MCP_API_SECRET",
  );
}
/** API とアダプターの秘密情報、および所有者の両 ID がそろう場合に限り接続情報を組み立てる。 */
function buildConnectionFromValues(input: {
  adapter: AgentAdapterKind;
  baseUrl: string;
  apiSecret?: string;
  adapterSecret?: string;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
}): AgentRuntimeConnection | null {
  if (
    !input.apiSecret ||
    !input.adapterSecret ||
    !input.applicationInstanceId ||
    !input.runtimeGenerationId
  )
    return null;
  return {
    api: {
      baseUrl: input.baseUrl,
      apiSecret: input.apiSecret,
      applicationInstanceId: input.applicationInstanceId,
      runtimeGenerationId: input.runtimeGenerationId,
    },
    credential: { adapter: input.adapter, adapterSecret: input.adapterSecret },
  };
}
/** 検出結果に出せる情報と内部接続情報を分け、認証情報がない候補も選択判定に残す。 */
type InternalAgentRuntimeCandidate = {
  safe: AgentRuntimeCandidate;
  connection: AgentRuntimeConnection | null;
  credentialUnavailable: boolean;
};
/** 認証ドキュメントの外側と内部の両方を登録の所有者・世代・アダプターと照合する。不一致や読めない内容は接続情報にしない。 */
function parseRegistryAgentCredential(
  serialized: string,
  record: RuntimeDiscoveryRegistryRecord,
  adapter: AgentAdapterKind,
): AgentRuntimeConnection | null {
  try {
    const value = JSON.parse(serialized);
    if (
      !value ||
      value.schemaVersion !== "withmate-runtime-credential-v1" ||
      value.applicationInstanceId !== record.entry.applicationInstanceId ||
      value.runtimeKind !== AGENT_RUNTIME_KIND ||
      value.adapterKind !== adapter ||
      value.runtimeGenerationId !== record.entry.runtimeGenerationId
    )
      return null;
    const doc = value.credential;
    if (
      !doc ||
      doc.schemaVersion !== AGENT_RUNTIME_DISCOVERY_SCHEMA_VERSION ||
      doc.adapter !== adapter ||
      doc.applicationInstanceId !== record.entry.applicationInstanceId ||
      doc.runtimeGenerationId !== record.entry.runtimeGenerationId ||
      typeof doc.baseUrl !== "string" ||
      typeof doc.apiSecret !== "string" ||
      typeof doc.adapterSecret !== "string"
    )
      return null;
    const baseUrl = normalizeAgentRuntimeApiBaseUrl(doc.baseUrl);
    return baseUrl ? buildConnectionFromValues({ ...doc, baseUrl }) : null;
  } catch {
    return null;
  }
}
/** レジストリの公開属性とリース状態から、認証情報を含まない候補メタデータを作る。 */
function buildRegistrySafeCandidate(
  record: RuntimeDiscoveryRegistryRecord,
  now: Date,
  active: boolean,
  staleThresholdMs = RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS,
): AgentRuntimeCandidate {
  return {
    source: "registry",
    applicationInstanceId: record.entry.applicationInstanceId,
    runtimeGenerationId: record.entry.runtimeGenerationId,
    buildChannel: record.entry.buildChannel,
    pid: record.entry.process.pid,
    leaseState: getRuntimeDiscoveryLeaseState(
      record.entry,
      now,
      staleThresholdMs,
    ),
    active,
  };
}
/** セレクターで指定されたインスタンスと世代のすべてが候補に一致するか確かめる。 */
function candidateMatchesSelector(
  candidate: InternalAgentRuntimeCandidate,
  applicationInstanceId: string | undefined,
  runtimeGenerationId: string | undefined,
): boolean {
  return (
    (!applicationInstanceId ||
      candidate.safe.applicationInstanceId === applicationInstanceId) &&
    (!runtimeGenerationId ||
      candidate.safe.runtimeGenerationId === runtimeGenerationId)
  );
}
/** 候補一覧から接続情報を除き、診断に返せるメタデータだけを抽出する。 */
function toSafeCandidates(
  candidates: InternalAgentRuntimeCandidate[],
): AgentRuntimeCandidate[] {
  return candidates.map(({ safe }) => safe);
}
/** 検出の失敗理由と安全な候補一覧を、接続情報を含めずに返す。 */
function discoveryError(
  code: RuntimeDiscoverySelectionOutcomeCode,
  candidates: InternalAgentRuntimeCandidate[],
): AgentRuntimeResolution {
  return { kind: "error", code, candidates: toSafeCandidates(candidates) };
}
/** レジストリ内の選択失敗理由を CLI・MCP 向けの公開エラーコードへ変換する。 */
export function mapAgentRuntimeDiscoveryCode(
  code: RuntimeDiscoverySelectionOutcomeCode,
): AgentRuntimePublicDiscoveryCode {
  switch (code) {
    case "runtime_instance_mismatch":
      return "WITHMATE_RUNTIME_INSTANCE_MISMATCH";
    case "runtime_generation_changed":
      return "WITHMATE_RUNTIME_GENERATION_CHANGED";
    case "runtime_ambiguous":
      return "WITHMATE_RUNTIME_AMBIGUOUS";
    case "runtime_stale":
      return "WITHMATE_RUNTIME_STALE";
    case "runtime_registry_capacity":
      return "WITHMATE_RUNTIME_REGISTRY_CAPACITY";
    case "runtime_selector_invalid":
    case "runtime_invalid":
      return "WITHMATE_RUNTIME_SELECTOR_INVALID";
    case "runtime_credential_unavailable":
      return "WITHMATE_RUNTIME_CREDENTIAL_UNAVAILABLE";
    case "runtime_unavailable":
      return "WITHMATE_RUNTIME_UNAVAILABLE";
  }
}

/** 明示 URL、またはレジストリ上の有効な候補から接続先を解決する。指定された所有者から別の所有者に切り替えず、有効な候補の曖昧さは失敗として返す。 */
export async function resolveAgentRuntimeApi(options: {
  adapter: AgentAdapterKind;
  env?: NodeJS.ProcessEnv;
  apiUrl?: string;
  registryRootDirectoryPath?: string;
  registryDirectoryPath?: string;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
  fetch?: typeof fetch;
  clock?: RuntimeDiscoveryClock;
  staleThresholdMs?: number;
  signal?: AbortSignal;
}): Promise<AgentRuntimeResolution> {
  const env = options.env ?? process.env;
  const bindingRequired =
    env[WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]?.trim() === "1";
  const envApplicationInstanceId = readRequiredEnvValue(
    env,
    WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  );
  const envRuntimeGenerationId = readRequiredEnvValue(
    env,
    WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV,
  );
  if (
    bindingRequired &&
    (!envApplicationInstanceId || !envRuntimeGenerationId)
  ) {
    return discoveryError("runtime_selector_invalid", []);
  }

  const applicationInstanceId = bindingRequired
    ? envApplicationInstanceId
    : (options.applicationInstanceId ?? envApplicationInstanceId);
  const runtimeGenerationId = bindingRequired
    ? envRuntimeGenerationId
    : (options.runtimeGenerationId ?? envRuntimeGenerationId);
  if (
    (applicationInstanceId && !isUuid(applicationInstanceId)) ||
    (runtimeGenerationId && !isUuid(runtimeGenerationId)) ||
    (runtimeGenerationId && !applicationInstanceId)
  ) {
    return discoveryError("runtime_selector_invalid", []);
  }

  const explicitApiUrl =
    options.apiUrl ?? env.WITHMATE_AGENT_RUNTIME_API_URL?.trim();
  if (explicitApiUrl) {
    const baseUrl = normalizeAgentRuntimeApiBaseUrl(explicitApiUrl);
    if (!baseUrl) {
      return discoveryError("runtime_selector_invalid", []);
    }
    const connection = buildConnectionFromValues({
      adapter: options.adapter,
      baseUrl,
      apiSecret: readRequiredEnvValue(env, "WITHMATE_AGENT_RUNTIME_API_SECRET"),
      adapterSecret: resolveAdapterSecret(env, options.adapter),
      applicationInstanceId,
      runtimeGenerationId,
    });
    if (
      !connection ||
      (bindingRequired && !connection.api.applicationInstanceId)
    ) {
      return discoveryError("runtime_credential_unavailable", []);
    }
    const candidate: AgentRuntimeCandidate = {
      source: "explicit",
      applicationInstanceId: connection.api.applicationInstanceId ?? null,
      runtimeGenerationId: connection.api.runtimeGenerationId,
      buildChannel: "unknown",
      pid: null,
      leaseState: "explicit",
      active: true,
    };
    return { kind: "selected", connection, candidate, candidates: [candidate] };
  }

  const now = options.clock?.now() ?? new Date();
  const staleThresholdMs =
    options.staleThresholdMs ?? RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS;
  const fetchImpl = options.fetch ?? fetch;
  const signal =
    options.signal ?? AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  const registryRootDirectoryPath =
    options.registryRootDirectoryPath ?? options.registryDirectoryPath;
  const registryCandidates: InternalAgentRuntimeCandidate[] = [];
  try {
    const snapshot = await listRuntimeDiscoveryRegistryEntries(
      registryRootDirectoryPath,
    );
    for (const record of snapshot.records) {
      if (
        record.entry.schemaVersion !==
          RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION ||
        record.entry.runtimeKind !== AGENT_RUNTIME_KIND
      ) {
        continue;
      }
      const credential = await readRuntimeDiscoveryCredential(
        record,
        options.adapter,
      );
      const connection =
        credential === null
          ? null
          : parseRegistryAgentCredential(credential, record, options.adapter);
      const fresh =
        getRuntimeDiscoveryLeaseState(record.entry, now, staleThresholdMs) ===
        "fresh";
      registryCandidates.push({
        safe: buildRegistrySafeCandidate(record, now, fresh, staleThresholdMs),
        connection,
        credentialUnavailable: connection === null,
      });
    }
  } catch {
    return discoveryError("runtime_unavailable", []);
  }

  const targetedRegistryCandidates = applicationInstanceId
    ? registryCandidates.filter((candidate) =>
        candidateMatchesSelector(
          candidate,
          applicationInstanceId,
          runtimeGenerationId,
        ),
      )
    : registryCandidates;
  for (const candidate of targetedRegistryCandidates) {
    if (candidate.safe.leaseState !== "expired" || !candidate.connection) {
      continue;
    }
    try {
      candidate.safe.active = await verifyRuntimeIdentity(
        candidate.connection.api,
        fetchImpl,
        signal,
      );
    } catch {
      candidate.safe.active = false;
    }
  }

  const allCandidates = registryCandidates;
  const matching = allCandidates.filter((candidate) =>
    candidateMatchesSelector(
      candidate,
      applicationInstanceId,
      runtimeGenerationId,
    ),
  );
  if (applicationInstanceId && matching.length === 0) {
    const sameApplication = allCandidates.filter(
      (candidate) =>
        candidate.safe.applicationInstanceId === applicationInstanceId,
    );
    if (runtimeGenerationId && sameApplication.length > 0) {
      return discoveryError("runtime_generation_changed", sameApplication);
    }
    return discoveryError(
      allCandidates.length > 0
        ? "runtime_instance_mismatch"
        : "runtime_unavailable",
      allCandidates,
    );
  }
  const active = matching.filter((candidate) => candidate.safe.active);
  if (active.length === 0) {
    return discoveryError(
      matching.length > 0 ? "runtime_stale" : "runtime_unavailable",
      matching,
    );
  }
  if (active.length > 1) {
    return discoveryError("runtime_ambiguous", matching);
  }
  const selected = active[0]!;
  if (selected.credentialUnavailable || selected.connection === null) {
    return discoveryError("runtime_credential_unavailable", matching);
  }
  return {
    kind: "selected",
    connection: selected.connection,
    candidate: selected.safe,
    candidates: toSafeCandidates(allCandidates),
  };
}

/** 状態照会と交換時の暫定応答で接続先を確認し、照合が済んでから秘密情報と操作を含む本文を送信する。 */
export async function callAgentRuntime(
  connection: AgentRuntimeConnection,
  operation: AgentRuntimeOperation,
  options: {
    signal: AbortSignal;
    bindingReference?: string;
    turnCapability?: string;
    exchangePath?: string;
    fetch?: typeof fetch;
  },
): Promise<AgentRuntimeResponse> {
  let identityOutcome: RuntimeIdentityVerificationOutcome;
  try {
    identityOutcome = await verifyRuntimeIdentityOutcome(
      connection.api,
      options.fetch ?? fetch,
      options.signal,
    );
  } catch (error) {
    throw new AgentRuntimeExchangeError(
      "Agent runtime runtime identity preflight failed.",
      false,
      { cause: error, discoveryCode: "WITHMATE_RUNTIME_UNAVAILABLE" },
    );
  }
  if (!identityOutcome.ok) {
    throw new AgentRuntimeExchangeError(
      "Agent runtime runtime identity could not be verified.",
      false,
      { discoveryCode: identityOutcome.discoveryCode },
    );
  }

  const nonce = randomBytes(16).toString("base64url");
  const exchangeUrl = new URL(
    options.exchangePath ?? WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
    connection.api.baseUrl,
  );
  const payload = JSON.stringify({
    schemaVersion: WITHMATE_AGENT_RUNTIME_EXCHANGE_SCHEMA_VERSION,
    apiSecret: connection.api.apiSecret,
    adapter: connection.credential.adapter,
    adapterSecret: connection.credential.adapterSecret,
    ...(options.bindingReference
      ? { bindingReference: options.bindingReference }
      : {}),
    ...(options.turnCapability
      ? { turnCapability: options.turnCapability }
      : {}),
    operation,
  });

  return new Promise<AgentRuntimeResponse>((resolve, reject) => {
    let dispatched = false;
    let identityVerified = false;
    let settled = false;
    /** 最初の通信失敗だけを確定させ、その時点での本文送信状態と検出コードを呼び出し元に伝える。 */
    const fail = (
      message: string,
      cause?: unknown,
      discoveryCode?: AgentRuntimePublicDiscoveryCode,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(
        new AgentRuntimeExchangeError(message, dispatched, {
          ...(cause === undefined ? {} : { cause }),
          ...(discoveryCode === undefined ? {} : { discoveryCode }),
        }),
      );
    };
    let request: ReturnType<typeof httpRequest>;
    try {
      request = httpRequest(
        {
          protocol: exchangeUrl.protocol,
          hostname: exchangeUrl.hostname,
          port: exchangeUrl.port,
          path: exchangeUrl.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(options.exchangePath ===
            WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH
              ? { "Content-Length": Buffer.byteLength(payload, "utf8") }
              : {}),
            [WITHMATE_AGENT_RUNTIME_NONCE_HEADER]: nonce,
            [WITHMATE_AGENT_RUNTIME_GENERATION_HEADER]:
              connection.api.runtimeGenerationId,
            ...(connection.api.applicationInstanceId
              ? {
                  [WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER]:
                    connection.api.applicationInstanceId,
                }
              : {}),
          },
          signal: options.signal,
        },
        (response) => {
          if (!identityVerified) {
            response.destroy();
            request.destroy();
            fail(
              "Agent runtime returned a final response before runtime identity was verified.",
            );
            return;
          }
          const chunks: Buffer[] = [];
          response.on("data", (chunk) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
          );
          response.on("error", (error) =>
            fail("Agent runtime response failed.", error),
          );
          response.on("end", () => {
            if (settled) {
              return;
            }
            const text = Buffer.concat(chunks).toString("utf8");
            if (!text.trim()) {
              fail("Agent runtime returned a non-JSON response.");
              return;
            }
            try {
              const value = JSON.parse(text) as unknown;
              settled = true;
              resolve({
                ok:
                  typeof response.statusCode === "number" &&
                  response.statusCode >= 200 &&
                  response.statusCode < 300,
                status: response.statusCode ?? 500,
                value,
              });
            } catch (error) {
              fail("Agent runtime returned a non-JSON response.", error);
            }
          });
        },
      );
    } catch (error) {
      fail("Agent runtime request could not be created.", error);
      return;
    }

    request.on("information", (information) => {
      if (settled || identityVerified || information.statusCode !== 103) {
        return;
      }
      const runtimeGenerationId =
        information.headers[WITHMATE_AGENT_RUNTIME_GENERATION_HEADER];
      const applicationInstanceId =
        information.headers[WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER];
      const challenge =
        information.headers[WITHMATE_AGENT_RUNTIME_CHALLENGE_HEADER];
      const expected = createAgentRuntimeChallenge(
        connection.api.apiSecret,
        connection.api.runtimeGenerationId,
        nonce,
      );
      if (
        (runtimeGenerationId !== undefined &&
          runtimeGenerationId !== connection.api.runtimeGenerationId) ||
        (connection.api.applicationInstanceId &&
          runtimeGenerationId !== connection.api.runtimeGenerationId) ||
        (connection.api.applicationInstanceId &&
          applicationInstanceId !== connection.api.applicationInstanceId)
      ) {
        request.destroy();
        const discoveryCode =
          connection.api.applicationInstanceId &&
          applicationInstanceId !== connection.api.applicationInstanceId
            ? "WITHMATE_RUNTIME_INSTANCE_MISMATCH"
            : "WITHMATE_RUNTIME_GENERATION_CHANGED";
        fail(
          "Agent runtime runtime identity could not be verified.",
          undefined,
          discoveryCode,
        );
        return;
      }
      if (challenge !== expected) {
        request.destroy();
        fail(
          "Agent runtime runtime identity challenge could not be verified.",
          undefined,
          "WITHMATE_RUNTIME_CREDENTIAL_UNAVAILABLE",
        );
        return;
      }
      identityVerified = true;
      dispatched = true;
      request.end(payload);
    });
    request.on("error", (error) =>
      fail("Agent runtime request failed.", error),
    );
    options.signal.addEventListener(
      "abort",
      () => fail("Agent runtime request was aborted."),
      { once: true },
    );
    try {
      request.flushHeaders();
    } catch (error) {
      request.destroy();
      fail("Agent runtime request could not be dispatched.", error);
    }
  });
}

/** 環境から束縛参照を読む。束縛必須の実行で参照が欠けていればエラーにする。 */
export function resolveAgentRuntimeBindingReference(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const reference = env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]?.trim();
  if (
    !reference &&
    env[WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]?.trim() === "1"
  ) {
    throw new Error(
      "WithMate provider execution requires its runtime binding reference.",
    );
  }
  return reference || undefined;
}

/** 環境から現在のターンの操作受付に必要な値を読み、空なら未指定として返す。 */
export function resolveAgentRuntimeTurnCapability(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const capability = env[WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV]?.trim();
  return capability || undefined;
}

/** 状態照会で接続先の所有者を確認できたか、確認できない場合の公開エラーコード。 */
type RuntimeIdentityVerificationOutcome =
  { ok: true } | { ok: false; discoveryCode: AgentRuntimePublicDiscoveryCode };

/** 状態応答のインスタンス・世代・ノンスと、接続情報で計算した HMAC を照合する。応答を解釈できなければ例外を返す。 */
async function verifyRuntimeIdentityOutcome(
  connection: AgentApiConnection,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<RuntimeIdentityVerificationOutcome> {
  const nonce = randomBytes(16).toString("base64url");
  const response = await fetchImpl(
    `${connection.baseUrl}/v1/status?nonce=${encodeURIComponent(nonce)}`,
    {
      method: "GET",
      redirect: "error",
      signal,
    },
  );
  if (!response.ok) {
    return { ok: false, discoveryCode: "WITHMATE_RUNTIME_UNAVAILABLE" };
  }
  const text = await response.text();
  if (!text.trim()) {
    throw new Error("Agent runtime returned a non-JSON response.");
  }
  let status: {
    applicationInstanceId?: unknown;
    runtimeGenerationId?: unknown;
    runtimeInstanceId?: unknown;
    challenge?: {
      nonce?: unknown;
      hmacSha256?: unknown;
      ownerHmacSha256?: unknown;
    };
  };
  try {
    status = JSON.parse(text) as typeof status;
  } catch {
    throw new Error("Agent runtime returned a non-JSON response.");
  }
  if (
    connection.applicationInstanceId &&
    status.applicationInstanceId !== connection.applicationInstanceId
  ) {
    return { ok: false, discoveryCode: "WITHMATE_RUNTIME_INSTANCE_MISMATCH" };
  }
  if (
    (status.runtimeGenerationId !== undefined &&
      status.runtimeGenerationId !== connection.runtimeGenerationId) ||
    (connection.applicationInstanceId &&
      status.runtimeGenerationId !== connection.runtimeGenerationId)
  ) {
    return { ok: false, discoveryCode: "WITHMATE_RUNTIME_GENERATION_CHANGED" };
  }
  if (status.challenge?.nonce !== nonce)
    return {
      ok: false,
      discoveryCode: "WITHMATE_RUNTIME_CREDENTIAL_UNAVAILABLE",
    };
  const expectedOwnerChallenge = createAgentRuntimeOwnerChallenge(
    connection.apiSecret,
    connection.applicationInstanceId,
    connection.runtimeGenerationId,
    nonce,
  );
  return status.challenge?.ownerHmacSha256 === expectedOwnerChallenge
    ? { ok: true }
    : { ok: false, discoveryCode: "WITHMATE_RUNTIME_CREDENTIAL_UNAVAILABLE" };
}

/** 状態照会で接続先の所有者を確認できるか判定する。通信や応答の解析に失敗した場合は例外を伝える。 */
export async function verifyRuntimeIdentity(
  connection: AgentApiConnection,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<boolean> {
  return (await verifyRuntimeIdentityOutcome(connection, fetchImpl, signal)).ok;
}
