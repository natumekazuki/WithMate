import { useEffect, useState } from "react";
import { getWithMateApi } from "../app/renderer-withmate-api.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { LoadError } from "../ui/load-error.js";

export function AppVersion() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ status: "loading" | "error" } | { status: "loaded"; version: string }>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    const api = getWithMateApi();
    if (!api) {
      setState({ status: "error" });
    } else {
      void Promise.resolve().then(() => api.getAppVersion()).then(
        (version) => { if (active) setState({ status: "loaded", version }); },
        () => { if (active) setState({ status: "error" }); },
      );
    }
    return () => { active = false; };
  }, [attempt]);

  return (
    <div className="settings-app-version">
      <span className="settings-provider-name">App Version</span>
      {state.status === "loading" ? <LoadingIndicator label="Loading app version" inline /> : null}
      {state.status === "loaded" ? <span>{state.version}</span> : null}
      {state.status === "error" ? <LoadError message="Could not load app version." onRetry={() => setAttempt((value) => value + 1)} /> : null}
    </div>
  );
}
