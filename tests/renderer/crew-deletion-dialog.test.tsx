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
// claim = "Crew削除確認は保存側の全体blockerを表示し、相談解決後も受理済みqueueが残る間は削除せず、core許可後の明示操作だけで削除する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/839 Crew全体の削除条件" }
// fault = "相談表示の消失だけで削除可能とする、保存coreのqueue拒否を隠す、または状態更新だけで自動削除する"
// observable = "理由の表示、Delete Crew buttonのdisabled、Coordination更新後のstatus再取得、deleteSession呼出と完了callback"
// observation_boundary = "component-behavior"
// scope = "CrewDeletionDialogの保存statusと削除操作"
// lifecycle = "permanent"
// impact = "未対応相談や受理済み入力を保持したCrewの削除を誤って促さず、core再検証と明示操作を維持する"
// distinction = "storage guardのtestと異なり、状態更新がGUI操作可否へ投影される境界を確認する"
// @end-test-value
test("Crew deletion keeps remaining queue blockers after Coordination resolves", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  globals.forEach((name) => Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name] }));
  let status: CrewDeletionStatus = { allowed: false, blockers: [{ kind: "coordination", id: "consult", sessionId: "other-branch", message: "Unresolved consultation in another branch." }, { kind: "queue", id: "receipt", message: "Accepted input remains." }] };
  let changed = () => {};
  let deletes = 0;
  let completed = 0;
  const api = {
    async getCrewDeletionStatus(id: string, incarnation: string) { assert.equal(id, "root"); assert.equal(incarnation, "inc"); return status; },
    subscribeCoordinationChanged(listener: () => void) { changed = listener; return () => {}; },
    subscribeLiveSessionRunStatus() { return () => {}; },
    async deleteSession(id: string) { assert.equal(id, "root"); deletes += 1; return true; },
  } as unknown as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(CrewDeletionDialog, { api, sessionId: "root", incarnationId: "inc", title: "Root", onClose() {}, onDeleted() { completed += 1; } })));
    const deleteButton = () => [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Delete Crew")!;
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
    await act(async () => deleteButton().click());
    assert.equal(deletes, 1);
    assert.equal(completed, 1);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    globals.forEach((name, index) => { const descriptor = saved[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});
