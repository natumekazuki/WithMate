/** Home のエントリーで開ける通常画面、独立 Monitor、独立設定の種別。 */
export type HomeWindowMode = "home" | "monitor" | "settings";

/** URL の mode が既知の独立ウィンドウを指す場合だけ切り替え、それ以外は通常の Home にする。 */
export function resolveHomeWindowModeFromSearch(
  search: string,
): HomeWindowMode {
  const mode = new URLSearchParams(search).get("mode");
  return mode === "monitor" || mode === "settings" ? mode : "home";
}

/** 現在のウィンドウの URL から種別を取得し、ブラウザー外では Home を返す。 */
export function getHomeWindowMode(): HomeWindowMode {
  if (typeof window === "undefined") {
    return "home";
  }

  return resolveHomeWindowModeFromSearch(window.location.search);
}

/** Window の種類ごとに、文書に付ける固有のタイトルを返す。 */
export function resolveHomeWindowTitle(mode: HomeWindowMode): string {
  switch (mode) {
    case "monitor":
      return "Session Monitor";
    case "settings":
      return "Settings";
    default:
      return "Home";
  }
}
