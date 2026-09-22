export const GLOSSARY_SCHEMA_VERSION = 1 as const;
export const GLOSSARY_RUNTIME_SCHEMA_VERSION = "withmate-glossary-v1" as const;
export const GLOSSARY_RELATIVE_PATH = ".withmate/glossary.yaml";

export const GLOSSARY_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxEntries: 2_000,
  maxBatchEntries: 100,
  maxTermCodePoints: 200,
  maxAliasesPerEntry: 20,
  maxDefinitionCodePoints: 50_000,
  maxQueryCodePoints: 500,
  maxPageSize: 200,
} as const;

const GLOSSARY_LOOKUP_WHITESPACE_PATTERN = /\s+/gu;

export function normalizeGlossaryLookup(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(GLOSSARY_LOOKUP_WHITESPACE_PATTERN, " ")
    .trim();
}

export type GlossaryEntryInput = {
  term: string;
  aliases?: readonly string[];
  definition: string;
};

export type GlossaryEntry = {
  term: string;
  aliases: string[];
  definition: string;
};

export type GlossaryValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type GlossarySnapshot =
  | {
      status: "missing";
      relativePath: typeof GLOSSARY_RELATIVE_PATH;
      revision: null;
    }
  | {
      status: "valid";
      relativePath: typeof GLOSSARY_RELATIVE_PATH;
      revision: string;
      entries: GlossaryEntry[];
    }
  | {
      status: "invalid";
      relativePath: typeof GLOSSARY_RELATIVE_PATH;
      revision: string;
      issues: GlossaryValidationIssue[];
    }
  | {
      status: "unsupported";
      relativePath: typeof GLOSSARY_RELATIVE_PATH;
      revision: string;
      schemaVersion: number | string | null;
      issues: GlossaryValidationIssue[];
    };

export type GlossaryWatchErrorState = {
  status: "watch-error";
  relativePath: typeof GLOSSARY_RELATIVE_PATH;
  revision: null;
  message: string;
};

export type GlossaryProjectionState = GlossarySnapshot | GlossaryWatchErrorState;

export type GlossaryCheckoutSummary = {
  repositoryName: string;
  branch: string;
  pathLabel: string;
};

export type SessionGlossaryProjection = {
  sessionId: string;
  scopeRevision: string;
  sequence: number;
  checkout: GlossaryCheckoutSummary;
  state: GlossaryProjectionState;
};

export type GlossaryEffect = "applied" | "none" | "unknown";
export type GlossaryMutationOutcome = "applied" | "converged";

export type GlossaryOperationErrorCode =
  | "GLOSSARY_INVALID_REQUEST"
  | "GLOSSARY_LIMIT_EXCEEDED"
  | "GLOSSARY_NOT_FOUND"
  | "GLOSSARY_CONFLICT"
  | "GLOSSARY_INVALID_FILE"
  | "GLOSSARY_UNSUPPORTED_SCHEMA"
  | "GLOSSARY_TARGET_INVALID"
  | "GLOSSARY_TARGET_CHANGED"
  | "GLOSSARY_EFFECT_UNKNOWN"
  | "GLOSSARY_IO_ERROR"
  | "GLOSSARY_SESSION_BINDING_REQUIRED"
  | "GLOSSARY_SESSION_BINDING_INVALID"
  | "GLOSSARY_SESSION_BINDING_FORBIDDEN"
  | "GLOSSARY_CHECKOUT_NOT_FOUND"
  | "GLOSSARY_RUNTIME_UNAVAILABLE"
  | "GLOSSARY_RUNTIME_INSTANCE_MISMATCH"
  | "GLOSSARY_RUNTIME_GENERATION_CHANGED"
  | "GLOSSARY_RUNTIME_AMBIGUOUS"
  | "GLOSSARY_RUNTIME_STALE"
  | "GLOSSARY_RUNTIME_REGISTRY_CAPACITY"
  | "GLOSSARY_RUNTIME_SELECTOR_INVALID"
  | "GLOSSARY_RUNTIME_CREDENTIAL_UNAVAILABLE"
  | "GLOSSARY_TRANSPORT_ERROR";

export type GlossaryCheckoutSelector =
  | { kind: "primary" }
  | { kind: "checkout"; checkoutId: string };

export type GlossaryCheckoutTarget = {
  checkoutId: string;
  selector: Extract<GlossaryCheckoutSelector, { kind: "checkout" }>;
  isPrimary: true;
  repositoryName: string;
  branch: string;
  pathLabel: string;
};

export type GlossaryRuntimeEnvelope<T> = T & {
  schemaVersion: typeof GLOSSARY_RUNTIME_SCHEMA_VERSION;
};

export type GlossaryOperationError = {
  ok: false;
  code: GlossaryOperationErrorCode;
  message: string;
  effect: GlossaryEffect;
  retryable: boolean;
  issues?: GlossaryValidationIssue[];
  details?: Record<string, unknown>;
};

export type GlossaryListResult = {
  ok: true;
  revision: string | null;
  entries: GlossaryEntry[];
  total: number;
  offset: number;
  pageSize: number;
};

export type GlossaryGetResult = {
  ok: true;
  revision: string;
  matchedText: string;
  entry: GlossaryEntry;
};

export type GlossaryValidationResult = {
  ok: true;
  snapshot: GlossarySnapshot;
};

export type GlossaryMutationResult = {
  ok: true;
  outcome: GlossaryMutationOutcome;
  effect: Extract<GlossaryEffect, "applied" | "none">;
  revision: string | null;
  entries: GlossaryEntry[];
};

export type GlossaryOperationResult<T> = T | GlossaryOperationError;

export type GlossaryCreateMode = "explicit" | "proactive";

export type GlossaryCreateRequest = {
  mode: GlossaryCreateMode;
  entry: GlossaryEntryInput;
  proactiveCreateLimit?: number | null;
};

export type GlossaryCreateBatchRequest = {
  mode: GlossaryCreateMode;
  entries: readonly GlossaryEntryInput[];
  proactiveCreateLimit?: number | null;
};

export type GlossaryUpdateRequest = {
  expectedRevision: string;
  targetTerm: string;
  entry: GlossaryEntryInput;
};

export type GlossaryDeleteRequest = {
  expectedRevision: string;
  targetTerm: string;
};

export type GlossaryPageRequest = {
  offset?: number;
  pageSize?: number;
};

export type GlossarySearchRequest = GlossaryPageRequest & {
  query: string;
};
