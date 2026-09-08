export const RESOURCE_BUDGET_CONTRACT_REVISION = 1 as const;

export const RESOURCE_BUDGET_DIMENSIONS = [
  "concurrentTurns",
  "queuedTurns",
  "totalTurns",
  "retries",
  "sessions",
  "workItems",
  "delegations",
  "storageBytes",
] as const;
export type ResourceBudgetDimension = (typeof RESOURCE_BUDGET_DIMENSIONS)[number];

export const RESOURCE_BUDGET_DEFAULT_HARD_LIMITS = {
  concurrentTurns: 4,
  queuedTurns: 100,
  totalTurns: 1_000,
  retries: 100,
  sessions: 100,
  workItems: 500,
  delegations: 500,
  storageBytes: 1_073_741_824,
} as const satisfies ResourceBudgetAmounts;
export const RESOURCE_BUDGET_RETRY_PER_EXECUTION_LIMIT = 3;
export const RESOURCE_BUDGET_DEFAULT_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;
export const RESOURCE_BUDGET_DEFAULT_LIST_LIMIT = 50;
export const RESOURCE_BUDGET_MAX_LIST_LIMIT = 500;

export type ResourceBudgetAmounts = Readonly<Record<ResourceBudgetDimension, number>>;
export type ResourceBudgetPartialAmounts = Readonly<Partial<Record<ResourceBudgetDimension, number>>>;
export type ResourceBudgetAccountKind = "root" | "session";
export type ResourceBudgetUsageConfidence = "unknown" | "estimated" | "reported" | "settled";

export type ResourceBudgetDimensionState = Readonly<{
  hardLimit: number;
  softLimit: number | null;
  committed: number;
  reserved: number;
  allocatedToChildren: number;
  available: number;
  softLimitExceeded: boolean;
  measurement: "known" | "unknown";
  unknownSince: string | null;
}>;

export type ResourceBudgetMeteredUsage = Readonly<{
  usageId: string;
  executionId: string | null;
  providerGenerationId: string | null;
  reservationId: string | null;
  unit: "tokens" | "monetary_cost" | "provider_usage";
  amount: number | null;
  currency: string | null;
  confidence: ResourceBudgetUsageConfidence;
  observedAt: string;
}>;

export type ResourceBudgetMeteredUsageSummary = Readonly<{
  knownTokens: number;
  knownProviderUsage: number;
  monetaryCostByCurrency: Readonly<Record<string, number>>;
  unknownRecords: Readonly<Record<ResourceBudgetMeteredUsage["unit"], number>>;
}>;

export type ResourceBudgetAlert = Readonly<{
  dimension: ResourceBudgetDimension;
  softLimit: number;
  usage: number;
}>;

export type ResourceBudget = Readonly<{
  contractRevision: typeof RESOURCE_BUDGET_CONTRACT_REVISION;
  accountId: string;
  accountKind: ResourceBudgetAccountKind;
  rootSessionId: string;
  ownerSessionId: string;
  appliesToSessionId: string;
  allocationSource: "owned" | "root_shared";
  rootManagedDimensions: readonly ResourceBudgetDimension[];
  parentAccountId: string | null;
  authorityGrantId: string | null;
  authorityGrantRevision: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
  deadlineAt: string;
  retryPerExecutionLimit: number;
  revision: number;
  dimensions: Readonly<Record<ResourceBudgetDimension, ResourceBudgetDimensionState>>;
  alerts: readonly ResourceBudgetAlert[];
  meteredUsage: readonly ResourceBudgetMeteredUsage[];
  meteredUsageTruncated: boolean;
  meteredUsageSummary: ResourceBudgetMeteredUsageSummary;
  createdAt: string;
  updatedAt: string;
}>;

export type ResourceBudgetGetInput = Readonly<{ sessionId: string }>;
export type ResourceBudgetListInput = Readonly<{
  sessionId: string;
  limit: number;
  cursor?: string;
}>;
export type ResourceBudgetListResult = Readonly<{
  items: readonly ResourceBudget[];
  nextCursor?: string;
}>;

export type ResourceBudgetConfigureInput = Readonly<{
  sessionId: string;
  accountId: string;
  expectedRevision: number;
  hardLimits?: ResourceBudgetPartialAmounts;
  softLimits?: Readonly<Partial<Record<ResourceBudgetDimension, number | null>>>;
  deadlineAt?: string;
  expiresAt?: string | null;
  revoked?: boolean;
  retryPerExecutionLimit?: number;
  childAllocation?: Readonly<{
    accountId: string;
    childSessionId: string;
    hardLimits: ResourceBudgetAmounts;
    softLimits?: Readonly<Partial<Record<ResourceBudgetDimension, number | null>>>;
    expiresAt?: string | null;
  }>;
  idempotencyKey: string;
}>;

