function encodePathSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

export function toLocalFileUrl(target: string): string {
  const normalized = target.replace(/\\/g, "/");
  if (normalized.startsWith("//")) {
    const [host = "", ...segments] = normalized.slice(2).split("/");
    return `file://${host}/${segments.map(encodePathSegment).join("/")}`;
  }
  const segments = normalized.replace(/^\//, "").split("/");
  return `file:///${segments.map((segment, index) => (
    index === 0 && /^[a-zA-Z]:$/.test(segment) ? segment : encodePathSegment(segment)
  )).join("/")}`;
}
