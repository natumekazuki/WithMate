import type { RunSessionTurnRequest } from "../src/app-state.js";
import type { TurnInitiator } from "../src/session-execution.js";

export type SessionExecutionTurnRequest = {
  initiator: Extract<TurnInitiator, { kind: "session" }> | null;
  catalogRevision: number;
  providerId: "codex" | "copilot";
  turn: RunSessionTurnRequest;
} | {
  initiator: Extract<TurnInitiator, { kind: "user" }>;
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
  const executionRequest = request as {
    source?: unknown;
    initiator?: unknown;
    catalogRevision?: unknown;
    turn?: unknown;
  };
  const initiator = parseInitiator(executionRequest.initiator);
  if (initiator?.kind === "user" || (initiator === undefined && executionRequest.source === "gui")) {
    return {
      initiator: { kind: "user" },
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
    initiator: initiator?.kind === "session" ? initiator : null,
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
  if (parsed.catalogRevision === null) {
    await validateGuiTurn?.(sessionId, parsed.turn);
    return {
      initiator: parsed.initiator,
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
    ...(parsed.initiator ? { initiator: parsed.initiator } : {}),
    catalogRevision: parsed.catalogRevision,
    turn: {
      provider: parsed.providerId,
      ...validatedTurn,
    },
  };
}

function parseInitiator(value: unknown): TurnInitiator | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Session execution initiator must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "user") {
    if (Object.keys(candidate).some((key) => key !== "kind")) {
      throw new TypeError("Session execution user initiator has an unknown field.");
    }
    return { kind: "user" };
  }
  if (candidate.kind !== "session") {
    throw new TypeError("Session execution initiator kind is invalid.");
  }
  if (Object.keys(candidate).some((key) => key !== "kind" && key !== "sessionId" && key !== "character")) {
    throw new TypeError("Session execution Session initiator has an unknown field.");
  }
  if (typeof candidate.sessionId !== "string" || !candidate.sessionId.trim()) {
    throw new TypeError("Session execution initiator Session ID is required.");
  }
  if (!candidate.character || typeof candidate.character !== "object" || Array.isArray(candidate.character)) {
    throw new TypeError("Session execution initiator character is required.");
  }
  const character = candidate.character as Record<string, unknown>;
  if (Object.keys(character).some((key) => !["characterId", "name", "iconFilePath"].includes(key))) {
    throw new TypeError("Session execution initiator character has an unknown field.");
  }
  if (typeof character.characterId !== "string" || !character.characterId.trim()) {
    throw new TypeError("Session execution initiator character ID is required.");
  }
  if (typeof character.name !== "string" || !character.name.trim()) {
    throw new TypeError("Session execution initiator character name is required.");
  }
  if (typeof character.iconFilePath !== "string") {
    throw new TypeError("Session execution initiator character icon path must be a string.");
  }
  return {
    kind: "session",
    sessionId: candidate.sessionId,
    character: {
      characterId: character.characterId,
      name: character.name,
      iconFilePath: character.iconFilePath,
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
