export type SessionFolderCleanupRequest = {
  fromDate: string;
  toDate: string;
  minimumFileSizeMiB: number;
};

export type SessionFolderCleanupIssue = {
  sessionId: string;
  relativePath: string;
  message: string;
  kind: "skipped" | "failed";
};
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
export type SessionFolderCleanupResult = {
  deletedFileCount: number;
  deletedBytes: number;
  deletedDirectoryCount: number;
  skippedFileCount: number;
  failedFileCount: number;
  issues: SessionFolderCleanupIssue[];
};

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
