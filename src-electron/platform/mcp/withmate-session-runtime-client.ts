import {
  SESSION_RUNTIME_OPERATION_PATHS,
  SESSION_READ_OPERATIONS,
  sessionOperationRequestSchemas,
  sessionOperationResultSchema,
  sessionOperationSuccessSchemas,
  type SessionOperation,
} from "../../../src-shared/session/session-management-contract.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../agent-runtime/runtime-exchange.js";
import { isLocalPrAgentOperation } from "../../../src-shared/local-pr/local-pr-agent-operations.js";
import {
  callAgentRuntime,
  mapAgentRuntimeDiscoveryCode,
  resolveAgentRuntimeApi,
  resolveAgentRuntimeBindingReference,
  resolveAgentRuntimeTurnCapability,
  type AgentRuntimeConnection,
} from "../agent-runtime/runtime-client.js";
/** MCP アダプターで使う接続選択の設定と、既知の接続・通信処理を渡すための差し替え口。 */
export type SessionRuntimeClientDeps = Omit<
  Parameters<typeof resolveAgentRuntimeApi>[0],
  "adapter" | "signal"
> & {
  connection?: AgentRuntimeConnection;
  runtimeCall?: typeof callAgentRuntime;
  requestTimeoutMs?: number;
};
/** 応答を確認できなかった操作の副作用を分類し、有効な送信要求には元の ID での照会情報を添える。 */
export function createSessionTransportError(
  operation?: SessionOperation,
  body?: unknown,
): Record<string, unknown> {
  const request =
    operation === "enqueue"
      ? sessionOperationRequestSchemas.enqueue.safeParse(body)
      : null;
  return {
    ok: false,
    code: "SESSION_TRANSPORT_ERROR",
    message:
      operation && isLocalPrAgentOperation(operation)
        ? "The local PR response was not confirmed. Read the PR or CI state before deciding whether to retry. Do not automatically resend a mutation."
        : operation === "set_instructions"
          ? "The Session instructions update was not confirmed. Read the saved body with get_instructions before deciding whether to retry. Do not automatically resend the replacement."
          : "The Session response was not confirmed. Recover enqueue with get_receipt and its original requestId. Child creation and Coordination retries must keep the identical request and original requestId/operationId. A coordination_get can be repeated to recover its current state. Do not automatically resend mutations or invent new keys.",
    effect:
      operation && !SESSION_READ_OPERATIONS.includes(operation)
        ? "unknown"
        : "none",
    ...(request?.success
      ? {
          recovery: {
            operation: "get_receipt",
            target: request.data.target,
            requestId: request.data.requestId,
          },
        }
      : {}),
  };
}
/** 入力と紐付けを確認して要求を送信し、操作に対応するスキーマで検証済みの結果を返す。 */
export async function callSessionRuntime(
  operation: SessionOperation,
  body: unknown,
  deps: SessionRuntimeClientDeps,
): Promise<Record<string, unknown>> {
  const parsed = sessionOperationRequestSchemas[operation].safeParse(body);
  if (!parsed.success)
    return {
      ok: false,
      code: "SESSION_INVALID_REQUEST",
      effect: "none",
      message: parsed.error.message,
    };
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    deps.requestTimeoutMs ?? 10000,
  );
  let sent = false;
  try {
    let bindingReference: string | undefined;
    try {
      bindingReference = resolveAgentRuntimeBindingReference(deps.env);
    } catch {
      return { ok: false, code: "SESSION_BINDING_REQUIRED", effect: "none" };
    }
    if (!bindingReference)
      return { ok: false, code: "SESSION_BINDING_REQUIRED", effect: "none" };
    const resolution = deps.connection
      ? { kind: "selected" as const, connection: deps.connection }
      : await resolveAgentRuntimeApi({
          ...deps,
          adapter: "mcp",
          signal: controller.signal,
        });
    if (resolution.kind === "error")
      return {
        ok: false,
        code: mapAgentRuntimeDiscoveryCode(resolution.code),
        effect: "none",
        candidates: resolution.candidates,
      };
    sent = true;
    const response = await (deps.runtimeCall ?? callAgentRuntime)(
      resolution.connection,
      {
        method: "POST",
        path: SESSION_RUNTIME_OPERATION_PATHS[operation],
        body: parsed.data,
      },
      {
        signal: controller.signal,
        bindingReference,
        turnCapability: resolveAgentRuntimeTurnCapability(deps.env),
        exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
      },
    );
    const result = sessionOperationResultSchema.safeParse(response.value);
    if (result.success && result.data.ok === false) return result.data;
    if (response.ok) {
      const success = sessionOperationSuccessSchemas[operation].safeParse(
        response.value,
      );
      if (success.success) return success.data;
    }
    return createSessionTransportError(operation, parsed.data);
  } catch {
    return createSessionTransportError(
      sent ? operation : undefined,
      parsed.data,
    );
  } finally {
    clearTimeout(timeout);
  }
}
