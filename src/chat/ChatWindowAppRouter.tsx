import { useMemo } from "react";

import AgentSessionWindowApp from "../App.js";
import { CompanionChatModeApp } from "./CompanionChatModeApp.js";
import { resolveChatWindowModeFromSearch, resolveChatWindowModeTarget } from "./chat-window-mode.js";

const chatWindowApps = {
  agent: AgentSessionWindowApp,
  companion: CompanionChatModeApp,
};

export default function ChatWindowAppRouter() {
  const chatWindowMode = useMemo(() => resolveChatWindowModeFromSearch(window.location.search), []);
  const ModeApp = resolveChatWindowModeTarget(chatWindowMode, chatWindowApps);

  return <ModeApp />;
}
