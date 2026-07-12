export const PERSISTENCE_PROTOCOL_VERSION = 1 as const;

export type PersistenceProtocolVersion = typeof PERSISTENCE_PROTOCOL_VERSION;

export type PersistenceRequestEnvelope<TType extends string, TPayload> = Readonly<{
  protocolVersion: PersistenceProtocolVersion;
  requestId: string;
  type: TType;
  payload: TPayload;
}>;

export type PersistenceSuccessEnvelope<TResult> = Readonly<{
  protocolVersion: PersistenceProtocolVersion;
  requestId: string;
  ok: true;
  result: TResult;
}>;

export type PersistenceFailureEnvelope = Readonly<{
  protocolVersion: PersistenceProtocolVersion;
  requestId: string;
  ok: false;
  error: Readonly<{
    code: string;
    message: string;
    retryable: boolean;
  }>;
}>;

export type PersistenceResponseEnvelope<TResult> = PersistenceSuccessEnvelope<TResult> | PersistenceFailureEnvelope;
