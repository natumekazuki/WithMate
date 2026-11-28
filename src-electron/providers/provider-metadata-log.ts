import type { ProviderDiagnosticMetadata } from "../../src-shared/session/runtime-state.js";

/** プロバイダー診断向けのメタデータ。ペイロードは値を保持せず、有無と型だけを残せる。 */
export type ProviderMetadataLogData = Omit<
  ProviderDiagnosticMetadata,
  "payload"
> & {
  payloadPresent: boolean;
  payloadRedacted: boolean;
  payloadType?: string;
};

/** null と配列を一般のオブジェクトと区別し、他の値には typeof の分類を使う。 */
function describePayloadType(payload: unknown): string {
  if (payload === null) {
    return "null";
  }
  if (Array.isArray(payload)) {
    return "array";
  }
  return typeof payload;
}

/** 診断用に必要な分類を抜き出す。ペイロードの明示的な undefined とプロパティの省略を区別し、値自体は書き出さない。 */
export function toProviderMetadataLogData(
  metadata: ProviderDiagnosticMetadata,
): ProviderMetadataLogData {
  const payloadPresent = Object.prototype.hasOwnProperty.call(
    metadata,
    "payload",
  );
  const payloadType = payloadPresent
    ? describePayloadType(metadata.payload)
    : undefined;
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
