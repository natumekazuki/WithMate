/** チャットウィンドウで選択できる描画モード。現在は Agent Session 用のみ。 */
export type ChatWindowModeKind = "agent";

/** 開くモードと URL が指定した対象 Session。ID が未指定なら null。 */
export type ChatWindowMode = { kind: "agent"; sessionId: string | null };

/** 宣言済みの各モードに、対応する描画先を割り当てる。 */
export type ChatWindowModeTargets<T> = Record<ChatWindowModeKind, T>;

/** Agent モードの入力として URL の Session ID を読み、存在しない場合は null を残す。 */
export function resolveChatWindowModeFromSearch(
  search: string,
): ChatWindowMode {
  const query = new URLSearchParams(search);
  return { kind: "agent", sessionId: query.get("sessionId") };
}

/** 確定済みのモードに紐付く描画先を、呼び出し側が用意した表から引く。 */
export function resolveChatWindowModeTarget<T>(
  mode: ChatWindowMode,
  targets: ChatWindowModeTargets<T>,
): T {
  return targets[mode.kind];
}
