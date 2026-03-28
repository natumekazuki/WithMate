import type { AuditTransportPayload } from "../src/app-state.js";

export function appendTransportPayloadFields(
  payload: AuditTransportPayload | null,
  fields: Array<{ label: string; value: string | null | undefined }>,
): AuditTransportPayload | null {
  if (!payload) {
    return payload;
  }

  const normalizedFields = fields
    .filter((field) => field.value !== null && field.value !== undefined && String(field.value).trim().length > 0)
    .map((field) => ({ label: field.label, value: String(field.value) }));
  if (normalizedFields.length === 0) {
    return payload;
  }

  return {
    ...payload,
    fields: [...payload.fields, ...normalizedFields],
  };
}

export function calculateAuditDurationMs(createdAt: string, completedAt: string): number | null {
  const startedAt = Date.parse(createdAt);
  const endedAt = Date.parse(completedAt);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt)) {
    return null;
  }

  return Math.max(0, endedAt - startedAt);
}
