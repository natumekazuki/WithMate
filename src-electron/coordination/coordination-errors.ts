/** 相談操作を、副作用がないことを確定できる段階で拒否した結果。 */
export class CoordinationRejectedError extends Error {
  readonly code = "COORDINATION_REJECTED";
  readonly effect = "none";
  /** 拒否の理由を、想定外の保存エラーと区別できる形式にする。 */
  constructor(message: string) {
    super(message);
    this.name = "CoordinationRejectedError";
  }
}

/** 保存データの正本を照会した結果であり、通信や認可の失敗ではない。 */
export class CoordinationDeletedError extends Error {
  readonly code = "COORDINATION_DELETED";
  readonly effect = "none";
  /** 保存先で対象を確認できなかった理由を、削除または不存在として記録する。 */
  constructor(message: string) {
    super(message);
    this.name = "CoordinationDeletedError";
  }
}

/** エラー名や文言ではなく、相談の不存在を表すコードで分類する。 */
export function isCoordinationDeletedError(
  error: unknown,
): error is Error & { code: "COORDINATION_DELETED" } {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "COORDINATION_DELETED"
  );
}
