import type { WithMateWindowApi } from "./withmate-window-api.js";

type SessionRightPanePreferenceApi = Pick<
  WithMateWindowApi,
  "reportRendererLog" | "updateSessionRightPaneVisibility"
>;

function toLogError(error: unknown): { name?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

export async function persistSessionRightPaneVisibility(
  api: SessionRightPanePreferenceApi | null,
  isVisible: boolean,
): Promise<void> {
  if (!api) {
    return;
  }

  try {
    await api.updateSessionRightPaneVisibility(isVisible);
  } catch (error) {
    try {
      api.reportRendererLog({
        level: "error",
        kind: "session.right-pane-preference-save-failed",
        message: "Session right pane preference save failed",
        data: { isVisible },
        error: toLogError(error),
      });
    } catch {
      // The local layout remains usable even when both persistence and logging fail.
    }
  }
}
