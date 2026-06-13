export type HomeWindowMode = "home" | "monitor" | "settings";

export function resolveHomeWindowModeFromSearch(search: string): HomeWindowMode {
  const mode = new URLSearchParams(search).get("mode");
  return mode === "monitor" || mode === "settings" ? mode : "home";
}

export function getHomeWindowMode(): HomeWindowMode {
  if (typeof window === "undefined") {
    return "home";
  }

  return resolveHomeWindowModeFromSearch(window.location.search);
}
