import { withWithMateApi } from "../renderer-withmate-api.js";

export async function openSessionWindow(sessionId: string) {
  await withWithMateApi((api) => api.openSession(sessionId));
}

export async function openHomeWindow() {
  await withWithMateApi((api) => api.openHomeWindow());
}

export async function openSessionMonitorWindow() {
  await withWithMateApi((api) => api.openSessionMonitorWindow());
}

export async function openSettingsWindow() {
  await withWithMateApi((api) => api.openSettingsWindow());
}

export async function openCharacterEditorWindow(characterId?: string | null) {
  await withWithMateApi((api) => api.openCharacterEditorWindow(characterId ?? null));
}

export async function openCompanionReviewWindow(sessionId: string) {
  await withWithMateApi((api) => api.openCompanionReviewWindow(sessionId));
}
