import assert from "node:assert/strict";
import test from "node:test";

import { MainWindowFacade } from "../../src-electron/main-window-facade.js";

test("MainWindowFacade は aux/session window service を束ねる", async () => {
  const calls: string[] = [];
  const facade = new MainWindowFacade({
    getAuxWindowService: () =>
      ({
        async openHomeWindow() {
          calls.push("home");
          return { id: "home" };
        },
        async openSessionMonitorWindow() {
          calls.push("monitor");
          return { id: "monitor" };
        },
        async openSettingsWindow() {
          calls.push("settings");
          return { id: "settings" };
        },
        async openCharacterEditorWindow(characterId?: string | null) {
          calls.push(`character:${characterId ?? "new"}`);
          return { id: "character" };
        },
        async openDiffWindow() {
          calls.push("diff");
          return { id: "diff" };
        },
        closeResetTargetWindows() {
          calls.push("close-aux");
        },
      }) as never,
    getSessionWindowBridge: () =>
      ({
        async openSessionWindow(sessionId: string) {
          calls.push(`session:${sessionId}`);
          return { id: sessionId };
        },
        listOpenSessionWindowIds() {
          calls.push("list-session");
          return ["s-1", "s-2"];
        },
        closeAllSessionWindows() {
          calls.push("close-session");
        },
      }) as never,
  });

  await facade.openHomeWindow();
  await facade.openSessionMonitorWindow();
  await facade.openSettingsWindow();
  await facade.openSessionWindow("s-1");
  await facade.openCharacterEditorWindow("c-1");
  await facade.openDiffWindow({ token: "d-1" } as never);
  assert.deepEqual(facade.listOpenSessionWindowIds(), ["s-1", "s-2"]);
  facade.closeResetTargetWindows();

  assert.deepEqual(calls, [
    "home",
    "monitor",
    "settings",
    "session:s-1",
    "character:c-1",
    "diff",
    "list-session",
    "close-session",
    "close-aux",
  ]);
});
