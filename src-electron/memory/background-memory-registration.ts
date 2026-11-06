import { createCharacterContextError } from "../../src-shared/character-context/character-context-contract.js";
import { createMemoryErrorResponse } from "../../src-shared/memory/memory-response-contract.js";
import { buildMemoryRegistrationInput, type MemoryRegistrationScope } from "../../src-shared/memory-recording/memory-registration-input.js";
import type { MemoryRecordingPurpose } from "../../src-shared/memory-recording/memory-recording-frequency.js";
import type { BackgroundRegistration, BackgroundRegistrationHandler } from "../providers/background-registration.js";
import type { BackgroundCallInput, BackgroundCallResult, BackgroundCallService } from "../providers/background-call-service.js";

/** The shared registration boundary has already captured and authorized this real conversation snapshot. */
function hasSavedTerminalEvidence({ scope, source }: Parameters<BackgroundRegistrationHandler>[0]): boolean {
  return source.turns.some((turn) => (scope.history.source.kind === "main"
    ? turn.sessionId === source.session.id && turn.auxiliarySessionId === undefined
    : turn.sessionId === null && turn.auxiliarySessionId === source.session.id)
    && (turn.phase === "completed" || turn.phase === "failed" || turn.phase === "canceled") && Boolean(turn.completedAt)
    && turn.assistantMessageSeq !== undefined && turn.assistantMessageSeq >= scope.history.fromMessageSeq
    && turn.assistantMessageSeq <= scope.history.throughMessageSeq);
}

export const backgroundMemoryRegistrationHandlers: Required<Pick<BackgroundRegistration["handlers"], MemoryRecordingPurpose>> = {
  "character-memory": (input, services) => {
    if (!hasSavedTerminalEvidence(input)) return createCharacterContextError("invalid_input", "No saved terminal Turn belongs to the authorized history.", {
      field: "history", retryable: false, conversationMayContinue: true, effect: "none",
    });
    if (!services.character) return createCharacterContextError("storage_unavailable", "Character registration is unavailable.", {
      retryable: false, conversationMayContinue: true, effect: "none",
    });
    const principal = { ...input.principal, sourceKind: input.scope.history.source.kind };
    return input.body && typeof input.body === "object" && "episodes" in input.body
      ? services.character.appendEpisodes(input.body, input.transport, principal)
      : services.character.appendEpisode(input.body, input.transport, principal);
  },
  "target-memory": (input, services) => {
    if (!hasSavedTerminalEvidence(input)) return createMemoryErrorResponse({ code: "MEMORY_INVALID_REQUEST",
      message: "No saved terminal Turn belongs to the authorized history.", field: "history", effect: "none" });
    const principal = { ...input.principal, sourceKind: input.scope.history.source.kind };
    return input.body && typeof input.body === "object" && "entries" in input.body
      ? services.memory.appendEntries(principal, input.body)
      : services.memory.append(principal, input.body);
  },
};

export type BackgroundMemoryRegistrationInput = Omit<BackgroundCallInput, "userInput" | "context"> & Readonly<{
  context: BackgroundCallInput["context"] & { scope: MemoryRegistrationScope };
  materials: string;
  characterDefinition?: string;
  instructionText?: string;
}>;

export function runBackgroundMemoryRegistration(
  calls: Pick<BackgroundCallService, "runOnce">,
  input: BackgroundMemoryRegistrationInput,
): Promise<BackgroundCallResult> {
  const { materials, characterDefinition, instructionText, ...call } = input;
  return calls.runOnce({ ...call, userInput: buildMemoryRegistrationInput({ scope: input.context.scope, materials, characterDefinition, instructionText }) });
}
