const CHARACTER_ICON_SUPPORTED_EXTENSION_PATTERN = /\.(?:png|jpe?g)$/i;

export const CHARACTER_ICON_FORMAT_ERROR =
  "Character icon は png / jpg / jpeg の画像ファイルを指定してね。";
export const CHARACTER_ICON_LOCAL_PATH_ERROR =
  "Character icon は local file path で指定してね。";

export function hasCharacterIconPathScheme(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return false;
  }

  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isWindowsDrivePathReference(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function isBackslashUncPathReference(value: string): boolean {
  return value.startsWith("\\\\");
}

function isForwardSlashUncPathReference(value: string): boolean {
  return value.startsWith("//");
}

function isPosixAbsolutePathReference(value: string): boolean {
  return value.startsWith("/") && !isForwardSlashUncPathReference(value);
}

function shouldUseWindowsPathComparison(
  left: string,
  right: string,
  fileSystemStyle: "windows" | "posix" | undefined,
): boolean {
  const leftIsWindowsDrivePath = isWindowsDrivePathReference(left);
  const rightIsWindowsDrivePath = isWindowsDrivePathReference(right);
  if (leftIsWindowsDrivePath || rightIsWindowsDrivePath) {
    return leftIsWindowsDrivePath && rightIsWindowsDrivePath;
  }

  const leftIsBackslashUncPath = isBackslashUncPathReference(left);
  const rightIsBackslashUncPath = isBackslashUncPathReference(right);
  const leftIsUncPath = leftIsBackslashUncPath || isForwardSlashUncPathReference(left);
  const rightIsUncPath = rightIsBackslashUncPath || isForwardSlashUncPathReference(right);
  if (leftIsUncPath || rightIsUncPath) {
    return leftIsUncPath && rightIsUncPath;
  }

  if (isPosixAbsolutePathReference(left) || isPosixAbsolutePathReference(right)) {
    return false;
  }

  return fileSystemStyle === "windows";
}

export function areCharacterIconPathReferencesEquivalent(
  left: string,
  right: string,
  options: { fileSystemStyle?: "windows" | "posix" } = {},
): boolean {
  const normalizedLeft = left.trim();
  const normalizedRight = right.trim();
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  if (
    hasCharacterIconPathScheme(normalizedLeft)
    || hasCharacterIconPathScheme(normalizedRight)
    || !shouldUseWindowsPathComparison(
      normalizedLeft,
      normalizedRight,
      options.fileSystemStyle,
    )
  ) {
    return false;
  }

  return normalizedLeft.replaceAll("\\", "/").toLowerCase()
    === normalizedRight.replaceAll("\\", "/").toLowerCase();
}

export function validateCharacterIconRegistrationPath(value: string): string | null {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return null;
  }
  if (hasCharacterIconPathScheme(normalizedValue)) {
    return CHARACTER_ICON_LOCAL_PATH_ERROR;
  }
  if (!CHARACTER_ICON_SUPPORTED_EXTENSION_PATTERN.test(normalizedValue)) {
    return CHARACTER_ICON_FORMAT_ERROR;
  }

  return null;
}
