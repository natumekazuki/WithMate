/** 保存済みタイトルの前後の空白を除き、空であれば指定された既定のタイトルを使う。 */
export function resolveSessionDocumentTitle(
  sessionTitle: string | null | undefined,
  fallbackTitle: string,
): string {
  const normalizedTitle = sessionTitle?.trim() ?? "";
  return normalizedTitle || fallbackTitle;
}

/** 対象 ID またはタイトルが判明している場合だけ、Agent Session のウィンドウ名を決める。 */
export function resolveAgentSessionDocumentTitle(input: {
  sessionTitle: string | null | undefined;
  sessionId: string | null | undefined;
}): string | null {
  const normalizedSessionId = input.sessionId?.trim() ?? "";
  const fallbackTitle = normalizedSessionId ? "Session" : "";
  if (!fallbackTitle && !input.sessionTitle?.trim()) {
    return null;
  }

  return resolveSessionDocumentTitle(
    input.sessionTitle,
    fallbackTitle || "Session",
  );
}

/** 文書が存在し、空でない名前を指定したときだけウィンドウのタイトルを書き換える。 */
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
