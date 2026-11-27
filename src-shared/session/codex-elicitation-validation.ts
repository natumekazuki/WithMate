import { regexes } from "zod";
import type { LiveElicitationField } from "./runtime-state.js";

const mcpDateTimePattern = regexes.datetime({ offset: true });

/** Validate the submitted value, not the editor draft. Omission is allowed only for optional fields. */
export function isValidCodexElicitationField(field: LiveElicitationField, value: unknown): boolean {
  if (value === undefined) return !field.required;
  switch (field.type) {
    case "text": {
      if (typeof value !== "string" || (field.required && !value.trim())) return false;
      const length = [...value].length;
      if ((field.minLength !== undefined && length < field.minLength) || (field.maxLength !== undefined && length > field.maxLength)) return false;
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
      if (field.format === "uri" && !URL.canParse(value)) return false;
      if (field.format === "date" && !regexes.date.test(value)) return false;
      if (field.format === "date-time" && !mcpDateTimePattern.test(value.toUpperCase())) return false;
      return true;
    }
    case "select": return typeof value === "string" && Boolean(value.trim()) && (field.allowFreeText === true || field.options.some((option) => option.value === value));
    case "multi-select": return Array.isArray(value) && new Set(value).size === value.length && (!field.required || value.length > 0)
      && (field.minItems === undefined || value.length >= field.minItems) && (field.maxItems === undefined || value.length <= field.maxItems)
      && value.every((item) => typeof item === "string" && Boolean(item.trim()) && (field.allowFreeText === true || field.options.some((option) => option.value === item)));
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value) && (field.numberKind !== "integer" || Number.isInteger(value))
      && (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum);
  }
}

/** Check the full response at the boundary that accepts a Codex form answer. */
export function isValidCodexElicitationContent(fields: LiveElicitationField[], content: unknown): boolean {
  const values = content === undefined ? {} : content;
  if (values === null || typeof values !== "object" || Array.isArray(values)) return false;
  const record = values as Record<string, unknown>;
  return Object.keys(record).every((name) => fields.some((field) => field.name === name))
    && fields.every((field) => isValidCodexElicitationField(field, Object.hasOwn(record, field.name) ? record[field.name] : undefined));
}
