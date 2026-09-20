import { withWithMateApi } from "../renderer-withmate-api.js";

export async function openSessionWindow(sessionId: string, auxiliarySessionId?: string) {
  await withWithMateApi((api) =>
    auxiliarySessionId === undefined
      ? api.openSession(sessionId)
      : api.openSession(sessionId, auxiliarySessionId),
  );
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

export async function openMemoryV6ReviewWindow() {
  await withWithMateApi((api) => api.openMemoryV6ReviewWindow());
}

export async function openCharacterEditorWindow(characterId?: string | null) {
  await withWithMateApi((api) => api.openCharacterEditorWindow(characterId ?? null));
}
