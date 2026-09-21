import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { ChatLayoutPreferenceUpdate } from "../../src-shared/settings/chat-layout-preference.js";

type ChatLayoutPreferenceApi = Pick<
  WithMateWindowApi,
  "reportRendererLog" | "updateChatLayoutPreference"
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

export async function persistChatLayoutPreference(
  api: ChatLayoutPreferenceApi | null,
  update: ChatLayoutPreferenceUpdate,
): Promise<void> {
  if (!api) {
    return;
  }

  try {
    await api.updateChatLayoutPreference(update);
  } catch (error) {
    try {
      api.reportRendererLog({
        level: "error",
        kind: "chat.layout-preference-save-failed",
        message: "Chat layout preference save failed",
        data: { update },
        error: toLogError(error),
      });
    } catch {
      // The local layout remains usable even when both persistence and logging fail.
    }
  }
}
