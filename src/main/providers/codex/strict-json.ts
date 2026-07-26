import { parseStrictJson as parseSharedStrictJson, StrictJsonError } from "../../../shared/strict-json.js";
import { CodexWireProtocolError } from "./wire-envelope.js";

export function parseStrictJson(text: string): unknown {
  try {
    return parseSharedStrictJson(text);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new CodexWireProtocolError(error.code === "invalid_json" ? "malformed_json" : "invalid_envelope");
    }
    throw error;
  }
}
