import { useMemo } from "react";

import AgentSessionWindowApp from "../App.js";
import CompanionReviewApp from "../CompanionReviewApp.js";
import { resolveChatWindowModeFromSearch, resolveChatWindowModeTarget } from "./chat-window-mode.js";
import { MateTalkWindowApp } from "./MateTalkWindowApp.js";

const chatWindowApps = {
  agent: AgentSessionWindowApp,
  companion: CompanionReviewApp,
  "mate-talk": MateTalkWindowApp,
};

export default function ChatWindowAppRouter() {
  const chatWindowMode = useMemo(() => resolveChatWindowModeFromSearch(window.location.search), []);
  const ModeApp = resolveChatWindowModeTarget(chatWindowMode, chatWindowApps);

  return <ModeApp />;
}