export class ResourceBudgetValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ResourceBudgetValidationError";
  }
}

export function parseResourceBudgetGetInput(value: unknown): ResourceBudgetGetInput {
  const object = requireObject(value, "budget.get input");
  assertKeys(object, ["sessionId"], "budget.get input");
  return { sessionId: requireNonEmptyString(object.sessionId, "sessionId") };
}

export function parseResourceBudgetListInput(value: unknown): ResourceBudgetListInput {
  const object = requireObject(value, "budget.list input");
  assertKeys(object, ["sessionId", "limit", "cursor"], "budget.list input");
  const limit = requirePositiveSafeInteger(object.limit, "limit");
  if (limit > RESOURCE_BUDGET_MAX_LIST_LIMIT) {
    throw new ResourceBudgetValidationError(`limit must be at most ${RESOURCE_BUDGET_MAX_LIST_LIMIT}.`);
  }
  const cursor = object.cursor === undefined ? undefined : requireNonEmptyString(object.cursor, "cursor");
  return { sessionId: requireNonEmptyString(object.sessionId, "sessionId"), limit, ...(cursor ? { cursor } : {}) };
}

export function parseResourceBudgetConfigureInput(value: unknown): ResourceBudgetConfigureInput {
  const object = requireObject(value, "budget.configure input");
  assertKeys(object, [
    "sessionId", "accountId", "expectedRevision", "hardLimits", "softLimits",
    "deadlineAt", "expiresAt", "revoked", "retryPerExecutionLimit", "childAllocation", "idempotencyKey",
  ], "budget.configure input");
  const hardLimits = object.hardLimits === undefined
    ? undefined
    : parseAmounts(object.hardLimits, false, "hardLimits");
  const softLimits = object.softLimits === undefined
    ? undefined
    : parseSoftLimits(object.softLimits);
  const deadlineAt = object.deadlineAt === undefined ? undefined : requireTimestamp(object.deadlineAt, "deadlineAt");
  const expiresAt = object.expiresAt === undefined || object.expiresAt === null
    ? object.expiresAt as undefined | null
    : requireTimestamp(object.expiresAt, "expiresAt");
  if (object.revoked !== undefined && typeof object.revoked !== "boolean") {
    throw new ResourceBudgetValidationError("revoked must be a boolean.");
  }
  const retryPerExecutionLimit = object.retryPerExecutionLimit === undefined
    ? undefined
    : requireNonNegativeSafeInteger(object.retryPerExecutionLimit, "retryPerExecutionLimit");
  const childAllocation = object.childAllocation === undefined ? undefined : parseChildAllocation(object.childAllocation);
  if (childAllocation !== undefined && (hardLimits !== undefined || softLimits !== undefined || deadlineAt !== undefined
    || object.expiresAt !== undefined || object.revoked !== undefined || retryPerExecutionLimit !== undefined)) {
    throw new ResourceBudgetValidationError("childAllocation cannot be combined with account policy changes.");
  }
  if (hardLimits === undefined && softLimits === undefined && deadlineAt === undefined
    && object.expiresAt === undefined && object.revoked === undefined && retryPerExecutionLimit === undefined
    && childAllocation === undefined) {
    throw new ResourceBudgetValidationError("budget.configure must contain a change.");
  }
  return {
    sessionId: requireNonEmptyString(object.sessionId, "sessionId"),
    accountId: requireNonEmptyString(object.accountId, "accountId"),
    expectedRevision: requirePositiveSafeInteger(object.expectedRevision, "expectedRevision"),
    ...(hardLimits ? { hardLimits } : {}),
    ...(softLimits ? { softLimits } : {}),
    ...(deadlineAt ? { deadlineAt } : {}),
    ...(object.expiresAt !== undefined ? { expiresAt } : {}),
    ...(object.revoked !== undefined ? { revoked: object.revoked } : {}),
    ...(retryPerExecutionLimit !== undefined ? { retryPerExecutionLimit } : {}),
    ...(childAllocation ? { childAllocation } : {}),
    idempotencyKey: requireNonEmptyString(object.idempotencyKey, "idempotencyKey"),
  };
}

export function isResourceBudgetDimension(value: unknown): value is ResourceBudgetDimension {
  return typeof value === "string" && (RESOURCE_BUDGET_DIMENSIONS as readonly string[]).includes(value);
}

export function assertResourceBudgetAmounts(value: unknown, label = "amounts"): ResourceBudgetPartialAmounts {
  return parseAmounts(value, false, label);
}

