export type WorkspaceDirectoryValidationFailureReason =
  | "empty"
  | "not-absolute"
  | "missing"
  | "not-directory"
  | "unavailable";

export type WorkspaceDirectoryValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason: WorkspaceDirectoryValidationFailureReason;
    };

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
