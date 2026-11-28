import type { SessionTarget } from "./session-target.js";

/** Saved Main or Auxiliary identity; the latter includes its owning Main incarnation. */
export type SessionInstructionsTarget = SessionTarget;

/** Maximum UTF-8 byte length of the entire saved body, including whitespace. */
export const SESSION_INSTRUCTIONS_MAX_BYTES = 8192;

const utf8 = new TextEncoder();

/** Measures the unmodified body using the same encoding in the renderer and storage. */
export function sessionInstructionsByteLength(body: string): number {
  return utf8.encode(body).byteLength;
}

/** Rejects invalid bodies without truncating or normalizing their content. */
export function validateSessionInstructions(body: unknown): string {
  // Reject non-text input before encoding it.
  if (typeof body !== "string") {
    throw new TypeError("Session instructions must be text.");
  }
  // Count the original text, not its JSON representation or a trimmed value.
  if (sessionInstructionsByteLength(body) > SESSION_INSTRUCTIONS_MAX_BYTES) {
    throw new RangeError("Session instructions exceed the 8,192-byte limit.");
  }
  return body;
}
