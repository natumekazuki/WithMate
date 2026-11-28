const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
]);

const MARKDOWN_IMAGE_PATTERN =
  /!\[(?:\\.|[^\]\\])*\]\(\s*(?:<([^>\r\n]+)>|((?:\\.|[^)\s])+))(?:\s+(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\((?:\\.|[^)])*\)))?\s*\)/g;

/** Markdown画像記法の開始位置・終了位置と、復号後のローカルファイルパス。 */
export type MarkdownImageReferenceMatch = {
  end: number;
  path: string;
  start: number;
};

/** パスの区切りをスラッシュに揃え、後続の比較とMarkdown出力で共用する。 */
function normalizeSlash(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** パーセントエスケープを復号し、不正なエンコードは参照候補にしない。 */
function decodePathComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** file URL、またはドライブ・UNCの絶対パスを取り出し、それ以外のリンク先を除外する。 */
function decodeLocalImageTarget(target: string): string | null {
  const trimmedTarget = target.trim();
  if (/^file:/i.test(trimmedTarget)) {
    try {
      const url = new URL(trimmedTarget);
      if (url.protocol !== "file:") {
        return null;
      }

      const decodedPath = decodePathComponent(url.pathname);
      if (decodedPath === null) {
        return null;
      }

      if (url.hostname) {
        return `//${url.hostname}${decodedPath}`;
      }

      return decodedPath.replace(/^\/(?=[A-Za-z]:\/)/, "");
    } catch {
      return null;
    }
  }

  const decodedTarget = decodePathComponent(trimmedTarget);
  if (decodedTarget === null) {
    return null;
  }

  const normalizedTarget = normalizeSlash(decodedTarget);
  return /^(?:[A-Za-z]:\/|\/\/)/.test(normalizedTarget)
    ? normalizedTarget
    : null;
}

/** 削除対象の照合で区切り文字と大文字小文字の差を無視するための比較値。 */
function normalizePathIdentity(filePath: string): string {
  return normalizeSlash(filePath).toLocaleLowerCase();
}

/** 代替テキスト内の角括弧とバックスラッシュを文字として表示できるようにする。 */
function escapeMarkdownAltText(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1");
}

/** パス区間をURL用に符号化し、リンクの閉じ括弧と混同する丸括弧も符号化する。 */
function encodeMarkdownPathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[()]/g, (character) =>
    character === "(" ? "%28" : "%29",
  );
}

/** クエリやフラグメントより前の拡張子が、添付に対応する画像形式かを判定する。 */
export function isSupportedComposerImagePath(filePath: string): boolean {
  const normalizedPath = normalizeSlash(filePath).split(/[?#]/, 1)[0] ?? "";
  const extensionMatch = normalizedPath.match(/\.([^.\/]+)$/);
  return (
    extensionMatch !== null &&
    SUPPORTED_IMAGE_EXTENSIONS.has(extensionMatch[1].toLocaleLowerCase())
  );
}

/** パスからファイル名付きのMarkdown画像記法を作り、UNCはホスト付きfile URLとして表す。 */
export function formatMarkdownImageReference(filePath: string): string {
  const normalizedPath = normalizeSlash(filePath);
  const basename =
    normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1) || "image";
  const encodedPath = normalizedPath.startsWith("//")
    ? `file://${normalizedPath.slice(2).split("/").map(encodeMarkdownPathSegment).join("/")}`
    : normalizedPath
        .split("/")
        .map(encodeMarkdownPathSegment)
        .join("/")
        .replace(/^([A-Za-z])%3A\//, "$1:/");
  return `![${escapeMarkdownAltText(basename)}](${encodedPath})`;
}

/** 本文から対応するローカル画像だけを検出し、原文の位置と復号済みパスを返す。 */
export function findLocalMarkdownImageReferences(
  text: string,
): MarkdownImageReferenceMatch[] {
  const matches: MarkdownImageReferenceMatch[] = [];
  const expression = new RegExp(MARKDOWN_IMAGE_PATTERN);
  for (const match of text.matchAll(expression)) {
    const target = match[1] ?? match[2] ?? "";
    const localPath = decodeLocalImageTarget(target);
    if (
      match.index === undefined ||
      localPath === null ||
      !isSupportedComposerImagePath(localPath)
    ) {
      continue;
    }

    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      path: localPath,
    });
  }
  return matches;
}

/** ローカル画像参照を出現順に読み、位置情報を除いたパスだけを返す。 */
export function extractLocalMarkdownImagePaths(text: string): string[] {
  return findLocalMarkdownImageReferences(text).map((match) => match.path);
}

/** 位置情報も必要な呼び出し元が使用するローカル画像検出の別名。 */
export const findMarkdownImageReferences = findLocalMarkdownImageReferences;
/** 添付候補としてパスだけを必要とする呼び出し元向けの別名。 */
export const extractMarkdownImageReferenceCandidates =
  extractLocalMarkdownImagePaths;

/** 指定パスに対応する画像記法だけを本文の末尾側から取り除き、他の記述は保つ。 */
export function removeLocalMarkdownImageReferences(
  text: string,
  referencePaths: readonly string[],
): string {
  const removablePaths = new Set(referencePaths.map(normalizePathIdentity));
  const matches = findLocalMarkdownImageReferences(text)
    .filter((match) => removablePaths.has(normalizePathIdentity(match.path)))
    .sort((left, right) => right.start - left.start);

  let nextText = text;
  for (const match of matches) {
    nextText = `${nextText.slice(0, match.start)}${nextText.slice(match.end)}`;
  }
  return nextText;
}

/** パス一覧でローカル画像記法を除去する操作の別名。 */
export const removeMarkdownImageReferences = removeLocalMarkdownImageReferences;
