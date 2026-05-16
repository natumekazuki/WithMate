import { withWithMateApi } from "../renderer-withmate-api.js";
import type { MateTalkLaunchInput } from "../mate/mate-state.js";

export async function openMateTalkWindow(input?: MateTalkLaunchInput | null) {
  await withWithMateApi((api) => input ? api.openMateTalkWindow(input) : api.openMateTalkWindow());
}

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

export async function openMemoryManagementWindow() {
  await withWithMateApi((api) => api.openMemoryManagementWindow());
}

export async function openCompanionReviewWindow(sessionId: string) {
  await withWithMateApi((api) => api.openCompanionReviewWindow(sessionId));
}
