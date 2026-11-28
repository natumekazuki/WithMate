/** 区切りをスラッシュに統一し、ドライブのルートを保って余分な末尾区切りを除く。 */
function normalizeAdditionalDirectoryPath(directoryPath: string): string {
  const normalizedPath = directoryPath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/+$/.test(normalizedPath)) {
    return `${normalizedPath.slice(0, 2)}/`;
  }
  return normalizedPath.replace(/\/+$/g, "") || normalizedPath;
}

/** 正規化済みのパスがドライブ絶対パスまたは UNC 共有を指す形式か判定する。 */
function isWindowsAdditionalDirectoryPath(directoryPath: string): boolean {
  return (
    /^[A-Za-z]:\//.test(directoryPath) ||
    /^\/\/[^/]+\/[^/]+/.test(directoryPath)
  );
}

/** Windows 形式だけ大文字小文字を区別せず、追加・削除に共通の比較キーを作る。 */
function toAdditionalDirectoryComparisonKey(directoryPath: string): string {
  const normalizedPath = normalizeAdditionalDirectoryPath(directoryPath);
  if (isWindowsAdditionalDirectoryPath(normalizedPath)) {
    return normalizedPath.toLowerCase();
  }
  return normalizedPath;
}

/** 優先順に渡された候補から最初の空でない文字列を選び、候補がなければ null を返す。 */
export function resolveAdditionalDirectoryPickerBase(
  ...directoryPaths: Array<string | null | undefined>
): string | null {
  return (
    directoryPaths.find(
      (directoryPath): directoryPath is string =>
        typeof directoryPath === "string" && directoryPath.length > 0,
    ) ?? null
  );
}

/** 選択可能な場合だけピッカーを開き、取り消されなければ選択結果を反映してからパスを返す。 */
export async function runPickedAdditionalDirectoryOperation(input: {
  canPickDirectory: () => boolean;
  getPickerBaseDirectory: () => string | null;
  pickDirectory: (baseDirectory: string | null) => Promise<string | null>;
  applyPickedDirectory: (selectedPath: string) => void | Promise<void>;
}): Promise<string | null> {
  if (!input.canPickDirectory()) {
    return null;
  }

  const selectedPath = await input.pickDirectory(
    input.getPickerBaseDirectory(),
  );
  if (!selectedPath) {
    return null;
  }

  await input.applyPickedDirectory(selectedPath);
  return selectedPath;
}

/** 削除ガードが拒否したときは何も変更せず、それ以外では呼び出し元の削除処理に委ねる。 */
export async function runAdditionalDirectoryRemovalOperation(input: {
  directoryPath: string;
  canRemoveDirectory?: () => boolean;
  removeDirectory: (directoryPath: string) => boolean | Promise<boolean>;
}): Promise<boolean> {
  if (input.canRemoveDirectory && !input.canRemoveDirectory()) {
    return false;
  }
  return input.removeDirectory(input.directoryPath);
}

/** 既存の一覧と追加先を正規化して重複を取り除き、最初に現れた順序で返す。 */
export function addAllowedAdditionalDirectory(
  directories: readonly string[] | null | undefined,
  directoryPath: string,
): string[] {
  const nextDirectories: string[] = [];
  const seenKeys = new Set<string>();
  for (const entry of [...(directories ?? []), directoryPath]) {
    const normalizedPath = normalizeAdditionalDirectoryPath(entry);
    const comparisonKey = toAdditionalDirectoryComparisonKey(normalizedPath);
    if (seenKeys.has(comparisonKey)) {
      continue;
    }
    seenKeys.add(comparisonKey);
    nextDirectories.push(normalizedPath);
  }
  return nextDirectories;
}

/** 追加時と同じ比較規則で該当する許可先をすべて除き、残りを正規化して返す。 */
export function removeAllowedAdditionalDirectory(
  directories: readonly string[] | null | undefined,
  directoryPath: string,
): string[] {
  const removableKey = toAdditionalDirectoryComparisonKey(directoryPath);
  return (directories ?? [])
    .map(normalizeAdditionalDirectoryPath)
    .filter(
      (entry) => toAdditionalDirectoryComparisonKey(entry) !== removableKey,
    );
}
