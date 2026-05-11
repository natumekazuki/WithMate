import { useMemo } from "react";

import AgentSessionWindowApp from "./App.js";
import CompanionReviewApp from "./CompanionReviewApp.js";
import { MateTalkWindowApp } from "./chat/MateTalkWindowApp.js";
import { resolveSessionWindowModeFromSearch, resolveSessionWindowModeTarget } from "./session-window-mode.js";

const sessionWindowApps = {
  agent: AgentSessionWindowApp,
  companion: CompanionReviewApp,
  "mate-talk": MateTalkWindowApp,
};

export default function SessionWindowApp() {
  const sessionWindowMode = useMemo(() => resolveSessionWindowModeFromSearch(window.location.search), []);
  const ModeApp = resolveSessionWindowModeTarget(sessionWindowMode, sessionWindowApps);

  return <ModeApp />;
}
