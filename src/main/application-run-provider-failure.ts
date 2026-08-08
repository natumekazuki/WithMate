import type { CodexAdapterMutationResult } from "./providers/codex/index.js";

export type ApplicationRunProviderMutationInterruption = "shutdown" | "transport" | null;

export type ApplicationRunProviderRuntimeStartupFailureKind =
  "configuration" | "capability" | "application" | "transport" | "process";

export class ApplicationRunProviderRuntimeStartupError extends Error {
  readonly failureKind: ApplicationRunProviderRuntimeStartupFailureKind;

  constructor(failureKind: ApplicationRunProviderRuntimeStartupFailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApplicationRunProviderRuntimeStartupError";
    this.failureKind = failureKind;
  }
}

export type ApplicationRunProviderRuntimeStartupFailure = Readonly<{
  outcomeKind: "failed" | "interrupted";
  failureOrigin: "transport" | "process" | "application";
  errorSummary: string;
}>;

export type ApplicationRunProviderMutationFailure = Readonly<{
  outcomeKind: "failed" | "interrupted";
  failureOrigin: "provider" | "transport" | "application" | "unknown";
  providerErrorCode: string | null;
}>;

export function classifyApplicationRunProviderRuntimeStartupFailure(
  error: unknown,
  shutdown: boolean,
): ApplicationRunProviderRuntimeStartupFailure {
  if (error instanceof ApplicationRunProviderRuntimeStartupError) {
    switch (error.failureKind) {
      case "configuration":
        return Object.freeze({
          outcomeKind: "failed",
          failureOrigin: "application",
          errorSummary: "Provider runtime configuration is invalid.",
        });
      case "capability":
        return Object.freeze({
          outcomeKind: "failed",
          failureOrigin: "application",
          errorSummary: "Provider runtime capability is unavailable.",
        });
      case "application":
        return Object.freeze({
          outcomeKind: "failed",
          failureOrigin: "application",
          errorSummary: "Provider runtime ownership is invalid.",
        });
      case "transport":
        return Object.freeze({
          outcomeKind: "interrupted",
          failureOrigin: shutdown ? "application" : "transport",
          errorSummary: shutdown
            ? "Application shutdown completed before Provider execution started."
            : "Provider transport ended during startup.",
        });
      case "process":
        return Object.freeze({
          outcomeKind: "interrupted",
          failureOrigin: shutdown ? "application" : "process",
          errorSummary: shutdown
            ? "Application shutdown completed before Provider execution started."
            : "Provider runtime startup was interrupted.",
        });
    }
  }
  return Object.freeze({
    outcomeKind: "interrupted",
    failureOrigin: shutdown ? "application" : "process",
    errorSummary: shutdown
      ? "Application shutdown completed before Provider execution started."
      : "Provider runtime startup failed before execution.",
  });
}

export function classifyApplicationRunProviderMutationFailure(
  result: Exclude<CodexAdapterMutationResult<unknown>, Readonly<{ kind: "accepted" }>>,
  interruption: ApplicationRunProviderMutationInterruption,
): ApplicationRunProviderMutationFailure {
  if (result.kind === "rejected") {
    return Object.freeze({
      outcomeKind: "failed",
      failureOrigin: "provider",
      providerErrorCode: String(result.code),
    });
  }
  if (result.kind === "ambiguous") {
    return Object.freeze({
      outcomeKind: "interrupted",
      failureOrigin: "unknown",
      providerErrorCode: null,
    });
  }
  if (result.kind === "connection_failure") {
    return Object.freeze({
      outcomeKind: "interrupted",
      failureOrigin: "transport",
      providerErrorCode: null,
    });
  }

  switch (result.code) {
    case "invalid_input":
    case "pending_limit":
    case "invalid_request":
    case "server_request_settled":
    case "event_waiter_exists":
      return Object.freeze({
        outcomeKind: "failed",
        failureOrigin: "application",
        providerErrorCode: null,
      });
  }
  if (interruption === "shutdown") {
    return Object.freeze({
      outcomeKind: "interrupted",
      failureOrigin: "application",
      providerErrorCode: null,
    });
  }
  if (interruption === "transport") {
    return Object.freeze({
      outcomeKind: "interrupted",
      failureOrigin: "transport",
      providerErrorCode: null,
    });
  }
  if (result.code === "capability_unavailable") {
    return Object.freeze({
      outcomeKind: "failed",
      failureOrigin: "application",
      providerErrorCode: null,
    });
  }
  return Object.freeze({
    outcomeKind: "interrupted",
    failureOrigin: "transport",
    providerErrorCode: null,
  });
}
