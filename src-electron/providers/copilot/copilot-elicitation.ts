import type { SessionEvent } from "@github/copilot-sdk";
import type { LiveElicitationField, LiveElicitationRequest } from "../../../src-shared/session/runtime-state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length ? items : undefined;
}
function options(values: string[] | undefined, labels?: string[]) {
  return (values ?? []).map((value, index) => ({ value, label: labels?.[index]?.trim() || value }));
}

export function buildLiveElicitationFieldFromCopilotSchema(name: string, schema: unknown, required: boolean): LiveElicitationField | null {
  if (!isRecord(schema)) return null;
  const title = typeof schema.title === "string" && schema.title.trim() ? schema.title.trim() : name;
  const description = typeof schema.description === "string" && schema.description.trim() ? schema.description.trim() : undefined;
  if (schema.type === "string") {
    const enumValues = toStringArray(schema.enum);
    if (enumValues) return { type: "select", name, title, description, required, options: options(enumValues, toStringArray(schema.enumNames)), defaultValue: typeof schema.default === "string" ? schema.default : undefined };
    if (Array.isArray(schema.oneOf)) {
      const values = schema.oneOf.filter((item): item is { const: string; title: string } => isRecord(item) && typeof item.const === "string" && typeof item.title === "string").map((item) => ({ value: item.const, label: item.title }));
      if (values.length) return { type: "select", name, title, description, required, options: values, defaultValue: typeof schema.default === "string" ? schema.default : undefined };
    }
    return { type: "text", name, title, description, required, defaultValue: typeof schema.default === "string" ? schema.default : undefined, minLength: typeof schema.minLength === "number" ? schema.minLength : undefined, maxLength: typeof schema.maxLength === "number" ? schema.maxLength : undefined, format: schema.format === "email" || schema.format === "uri" || schema.format === "date" || schema.format === "date-time" ? schema.format : undefined };
  }
  if (schema.type === "array" && isRecord(schema.items)) {
    const enumValues = toStringArray(schema.items.enum);
    if (enumValues) return { type: "multi-select", name, title, description, required, options: options(enumValues), defaultValue: toStringArray(schema.default), minItems: typeof schema.minItems === "number" ? schema.minItems : undefined, maxItems: typeof schema.maxItems === "number" ? schema.maxItems : undefined };
    if (Array.isArray(schema.items.anyOf)) {
      const values = schema.items.anyOf.filter((item): item is { const: string; title: string } => isRecord(item) && typeof item.const === "string" && typeof item.title === "string").map((item) => ({ value: item.const, label: item.title }));
      if (values.length) return { type: "multi-select", name, title, description, required, options: values, defaultValue: toStringArray(schema.default), minItems: typeof schema.minItems === "number" ? schema.minItems : undefined, maxItems: typeof schema.maxItems === "number" ? schema.maxItems : undefined };
    }
  }
  if (schema.type === "boolean") return { type: "boolean", name, title, description, required, defaultValue: typeof schema.default === "boolean" ? schema.default : undefined };
  if (schema.type === "number" || schema.type === "integer") return { type: "number", numberKind: schema.type, name, title, description, required, defaultValue: typeof schema.default === "number" ? schema.default : undefined, minimum: typeof schema.minimum === "number" ? schema.minimum : undefined, maximum: typeof schema.maximum === "number" ? schema.maximum : undefined };
  return null;
}

export function buildLiveElicitationRequestFromCopilotEvent(providerId: string, event: Extract<SessionEvent, { type: "elicitation.requested" }>): LiveElicitationRequest {
  const requiredNames = new Set(Array.isArray(event.data.requestedSchema?.required) ? event.data.requestedSchema.required : []);
  const properties = isRecord(event.data.requestedSchema?.properties) ? event.data.requestedSchema.properties : {};
  const fields = Object.entries(properties).map(([name, schema]) => buildLiveElicitationFieldFromCopilotSchema(name, schema, requiredNames.has(name))).filter((field): field is LiveElicitationField => field !== null);
  return { requestId: event.data.requestId, provider: providerId, mode: event.data.mode === "url" ? "url" : "form", message: event.data.message, source: event.data.elicitationSource, fields, url: typeof event.data.url === "string" ? event.data.url : undefined };
}
