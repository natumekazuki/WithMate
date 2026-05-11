import { useMemo } from "react";

import AgentSessionWindowApp from "./App.js";
import CompanionReviewApp from "./CompanionReviewApp.js";
import { MateTalkWindowApp } from "./chat/MateTalkWindowApp.js";
import { resolveSessionWindowModeFromSearch } from "./session-window-mode.js";

export default function SessionWindowApp() {
  const sessionWindowMode = useMemo(() => resolveSessionWindowModeFromSearch(window.location.search), []);
  if (sessionWindowMode.kind === "companion") {
    return <CompanionReviewApp />;
  }
  if (sessionWindowMode.kind === "mate-talk") {
    return <MateTalkWindowApp />;
  }

  return <AgentSessionWindowApp />;
}
