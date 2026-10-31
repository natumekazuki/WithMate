export type HomeWindowMode = "home" | "monitor" | "settings" | "memory-review";

export function resolveHomeWindowModeFromSearch(search: string): HomeWindowMode {
  const mode = new URLSearchParams(search).get("mode");
  return mode === "monitor" || mode === "settings" || mode === "memory-review" ? mode : "home";
}

export function getHomeWindowMode(): HomeWindowMode {
  if (typeof window === "undefined") {
    return "home";
  }

  return resolveHomeWindowModeFromSearch(window.location.search);
}

export function resolveHomeWindowTitle(mode: HomeWindowMode): string {
  switch (mode) {
    case "monitor":
      return "Session Monitor";
    case "settings":
      return "Settings";
    case "memory-review":
      return "Memory Review";
    default:
      return "Home";
  }
}
