export type StorageWorkerGeneration = {
  id: string;
};

export type StorageWorkerRequestContext = {
  requestId: string;
  generationId: string;
};

export type StorageWorkerCallRequest = {
  type: "call";
  context: StorageWorkerRequestContext;
  command: string;
  payload: unknown;
  mutation: boolean;
};

export type StorageWorkerShutdownRequest = {
  type: "shutdown";
  requestId: string;
};

export type StorageWorkerRequest = StorageWorkerCallRequest | StorageWorkerShutdownRequest;

export function isStorageWorkerCallRequest(value: unknown): value is StorageWorkerCallRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<StorageWorkerCallRequest>;
  const context = request.context;
  return request.type === "call"
    && typeof request.command === "string"
    && typeof request.mutation === "boolean"
    && Boolean(context && typeof context === "object"
      && typeof context.requestId === "string"
      && typeof context.generationId === "string");
}

export function isStorageWorkerShutdownRequest(value: unknown): value is StorageWorkerShutdownRequest {
  return Boolean(value && typeof value === "object"
    && (value as Partial<StorageWorkerShutdownRequest>).type === "shutdown"
    && typeof (value as Partial<StorageWorkerShutdownRequest>).requestId === "string");
}

export type StorageWorkerReadyMessage = {
  type: "ready";
  generationId: string;
};

export type StorageWorkerResultMessage = {
  type: "result";
  requestId: string;
  generationId: string;
  value: unknown;
  timing?: StorageWorkerTiming;
};

export type StorageWorkerErrorMessage = {
  type: "error";
  requestId: string;
  generationId: string;
  name: string;
  message: string;
  code?: string;
  outcome?: "not-executed" | "rejected" | "unknown";
  stack?: string;
  details?: Record<string, string | number>;
  timing?: StorageWorkerTiming;
};

export type StorageWorkerTiming = {
  queueWaitMs: number;
  executionMs: number;
};

export type StorageWorkerStartedMessage = {
  type: "started";
  requestId: string;
  generationId: string;
  queueWaitMs: number;
};

export type StorageWorkerProgressMessage = {
  type: "progress";
  requestId: string;
  generationId: string;
  progress: unknown;
};

export type StorageWorkerShutdownMessage = {
  type: "shutdown-complete";
  requestId: string;
  generationId: string;
};

export type StorageWorkerMessage =
  | StorageWorkerReadyMessage
  | StorageWorkerResultMessage
  | StorageWorkerStartedMessage
  | StorageWorkerErrorMessage
  | StorageWorkerProgressMessage
  | StorageWorkerShutdownMessage;

export type StorageWorkerEntryData = {
  generationId: string;
  handlerModule: string;
  handlerExport?: string;
  dbPath?: string;
  bundledModelCatalogPath?: string;
  userDataPath?: string;
};

export function isStorageWorkerMessage(value: unknown): value is StorageWorkerMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  const type = message.type;
  if (typeof type !== "string" || typeof message.generationId !== "string" || message.generationId.length === 0) {
    return false;
  }
  if (type === "ready") return true;
  if (type === "result") return typeof message.requestId === "string" && message.requestId.length > 0;
  if (type === "error") {
    return typeof message.requestId === "string" && message.requestId.length > 0
      && typeof message.name === "string" && typeof message.message === "string"
      && (message.outcome === undefined || message.outcome === "not-executed" || message.outcome === "rejected" || message.outcome === "unknown");
  }
  if (type === "progress") return typeof message.requestId === "string" && message.requestId.length > 0;
  if (type === "started") {
    return typeof message.requestId === "string" && message.requestId.length > 0
      && typeof message.queueWaitMs === "number" && Number.isFinite(message.queueWaitMs);
  }
  if (type === "shutdown-complete") return typeof message.requestId === "string" && message.requestId.length > 0;
  return false;
}
