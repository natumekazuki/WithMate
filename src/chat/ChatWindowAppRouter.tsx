import { useMemo } from "react";

import AgentSessionWindowApp from "../App.js";
import { CompanionChatModeApp } from "../CompanionReviewApp.js";
import { resolveChatWindowModeFromSearch, resolveChatWindowModeTarget } from "./chat-window-mode.js";
import { MateTalkChatModeApp } from "./MateTalkChatModeApp.js";

const chatWindowApps = {
  agent: AgentSessionWindowApp,
  companion: CompanionChatModeApp,
  "mate-talk": MateTalkChatModeApp,
};

export default function ChatWindowAppRouter() {
  const chatWindowMode = useMemo(() => resolveChatWindowModeFromSearch(window.location.search), []);
  const ModeApp = resolveChatWindowModeTarget(chatWindowMode, chatWindowApps);

  return <ModeApp />;
}
