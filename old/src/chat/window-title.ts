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
  const fallbackTitle = normalizedSessionId ? `WithMate Session - ${normalizedSessionId}` : "";
  if (!fallbackTitle && !input.sessionTitle?.trim()) {
    return null;
  }

  return resolveSessionDocumentTitle(input.sessionTitle, fallbackTitle || "Session");
}

export function resolveCompanionDocumentTitle(input: {
  mode: "chat" | "merge";
  sessionTitle: string | null | undefined;
  sessionId: string | null | undefined;
}): string | null {
  const normalizedSessionId = input.sessionId?.trim() ?? "";
  if (input.mode === "merge") {
    return normalizedSessionId ? `Companion Merge - ${normalizedSessionId}` : "WithMate Companion";
  }

  const fallbackTitle = normalizedSessionId ? `Companion - ${normalizedSessionId}` : "WithMate Companion";
  return resolveSessionDocumentTitle(input.sessionTitle, fallbackTitle);
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
