import type { FormInfo1 } from "@opencode/client";
import type { LiveElicitationRequest } from "../../../src-shared/session/runtime-state.js";
import { buildLiveElicitationFieldFromMcpSchema } from "../mcp-elicitation.js";

export function buildOpenCodeElicitation(form: FormInfo1, requestId: string): LiveElicitationRequest {
  const fields = form.fields.map((field) => {
    if (field.type === "external" || field.hidden || field.when?.length || ("custom" in field && field.custom) || ("pattern" in field && field.pattern)) {
      throw new Error(`Unsupported OpenCode form field: ${field.key}`);
    }
    const schema = { ...field, type: field.type === "multiselect" ? "array" : field.type,
      ...(field.type === "string" && field.options ? { enum: field.options.map((option) => option.value), enumNames: field.options.map((option) => option.label) } : {}),
      ...(field.type === "multiselect" ? { items: { anyOf: field.options.map((option) => ({ const: option.value, title: option.label })) } } : {}) };
    for (const key of ["default", "minimum", "maximum"] as const) {
      const value = (schema as Record<string, unknown>)[key];
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Unsupported non-finite OpenCode form constraint");
    }
    const result = buildLiveElicitationFieldFromMcpSchema(field.key, schema, field.required ?? false);
    if (!result) throw new Error(`Unsupported OpenCode form field: ${field.key}`);
    return result;
  });
  return { requestId, provider: "opencode", kind: "question", mode: "form", message: form.title, fields, blocking: true };
}
