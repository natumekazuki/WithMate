export type MarkdownImageTarget =
  | { kind: "external"; source: string }
  | { kind: "local"; target: string }
  | { kind: "unsupported" };

export function resolveMarkdownImageTarget(target: string): MarkdownImageTarget {
  const source = target.trim();
  if (!source) return { kind: "unsupported" };
  if (source.startsWith("//")) return { kind: "external", source: `https:${source}` };
  if (/^(?:https?:|data:image\/|blob:)/i.test(source)) {
    return { kind: "external", source };
  }
  if (/^[a-zA-Z]:[\\/]/.test(source) || /^file:/i.test(source)) {
    return { kind: "local", target: source };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source)) return { kind: "unsupported" };
  return { kind: "local", target: source };
}
