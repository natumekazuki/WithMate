import type { AuditLogProviderMetadata } from "../src/runtime-state.js";

export type ProviderMetadataLogData = Omit<AuditLogProviderMetadata, "payload"> & {
  payloadPresent: boolean;
  payloadRedacted: boolean;
  payloadType?: string;
};

function describePayloadType(payload: unknown): string {
  if (payload === null) {
    return "null";
  }
  if (Array.isArray(payload)) {
    return "array";
  }
  return typeof payload;
}

export function toProviderMetadataLogData(metadata: AuditLogProviderMetadata): ProviderMetadataLogData {
  const payloadPresent = Object.prototype.hasOwnProperty.call(metadata, "payload");
  const payloadType = payloadPresent ? describePayloadType(metadata.payload) : undefined;
  return {
    provider: metadata.provider,
    kind: metadata.kind,
    summary: metadata.summary,
    ...(metadata.source ? { source: metadata.source } : {}),
    ...(metadata.responseType ? { responseType: metadata.responseType } : {}),
    ...(metadata.eventType ? { eventType: metadata.eventType } : {}),
    payloadPresent,
    payloadRedacted: payloadPresent,
    ...(payloadType ? { payloadType } : {}),
  };
}
