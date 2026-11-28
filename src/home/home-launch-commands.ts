import { withWithMateApi } from "../app/renderer-withmate-api.js";

/** 指定 Session を開き、Auxiliary の指定があれば同じウィンドウ内の対象として渡す。 */
export async function openSessionWindow(
  sessionId: string,
  auxiliarySessionId?: string,
) {
  await withWithMateApi((api) =>
    auxiliarySessionId === undefined
      ? api.openSession(sessionId)
      : api.openSession(sessionId, auxiliarySessionId),
  );
}
/** デスクトップ API が使える場合に、通常の Home を開く。 */
export async function openHomeWindow() {
  await withWithMateApi((api) => api.openHomeWindow());
}

/** Home 内のパネル切替ではなく、独立した Monitor を開くよう依頼する。 */
export async function openSessionMonitorWindow() {
  await withWithMateApi((api) => api.openSessionMonitorWindow());
}

/** 独立した設定ウィンドウの表示をデスクトップに依頼する。 */
export async function openSettingsWindow() {
  await withWithMateApi((api) => api.openSettingsWindow());
}

/** 指定 ID の Character 編集を開き、ID を省略した場合は新規作成を開く。 */
export async function openCharacterEditorWindow(characterId?: string | null) {
  await withWithMateApi((api) =>
    api.openCharacterEditorWindow(characterId ?? null),
  );
}
