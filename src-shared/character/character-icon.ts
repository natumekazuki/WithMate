const CHARACTER_ICON_SUPPORTED_EXTENSION_PATTERN = /\.(?:png|jpe?g)$/i;

/** PNG・JPEG以外のファイル名を登録しようとした際の案内。 */
export const CHARACTER_ICON_FORMAT_ERROR =
  "Character icon must be a PNG, JPG, or JPEG image file.";
/** ローカルパスではなくURL等のスキーム付き参照を登録しようとした際の案内。 */
export const CHARACTER_ICON_LOCAL_PATH_ERROR =
  "Character icon must use a local file path.";

/** ドライブ名のコロンを除き、先頭がURIスキームの構文かを調べる。 */
export function hasCharacterIconPathScheme(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return false;
  }

  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

/** ドライブ文字の後に区切りが続くWindowsパスを識別する。 */
function isWindowsDrivePathReference(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

/** バックスラッシュ二つで始まるUNC形式を識別する。 */
function isBackslashUncPathReference(value: string): boolean {
  return value.startsWith("\\\\");
}

/** スラッシュ表記へ変換されたUNC形式も取り扱う。 */
function isForwardSlashUncPathReference(value: string): boolean {
  return value.startsWith("//");
}

/** UNCと混同せず、単一のスラッシュから始まる絶対パスを識別する。 */
function isPosixAbsolutePathReference(value: string): boolean {
  return value.startsWith("/") && !isForwardSlashUncPathReference(value);
}

/** ドライブやUNC同士はWindows比較、POSIX絶対パスは厳密比較とし、相対参照だけ設定に従う。 */
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
  const leftIsUncPath =
    leftIsBackslashUncPath || isForwardSlashUncPathReference(left);
  const rightIsUncPath =
    rightIsBackslashUncPath || isForwardSlashUncPathReference(right);
  if (leftIsUncPath || rightIsUncPath) {
    return leftIsUncPath && rightIsUncPath;
  }

  if (
    isPosixAbsolutePathReference(left) ||
    isPosixAbsolutePathReference(right)
  ) {
    return false;
  }

  return fileSystemStyle === "windows";
}

/** 前後の空白を除き、Windows形式同士だけ区切りと大文字小文字の差を吸収して比較する。 */
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
    hasCharacterIconPathScheme(normalizedLeft) ||
    hasCharacterIconPathScheme(normalizedRight) ||
    !shouldUseWindowsPathComparison(
      normalizedLeft,
      normalizedRight,
      options.fileSystemStyle,
    )
  ) {
    return false;
  }

  return (
    normalizedLeft.replaceAll("\\", "/").toLowerCase() ===
    normalizedRight.replaceAll("\\", "/").toLowerCase()
  );
}

/** 空欄の登録を許し、指定があればスキームのない対応拡張子のパスか検証する。 */
export function validateCharacterIconRegistrationPath(
  value: string,
): string | null {
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
