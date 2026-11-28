import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { ChatLayoutPreferenceUpdate } from "../../src-shared/settings/chat-layout-preference.js";

/** renderer からレイアウト設定を保存し、保存失敗を記録するのに必要な API。 */
type ChatLayoutPreferenceApi = Pick<
  WithMateWindowApi,
  "reportRendererLog" | "updateChatLayoutPreference"
>;

/** Error の診断は名前・メッセージ・スタックを保持し、その他の失敗は文字列として記録する。 */
function toLogError(error: unknown): {
  name?: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

/** レイアウト変更を保存する。失敗はログに残し、現在の画面での変更を巻き戻さない。 */
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
      // 永続化とログの両方が失敗しても、ローカルのレイアウトは引き続き使える。
    }
  }
}
