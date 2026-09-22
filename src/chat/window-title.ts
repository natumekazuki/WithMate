export function resolveSessionDocumentTitle(
  sessionTitle: string | null | undefined,
  fallbackTitle: string,
): string {
  const normalizedTitle = sessionTitle?.trim() ?? "";
  return normalizedTitle || fallbackTitle;
}

export function resolveAgentSessionDocumentTitle(input: {
  sessionTitle: string | null | undefined;
  sessionId: string | null | undefined;
}): string | null {
  const normalizedSessionId = input.sessionId?.trim() ?? "";
  const fallbackTitle = normalizedSessionId ? `WithMateSession - ${normalizedSessionId}` : "";
  if (!fallbackTitle && !input.sessionTitle?.trim()) {
    return null;
  }

  return resolveSessionDocumentTitle(input.sessionTitle, fallbackTitle || "Session");
}

export function applySessionDocumentTitle(
  title: string | null | undefined,
): void {
  if (typeof document === "undefined") {
    return;
  }

  const normalizedTitle = title?.trim() ?? "";
  if (!normalizedTitle) {
    return;
  }

  document.title = normalizedTitle;
}
