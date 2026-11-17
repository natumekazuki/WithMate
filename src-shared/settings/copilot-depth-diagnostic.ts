const PUBLIC_MODEL_ID = /^(?:claude-(?:opus|sonnet|haiku)-\d{1,2}(?:[.-]\d{1,2}){1,2}|gpt-\d{1,2}(?:[.-]\d{1,2}){0,2}(?:-codex)?)$/i;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

// Provider configuration can contain arbitrary strings; do not copy them into logs.
export function diagnosticModelId(value: unknown): string | null {
  return typeof value === "string" && value.length <= 64 && PUBLIC_MODEL_ID.test(value) ? value : null;
}

export function diagnosticEfforts(value: unknown): { shape: string; values: string[]; otherCount: number } {
  if (!Array.isArray(value)) return { shape: value === undefined ? "missing" : "invalid", values: [], otherCount: 0 };
  const values = value.filter((item): item is string => typeof item === "string" && EFFORTS.has(item));
  return { shape: "array", values: [...new Set(values)], otherCount: value.length - values.length };
}

export function diagnosticBoolean(value: unknown): string {
  return value === true ? "true" : value === false ? "false" : value === undefined ? "missing" : "invalid";
}
