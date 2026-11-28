/** Session の更新日範囲と、削除候補とする通常ファイルの最小サイズ（MiB）。空の日付はその側の範囲を制限しない。 */
export type SessionFolderCleanupRequest = {
  fromDate: string;
  toDate: string;
  minimumFileSizeMiB: number;
};

/** 走査または削除でスキップ・失敗した箇所。パスは対象の Session Folder を基準とする。 */
export type SessionFolderCleanupIssue = {
  sessionId: string;
  relativePath: string;
  message: string;
  kind: "skipped" | "failed";
};
/** 削除前の走査結果。通常ファイル全体と削除候補を別に集計し、実行時に照合する走査 ID を返す。 */
export type SessionFolderCleanupScan = {
  scanId: string;
  request: SessionFolderCleanupRequest;
  sessionCount: number;
  totalFileCount: number;
  totalBytes: number;
  matchedFileCount: number;
  matchedBytes: number;
  skippedRunningSessionCount: number;
  skippedWorkspaceSessionCount: number;
  skippedLinkCount: number;
  issues: SessionFolderCleanupIssue[];
};
/** 走査後の削除で実際に削除したファイル・ディレクトリと、スキップ・失敗したファイルの集計。 */
export type SessionFolderCleanupResult = {
  deletedFileCount: number;
  deletedBytes: number;
  deletedDirectoryCount: number;
  skippedFileCount: number;
  failedFileCount: number;
  issues: SessionFolderCleanupIssue[];
};

/** 日付の制限なしを表す空文字を許し、それ以外は YYYY-MM-DD 形式の実在する日付に限る。 */
function parseDate(value: unknown): string {
  if (value === "") return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError("Dates must use YYYY-MM-DD format.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year!, month! - 1, day!);
  date.setHours(0, 0, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month! - 1 ||
    date.getDate() !== day
  ) {
    throw new TypeError("Enter a valid calendar date.");
  }
  return value;
}

/** 走査条件の境界検証。逆転した日付範囲や、バイト換算で扱える範囲を超える最小サイズを拒否する。 */
export function parseSessionFolderCleanupRequest(
  value: unknown,
): SessionFolderCleanupRequest {
  if (!value || typeof value !== "object")
    throw new TypeError("Invalid Session Folder cleanup conditions.");
  const input = value as Record<string, unknown>;
  const fromDate = parseDate(input.fromDate);
  const toDate = parseDate(input.toDate);
  const minimumFileSizeMiB = input.minimumFileSizeMiB;
  if (fromDate && toDate && fromDate > toDate)
    throw new TypeError("The start date must not be after the end date.");
  if (
    typeof minimumFileSizeMiB !== "number" ||
    !Number.isFinite(minimumFileSizeMiB) ||
    minimumFileSizeMiB < 0 ||
    minimumFileSizeMiB * 1024 * 1024 > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(
      "Minimum size must be a non-negative finite number within the supported file size range.",
    );
  }
  return { fromDate, toDate, minimumFileSizeMiB };
}

/** 削除要求から空白のみではない走査 ID を取り出す。該当する走査の確認は呼び出し側が行う。 */
export function parseSessionFolderCleanupRunRequest(value: unknown): {
  scanId: string;
} {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { scanId?: unknown }).scanId !== "string" ||
    !(value as { scanId: string }).scanId.trim()
  )
    throw new TypeError("Invalid Session Folder cleanup scan ID.");
  return { scanId: (value as { scanId: string }).scanId };
}

/** Session の更新日時をローカル日付に直し、指定された開始日・終了日を両端含めて照合する。無効な日時は対象外とする。 */
export function isSessionFolderCleanupDateMatch(
  updatedAt: string,
  request: SessionFolderCleanupRequest,
): boolean {
  const date = new Date(updatedAt);
  if (!Number.isFinite(date.getTime())) return false;
  const localDate = `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return (
    (!request.fromDate || localDate >= request.fromDate) &&
    (!request.toDate || localDate <= request.toDate)
  );
}