export function resourceBudgetConfigureFingerprint(input: ResourceBudgetConfigureInput): string {
  const normalized = {
    sessionId: input.sessionId,
    accountId: input.accountId,
    expectedRevision: input.expectedRevision,
    hardLimits: sortRecord(input.hardLimits),
    softLimits: sortRecord(input.softLimits),
    deadlineAt: input.deadlineAt,
    expiresAt: input.expiresAt,
    revoked: input.revoked,
    retryPerExecutionLimit: input.retryPerExecutionLimit,
    childAllocation: input.childAllocation ? {
      accountId: input.childAllocation.accountId,
      childSessionId: input.childAllocation.childSessionId,
      hardLimits: sortRecord(input.childAllocation.hardLimits),
      softLimits: sortRecord(input.childAllocation.softLimits),
      expiresAt: input.childAllocation.expiresAt,
    } : undefined,
  };
  return JSON.stringify(normalized);
}

function parseChildAllocation(value: unknown): NonNullable<ResourceBudgetConfigureInput["childAllocation"]> {
  const object = requireObject(value, "childAllocation");
  assertKeys(object, ["accountId", "childSessionId", "hardLimits", "softLimits", "expiresAt"], "childAllocation");
  const hardLimits = parseAmounts(object.hardLimits, true, "childAllocation.hardLimits") as ResourceBudgetAmounts;
  if (hardLimits.storageBytes !== 0) {
    throw new ResourceBudgetValidationError("childAllocation.hardLimits.storageBytes must be 0 because storage is metered at the root SessionFolder.");
  }
  const softLimits = object.softLimits === undefined ? undefined : parseSoftLimits(object.softLimits);
  if (softLimits?.storageBytes !== undefined && softLimits.storageBytes !== null) {
    throw new ResourceBudgetValidationError("childAllocation.softLimits.storageBytes must be null or omitted because storage is metered at the root SessionFolder.");
  }
  const expiresAt = object.expiresAt === undefined || object.expiresAt === null
    ? object.expiresAt as undefined | null
    : requireTimestamp(object.expiresAt, "childAllocation.expiresAt");
  return {
    accountId: requireNonEmptyString(object.accountId, "childAllocation.accountId"),
    childSessionId: requireNonEmptyString(object.childSessionId, "childAllocation.childSessionId"),
    hardLimits,
    ...(softLimits ? { softLimits } : {}),
    ...(object.expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function parseAmounts(value: unknown, requireAll: boolean, label: string): ResourceBudgetPartialAmounts {
  const object = requireObject(value, label);
  assertKeys(object, RESOURCE_BUDGET_DIMENSIONS, label);
  const result: Partial<Record<ResourceBudgetDimension, number>> = {};
  for (const dimension of RESOURCE_BUDGET_DIMENSIONS) {
    if (object[dimension] === undefined) {
      if (requireAll) throw new ResourceBudgetValidationError(`${label}.${dimension} is required.`);
      continue;
    }
    result[dimension] = requireNonNegativeSafeInteger(object[dimension], `${label}.${dimension}`);
  }
  if (Object.keys(result).length === 0) throw new ResourceBudgetValidationError(`${label} must not be empty.`);
  return result;
}

function parseSoftLimits(value: unknown): Partial<Record<ResourceBudgetDimension, number | null>> {
  const object = requireObject(value, "softLimits");
  assertKeys(object, RESOURCE_BUDGET_DIMENSIONS, "softLimits");
  const result: Partial<Record<ResourceBudgetDimension, number | null>> = {};
  for (const dimension of RESOURCE_BUDGET_DIMENSIONS) {
    const item = object[dimension];
    if (item === undefined) continue;
    result[dimension] = item === null ? null : requireNonNegativeSafeInteger(item, `softLimits.${dimension}`);
  }
  if (Object.keys(result).length === 0) throw new ResourceBudgetValidationError("softLimits must not be empty.");
  return result;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResourceBudgetValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(object: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new ResourceBudgetValidationError(`${label} contains unexpected fields: ${unexpected.join(", ")}.`);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ResourceBudgetValidationError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const text = requireNonEmptyString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new ResourceBudgetValidationError(`${label} must be an ISO timestamp with a timezone.`);
  }
  return new Date(text).toISOString();
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ResourceBudgetValidationError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const result = requireNonNegativeSafeInteger(value, label);
  if (result === 0) throw new ResourceBudgetValidationError(`${label} must be positive.`);
  return result;
}

function sortRecord<T>(value: Readonly<Partial<Record<ResourceBudgetDimension, T>>> | undefined): Record<string, T> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(RESOURCE_BUDGET_DIMENSIONS.filter((dimension) => dimension in value).map((dimension) => [dimension, value[dimension]!])) as Record<string, T>;
}
