import { useMemo } from "react";

import AgentSessionWindowApp from "../app/SessionWindowApp.js";
import {
  resolveChatWindowModeFromSearch,
  resolveChatWindowModeTarget,
} from "./chat-window-mode.js";

const chatWindowApps = {
  agent: AgentSessionWindowApp,
};

/** ウィンドウを開いたときの URL でチャットのモードを確定し、対応するアプリを表示する。 */
export default function ChatWindowAppRouter() {
  const chatWindowMode = useMemo(
    () => resolveChatWindowModeFromSearch(window.location.search),
    [],
  );
  const ModeApp = resolveChatWindowModeTarget(chatWindowMode, chatWindowApps);

  return <ModeApp />;
}
