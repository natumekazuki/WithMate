import type { RunSessionTurnRequest } from "../src/app-state.js";

export type SessionExecutionTurnRequest = {
  catalogRevision: number;
  providerId: "codex" | "copilot";
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
  const executionRequest = request as { catalogRevision?: unknown; turn?: unknown };
  if (!Number.isSafeInteger(executionRequest.catalogRevision) || (executionRequest.catalogRevision as number) < 1) {
    throw new TypeError("Session execution catalogRevision must be a positive integer.");
  }
  if (typeof executionRequest.turn !== "object" || executionRequest.turn === null) {
    throw new TypeError("Session execution turn must be an object.");
  }
  const candidate = executionRequest.turn as Partial<Record<keyof RunSessionTurnRequest | "provider", unknown>>;
  if (candidate.provider !== "codex" && candidate.provider !== "copilot") {
    throw new TypeError("Session execution provider must be codex or copilot.");
  }
  if (typeof candidate.userMessage !== "string") {
    throw new TypeError("Session execution userMessage must be a string.");
  }
  for (const key of ["model", "reasoningEffort", "approvalMode", "codexSandboxMode", "customAgentName"] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") {
      throw new TypeError(`Session execution ${key} must be a string.`);
    }
  }
  return {
    catalogRevision: executionRequest.catalogRevision as number,
    providerId: candidate.provider,
    turn: {
      userMessage: candidate.userMessage,
      model: candidate.model,
      reasoningEffort: candidate.reasoningEffort,
      approvalMode: candidate.approvalMode,
      codexSandboxMode: candidate.codexSandboxMode,
      customAgentName: candidate.customAgentName,
      attachments: Array.isArray(candidate.attachments)
        ? candidate.attachments.map((attachment) => ({ ...(attachment as object) }))
        : undefined,
    } as RunSessionTurnRequest,
  };
}

export async function validateSessionExecutionTurnRequest(
  sessionId: string,
  request: unknown,
  validateTurn: ValidateSessionExecutionTurn,
): Promise<unknown> {
  const parsed = parseSessionExecutionTurnRequest(request);
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
