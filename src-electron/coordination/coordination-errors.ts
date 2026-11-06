export class CoordinationRejectedError extends Error {
  readonly code = "COORDINATION_REJECTED";
  readonly effect = "none";
  constructor(message: string) { super(message); this.name = "CoordinationRejectedError"; }
}

/** An authoritative saved lookup, not a transport or authorization failure. */
export class CoordinationDeletedError extends Error {
  readonly code = "COORDINATION_DELETED";
  readonly effect = "none";
  constructor(message: string) { super(message); this.name = "CoordinationDeletedError"; }
}

export function isCoordinationDeletedError(error: unknown): error is Error & { code: "COORDINATION_DELETED" } {
  return error instanceof Error && "code" in error && error.code === "COORDINATION_DELETED";
}
