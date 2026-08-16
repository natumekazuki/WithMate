import type { RunSessionTurnRequest } from "../src/app-state.js";

export type SessionExecutionTurnRequest = {
  source: "external";
  catalogRevision: number;
  providerId: "codex" | "copilot";
  turn: RunSessionTurnRequest;
} | {
  source: "gui";
  catalogRevision: null;
  providerId: null;
  turn: RunSessionTurnRequest;
};

export type ValidateSessionExecutionTurn = (
  sessionId: string,
  catalogRevision: number,
  turn: RunSessionTurnRequest,
  providerId: "codex" | "copilot",
) => Promise<RunSessionTurnRequest> | RunSessionTurnRequest;

export function parseSessionExecutionTurnRequest(request: unknown): SessionExecutionTurnRequest {
  if (typeof request !== "object" || request === null) {
    throw new TypeError("Session execution request must be an object.");
  }
  const executionRequest = request as { source?: unknown; catalogRevision?: unknown; turn?: unknown };
  if (executionRequest.source === "gui") {
    return {
      source: "gui",
      catalogRevision: null,
      providerId: null,
      turn: parseTurn(executionRequest.turn),
    };
  }
  if (!Number.isSafeInteger(executionRequest.catalogRevision) || (executionRequest.catalogRevision as number) < 1) {
    throw new TypeError("Session execution catalogRevision must be a positive integer.");
  }
  const candidate = requireTurn(executionRequest.turn);
  if (candidate.provider !== "codex" && candidate.provider !== "copilot") {
    throw new TypeError("Session execution provider must be codex or copilot.");
  }
  return {
    source: "external",
    catalogRevision: executionRequest.catalogRevision as number,
    providerId: candidate.provider,
    turn: parseTurn(executionRequest.turn),
  };
}

export async function validateSessionExecutionTurnRequest(
  sessionId: string,
  request: unknown,
  validateTurn: ValidateSessionExecutionTurn,
  validateGuiTurn?: (sessionId: string, turn: RunSessionTurnRequest) => Promise<void> | void,
): Promise<unknown> {
  const parsed = parseSessionExecutionTurnRequest(request);
  if (parsed.source === "gui") {
    await validateGuiTurn?.(sessionId, parsed.turn);
    return {
      source: "gui",
      turn: parsed.turn,
    };
  }
  const validatedTurn = await validateTurn(
    sessionId,
    parsed.catalogRevision,
    parsed.turn,
    parsed.providerId,
  );
  return {
    catalogRevision: parsed.catalogRevision,
    turn: {
      provider: parsed.providerId,
      ...validatedTurn,
    },
  };
}

function requireTurn(value: unknown): Partial<Record<keyof RunSessionTurnRequest | "provider", unknown>> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Session execution turn must be an object.");
  }
  return value as Partial<Record<keyof RunSessionTurnRequest | "provider", unknown>>;
}

function parseTurn(value: unknown): RunSessionTurnRequest {
  const candidate = requireTurn(value);
  if (typeof candidate.userMessage !== "string") {
    throw new TypeError("Session execution userMessage must be a string.");
  }
  for (const key of [
    "clientRequestId",
    "submitSource",
    "model",
    "reasoningEffort",
    "approvalMode",
    "codexSandboxMode",
    "customAgentName",
  ] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
      throw new TypeError(`Session execution ${key} must be a string.`);
    }
  }
  return {
    userMessage: candidate.userMessage,
    clientRequestId: candidate.clientRequestId as string | undefined,
    submitSource: candidate.submitSource as RunSessionTurnRequest["submitSource"],
    model: candidate.model as string | undefined,
    reasoningEffort: candidate.reasoningEffort as RunSessionTurnRequest["reasoningEffort"],
    approvalMode: candidate.approvalMode as RunSessionTurnRequest["approvalMode"],
    codexSandboxMode: candidate.codexSandboxMode as RunSessionTurnRequest["codexSandboxMode"],
    customAgentName: candidate.customAgentName as string | undefined,
    attachments: Array.isArray(candidate.attachments)
      ? candidate.attachments.map((attachment) => ({ ...(attachment as object) })) as RunSessionTurnRequest["attachments"]
      : undefined,
  };
}
