export const TEXT_PATH_REFERENCE_PATTERN = /(^|[\s(])@(?:"([^"\r\n]+)"|([^\s@]+))/gm;

export function extractTextReferenceCandidates(text: string): string[] {
  const candidates: string[] = [];
  const expression = new RegExp(TEXT_PATH_REFERENCE_PATTERN);

  for (const match of text.matchAll(expression)) {
    const quotedPath = match[2];
    const plainPath = match[3];
    const candidatePath = quotedPath ?? plainPath ?? "";
    if (candidatePath.trim()) {
      candidates.push(candidatePath.trim());
    }
  }

  return candidates;
}
