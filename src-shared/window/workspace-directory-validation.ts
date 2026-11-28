/** 入力前の空欄、不正なパス、検証先の不在・利用不可を区別する理由。 */
export type WorkspaceDirectoryValidationFailureReason =
  "empty" | "not-absolute" | "missing" | "not-directory" | "unavailable";

/** Workspaceとして使えるか、使えない場合は理由を示す検証結果。 */
export type WorkspaceDirectoryValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason: WorkspaceDirectoryValidationFailureReason;
    };

/** 空欄と有効入力には案内を出さず、それ以外は理由に応じた表示文言を返す。 */
export function resolveWorkspaceDirectoryValidationMessage(
  result: WorkspaceDirectoryValidationResult,
): string {
  if (result.valid) {
    return "";
  }

  switch (result.reason) {
    case "empty":
      return "";
    case "not-absolute":
      return "Enter an absolute path.";
    case "missing":
      return "Path not found.";
    case "not-directory":
      return "Not a directory.";
    case "unavailable":
      return "Directory unavailable.";
  }
}
