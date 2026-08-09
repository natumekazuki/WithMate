const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
]);

const MARKDOWN_IMAGE_PATTERN = /!\[(?:\\.|[^\]\\])*\]\(\s*(?:<([^>\r\n]+)>|((?:\\.|[^)\s])+))(?:\s+(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\((?:\\.|[^)])*\)))?\s*\)/g;

export type MarkdownImageReferenceMatch = {
  end: number;
  path: string;
  start: number;
};

function normalizeSlash(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function decodePathComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

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
  return /^(?:[A-Za-z]:\/|\/\/)/.test(normalizedTarget) ? normalizedTarget : null;
}

function normalizePathIdentity(filePath: string): string {
  return normalizeSlash(filePath).toLocaleLowerCase();
}

function escapeMarkdownAltText(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1");
}

function encodeMarkdownPathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[()]/g, (character) => (
    character === "(" ? "%28" : "%29"
  ));
}

export function isSupportedComposerImagePath(filePath: string): boolean {
  const normalizedPath = normalizeSlash(filePath).split(/[?#]/, 1)[0] ?? "";
  const extensionMatch = normalizedPath.match(/\.([^.\/]+)$/);
  return extensionMatch !== null && SUPPORTED_IMAGE_EXTENSIONS.has(extensionMatch[1].toLocaleLowerCase());
}

export function formatMarkdownImageReference(filePath: string): string {
  const normalizedPath = normalizeSlash(filePath);
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1) || "image";
  const encodedPath = normalizedPath.startsWith("//")
    ? `file://${normalizedPath.slice(2).split("/").map(encodeMarkdownPathSegment).join("/")}`
    : normalizedPath
      .split("/")
      .map(encodeMarkdownPathSegment)
      .join("/")
      .replace(/^([A-Za-z])%3A\//, "$1:/");
  return `![${escapeMarkdownAltText(basename)}](${encodedPath})`;
}

export function findLocalMarkdownImageReferences(text: string): MarkdownImageReferenceMatch[] {
  const matches: MarkdownImageReferenceMatch[] = [];
  const expression = new RegExp(MARKDOWN_IMAGE_PATTERN);
  for (const match of text.matchAll(expression)) {
    const target = match[1] ?? match[2] ?? "";
    const localPath = decodeLocalImageTarget(target);
    if (match.index === undefined || localPath === null || !isSupportedComposerImagePath(localPath)) {
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

export function extractLocalMarkdownImagePaths(text: string): string[] {
  return findLocalMarkdownImageReferences(text).map((match) => match.path);
}

export const findMarkdownImageReferences = findLocalMarkdownImageReferences;
export const extractMarkdownImageReferenceCandidates = extractLocalMarkdownImagePaths;

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

export const removeMarkdownImageReferences = removeLocalMarkdownImageReferences;
