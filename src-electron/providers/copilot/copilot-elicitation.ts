import type { SessionEvent } from "@github/copilot-sdk";
import type { LiveElicitationField, LiveElicitationRequest } from "../../../src-shared/session/runtime-state.js";
import { buildLiveElicitationFieldFromMcpSchema } from "../mcp-elicitation.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildLiveElicitationRequestFromCopilotEvent(providerId: string, event: Extract<SessionEvent, { type: "elicitation.requested" }>): LiveElicitationRequest {
  const requiredNames = new Set(Array.isArray(event.data.requestedSchema?.required) ? event.data.requestedSchema.required : []);
  const properties = isRecord(event.data.requestedSchema?.properties) ? event.data.requestedSchema.properties : {};
  const fields = Object.entries(properties).map(([name, schema]) => buildLiveElicitationFieldFromMcpSchema(name, schema, requiredNames.has(name))).filter((field): field is LiveElicitationField => field !== null);
  return { requestId: event.data.requestId, provider: providerId, mode: event.data.mode === "url" ? "url" : "form", message: event.data.message, source: event.data.elicitationSource, fields, url: typeof event.data.url === "string" ? event.data.url : undefined };
}
