/** 既にエンコード済みの区間はデコードしてから正規化し、不正なエスケープは元の文字列として符号化する。 */
function encodePathSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

/** 区切りを正規化してパス区間をエンコードし、UNC のホストや Windows のドライブ記号を保つ。 */
export function toLocalFileUrl(target: string): string {
  const normalized = target.replace(/\\/g, "/");
  if (normalized.startsWith("//")) {
    const [host = "", ...segments] = normalized.slice(2).split("/");
    return `file://${host}/${segments.map(encodePathSegment).join("/")}`;
  }
  const segments = normalized.replace(/^\//, "").split("/");
  return `file:///${segments
    .map((segment, index) =>
      index === 0 && /^[a-zA-Z]:$/.test(segment)
        ? segment
        : encodePathSegment(segment),
    )
    .join("/")}`;
}
