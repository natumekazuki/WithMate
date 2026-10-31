import type { FormInfo1 } from "@opencode/client";
import type { LiveElicitationRequest } from "../../../src-shared/session/runtime-state.js";
import { buildLiveElicitationFieldFromMcpSchema } from "../mcp-elicitation.js";

export function buildOpenCodeElicitation(form: FormInfo1, requestId: string): LiveElicitationRequest {
  const fields = form.fields.map((field) => {
    if (field.type === "external" || field.hidden || field.when?.length || ("pattern" in field && field.pattern)) {
      throw new Error(`Unsupported OpenCode form field: ${field.key}`);
    }
    const options = "options" in field ? field.options?.map((option) => ({
      value: option.value,
      label: option.description ? `${option.label} — ${option.description}` : option.label,
    })) : undefined;
    const schema = { ...field, type: field.type === "multiselect" ? "array" : field.type,
      ...(field.type === "string" && options ? { enum: options.map((option) => option.value), enumNames: options.map((option) => option.label) } : {}),
      ...(field.type === "multiselect" ? { items: field.custom && options?.length === 0 ? { enum: [] } : { anyOf: options?.map((option) => ({ const: option.value, title: option.label })) } } : {}) };
    for (const key of ["default", "minimum", "maximum"] as const) {
      const value = (schema as Record<string, unknown>)[key];
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Unsupported non-finite OpenCode form constraint");
    }
    const result = buildLiveElicitationFieldFromMcpSchema(field.key, schema, field.required ?? (form.metadata?.kind === "question"));
    if (!result) throw new Error(`Unsupported OpenCode form field: ${field.key}`);
    if (result.type === "select" && field.type === "string") {
      return { ...result, allowFreeText: field.custom === true, minLength: field.minLength, maxLength: field.maxLength, format: field.format };
    }
    if (result.type === "multi-select" && field.type === "multiselect") {
      return { ...result, allowFreeText: field.custom === true };
    }
    return result;
  });
  return { requestId, provider: "opencode", kind: "question", mode: "form", message: form.title, fields, blocking: true };
}
