import { withWithMateApi } from "../renderer-withmate-api.js";

export async function openMateTalkWindow() {
  await withWithMateApi((api) => api.openMateTalkWindow());
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
