export class CoordinationRejectedError extends Error {
  readonly code = "COORDINATION_REJECTED";
  readonly effect = "none";
  constructor(message: string) { super(message); this.name = "CoordinationRejectedError"; }
}

/** 保存データの正本を照会した結果であり、通信や認可の失敗ではない。 */
export class CoordinationDeletedError extends Error {
  readonly code = "COORDINATION_DELETED";
  readonly effect = "none";
  constructor(message: string) { super(message); this.name = "CoordinationDeletedError"; }
}

export function isCoordinationDeletedError(error: unknown): error is Error & { code: "COORDINATION_DELETED" } {
  return error instanceof Error && "code" in error && error.code === "COORDINATION_DELETED";
}
