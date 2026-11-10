import {
  SESSION_RUNTIME_OPERATION_PATHS,
  SESSION_READ_OPERATIONS,
  sessionOperationRequestSchemas,
  sessionOperationResultSchema,
  sessionOperationSuccessSchemas,
  type SessionOperation,
} from "../../../src-shared/session/session-management-contract.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../memory/memory-runtime-exchange.js";
import {
  callWithMateMemoryRuntime,
  mapWithMateMemoryDiscoveryCode,
  resolveWithMateMemoryApi,
  resolveAgentRuntimeBindingReference,
  resolveAgentRuntimeTurnCapability,
  type WithMateMemoryRuntimeConnection,
} from "./withmate-memory-runtime-client.js";
export type SessionRuntimeClientDeps = Omit<
  Parameters<typeof resolveWithMateMemoryApi>[0],
  "adapter" | "signal"
> & {
  connection?: WithMateMemoryRuntimeConnection;
  runtimeCall?: typeof callWithMateMemoryRuntime;
  requestTimeoutMs?: number;
};
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
      "The Session response was not confirmed. Recover enqueue with get_receipt and its original requestId. Child creation and Coordination retries must keep the identical request and original requestId/operationId. A coordination_get can be repeated to recover its current state. Do not automatically resend mutations or invent new keys.",
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
      : await resolveWithMateMemoryApi({
          ...deps,
          adapter: "mcp",
          signal: controller.signal,
        });
    if (resolution.kind === "error")
      return {
        ok: false,
        code: mapWithMateMemoryDiscoveryCode(resolution.code),
        effect: "none",
        candidates: resolution.candidates,
      };
    sent = true;
    const response = await (deps.runtimeCall ?? callWithMateMemoryRuntime)(
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
