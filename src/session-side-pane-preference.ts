import type { WithMateWindowApi } from "./withmate-window-api.js";
import type { SessionSidePane } from "./session-side-pane.js";

type SessionSidePanePreferenceApi = Pick<
  WithMateWindowApi,
  "reportRendererLog" | "updateSessionSidePane"
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

export async function persistSessionSidePane(
  api: SessionSidePanePreferenceApi | null,
  sidePane: SessionSidePane,
): Promise<void> {
  if (!api) {
    return;
  }

  try {
    await api.updateSessionSidePane(sidePane);
  } catch (error) {
    try {
      api.reportRendererLog({
        level: "error",
        kind: "session.side-pane-preference-save-failed",
        message: "Session side pane preference save failed",
        data: { sidePane },
        error: toLogError(error),
      });
    } catch {
      // The local layout remains usable even when both persistence and logging fail.
    }
  }
}
