import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CrewDeletionDialog } from "../../src/coordination/CrewDeletionDialog.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { CrewDeletionStatus } from "../../src-shared/session/session-crew-deletion.js";

// @test-value v2
// kind = "contract"
// claim = "Crew削除確認はCancelに初期focusを置き、許可後もCancelでは削除せず、明示Deleteだけで削除する。相談解決後も残ったqueueの拒否は表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md 通常Sessionの起点headerのDelete Crew" }
// fault = "危険側に初期focusを置く、Cancelで削除する、相談表示の消失でqueueの拒否を見落とす、または可否更新だけで自動削除する"
// observable = "CancelのactiveElement、取消callbackと削除呼出数、各blocker表示とDelete Crewのdisabled、明示削除後の完了callback"
// observation_boundary = "component-behavior"
// scope = "CrewDeletionDialogの保存statusと削除操作"
// lifecycle = "permanent"
// impact = "未対応相談や受理済み入力を保持したCrewの削除を誤って促さず、core再検証と明示操作を維持する"
// distinction = "storage guardのtestと異なり、状態更新がGUI操作可否へ投影される境界を確認する"
// @end-test-value
test("Crew deletion keeps remaining queue blockers after Coordination resolves", async () => {
  const dom = new JSDOM('<!doctype html><button id="opener">Delete Crew</button><div id="root"></div>');
  const globals = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  globals.forEach((name) => Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name] }));
  let status: CrewDeletionStatus = { allowed: false, blockers: [{ kind: "coordination", id: "consult", sessionId: "other-branch", message: "Unresolved consultation in another branch." }, { kind: "queue", id: "receipt", message: "Accepted input remains." }] };
  let changed = () => {};
  let deletes = 0;
  let closes = 0;
  let completed = 0;
  const api = {
    async getCrewDeletionStatus(id: string, incarnation: string) { assert.equal(id, "root"); assert.equal(incarnation, "inc"); return status; },
    subscribeCoordinationChanged(listener: () => void) { changed = listener; return () => {}; },
    subscribeLiveSessionRunStatus() { return () => {}; },
    async deleteSession(id: string) { assert.equal(id, "root"); deletes += 1; return true; },
  } as unknown as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const opener = dom.window.document.getElementById("opener")!;
  const render = () => root.render(createElement(CrewDeletionDialog, {
    api, sessionId: "root", incarnationId: "inc", title: "Root",
    onClose() { closes += 1; root.render(null); },
    onDeleted() { completed += 1; },
  }));
  const action = (name: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((button) => button.textContent?.trim() === name)!;
  const deleteButton = () => action("Delete Crew");
  try {
    opener.focus();
    const originalSetTimeout = dom.window.setTimeout;
    const zeroDelayCallbacks: Array<() => void> = [];
    dom.window.setTimeout = (handler, delay, ...args) => {
      if (delay === 0 && typeof handler === "function") {
        zeroDelayCallbacks.push(() => handler(...args));
        return 0;
      }
      return originalSetTimeout.call(dom.window, handler, delay, ...args);
    };
    try {
      await act(async () => render());
      assert.equal(action("Open Coordination").disabled, false);
      // Status can resolve before the focus task: even then, prefer Cancel over the recovery control.
      zeroDelayCallbacks.forEach((callback) => callback());
    } finally {
      dom.window.setTimeout = originalSetTimeout;
    }
    assert.equal(dom.window.document.activeElement, action("Cancel"));
    assert.equal(deleteButton().disabled, true);
    assert.match(dom.window.document.body.textContent!, /Unresolved consultation in another branch/);
    status = { allowed: false, blockers: [{ kind: "queue", id: "receipt", message: "Accepted input remains." }] };
    await act(async () => changed());
    assert.equal(deleteButton().disabled, true);
    assert.match(dom.window.document.body.textContent!, /Accepted input remains/);
    assert.equal(deletes, 0);
    status = { allowed: true, blockers: [] };
    await act(async () => changed());
    assert.equal(deleteButton().disabled, false);
    assert.equal(deletes, 0);
    await act(async () => action("Cancel").click());
    assert.equal(closes, 1);
    assert.equal(deletes, 0);
    assert.equal(dom.window.document.querySelector("[role=dialog]"), null);
    assert.equal(dom.window.document.activeElement, opener);
    await act(async () => render());
    await act(async () => deleteButton().click());
    assert.equal(deletes, 1);
    assert.equal(completed, 1);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    globals.forEach((name, index) => { const descriptor = saved[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});
