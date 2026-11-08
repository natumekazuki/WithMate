import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { Session, SessionSummary } from "../../src-shared/session/session-state.js";
import { SessionHeader } from "../../src/chat/shell/session-header.js";
import { useSessionHeaderOperations } from "../../src/chat/shell/use-session-header-operations.js";

const noop = () => {};
const standalone = { id: "session-a", incarnationId: "incarnation-a", taskTitle: "Planning", sessionKind: "default", sessionRole: "standalone", runState: "idle" } as Session;

function setup(promote: WithMateWindowApi["promoteSessionToOverallCoordinator"]) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  function Harness({ session, readOnly = false }: { session: Session; readOnly?: boolean }) {
    const operations = useSessionHeaderOperations({
      api: { promoteSessionToOverallCoordinator: promote } as WithMateWindowApi,
      selectedSession: session, isReadOnly: readOnly, runState: session.runState,
      updateTitle: async () => undefined, closeWindow: noop,
    });
    return <SessionHeader {...operations.buildChatHeader({
      isRunning: session.runState === "running", isReadOnly: readOnly, isPinned: false, isPinPending: false,
      isWorkspaceAvailable: true, onOpenSessionTerminal: noop, onOpenSessionFilesExplorer: noop,
      onOpenSessionFilesTerminal: noop, onTitleInputKeyDown: noop, onDeleteSession: noop,
      onToggleSessionPin: noop, onOpenSessionExplorer: noop,
    })} />;
  }
  const button = (text: string) => {
    const value = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === text);
    assert.ok(value, text);
    return value;
  };
  return {
    document: dom.window.document, button,
    async render(session = standalone, readOnly = false) { await act(async () => root.render(<Harness session={session} readOnly={readOnly} />)); },
    async open() {
      const trigger = dom.window.document.querySelector<HTMLElement>('summary[aria-label="Session actions"]')!;
      await act(async () => trigger.click());
      await act(async () => button("Change Role…").click());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    },
    async escape() { await act(async () => dom.window.document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); },
    async dispose() { await act(async () => root.unmount()); dom.window.close(); Object.assign(globalThis, previous); },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Role変更は対象と変更先をアプリ内で確認し、Cancel/Escapeでは送信せず、確認後の重複送信を防ぎ、失敗後に同じ対象へ再試行できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 非実行StandaloneのChange Role確認dialog" }
// fault = "確認前または取消後に昇格する、二重送信する、失敗を成功扱いしてdialogを閉じる、またはretryの対象identityを失う"
// observable = "production header/hookが描画するdialog、対象名とrole、focus、busy/disabled、error details、APIへ渡るSession/incarnation"
// observation_boundary = "component-behavior"
// scope = "Session headerからRole変更の確認・取消・失敗・再試行まで"
// lifecycle = "permanent"
// impact = "ユーザーの同意と異なるRole変更や、失敗後に回復できない操作を防ぐ"
// distinction = "IPC/storageの認可testや共通a11y testでは検出できないheader ownerから確認dialogと昇格APIまでの接続を検証する"
// @end-test-value
test("Role変更はアプリ内で確認し、取消・busy・失敗後の再試行を扱う", async () => {
  const calls: string[][] = [];
  let complete!: (value: SessionSummary) => void;
  let fail!: (error: Error) => void;
  const view = setup((...args) => { calls.push(args); return new Promise((resolve, reject) => { complete = resolve; fail = reject; }); });
  try {
    await view.render();
    await view.open();
    assert.deepEqual(calls, []);
    const dialog = view.document.querySelector('[role="dialog"][aria-label="Change Session Role"]');
    assert.ok(dialog);
    assert.match(dialog.textContent!, /Planning.*Overall Coordinator/s);
    assert.equal(view.document.activeElement, view.button("Cancel"));
    await view.escape();
    assert.equal(view.document.querySelector('[role="dialog"]'), null);
    assert.equal(view.document.activeElement?.getAttribute("aria-label"), "Session actions");
    await view.open();
    await act(async () => view.button("Cancel").click());
    assert.deepEqual(calls, []);
    await view.open();
    const confirm = view.button("Change Role");
    await act(async () => { confirm.click(); confirm.click(); });
    assert.deepEqual(calls, [[standalone.id, standalone.incarnationId]]);
    assert.equal(confirm.getAttribute("aria-busy"), "true");
    assert.equal(view.document.activeElement, view.document.querySelector('[aria-label="Change Session Role"] section'));
    assert.equal(view.button("Cancel").disabled, true);
    await view.escape();
    assert.ok(view.document.querySelector('[role="dialog"]'));
    await act(async () => fail(new Error("Session is active.")));
    assert.match(view.document.querySelector('[role="alert"]')?.textContent ?? "", /Role could not be changed/);
    assert.equal(view.button("Change Role").disabled, false);
    await act(async () => view.document.querySelector<HTMLButtonElement>('[aria-label="Role Change Error Details"]')!.click());
    assert.match(view.document.querySelector('[aria-label="Role Change Error Details"][role="dialog"]')?.textContent ?? "", /Session is active/);
    await view.escape();
    assert.ok(view.document.querySelector('[aria-label="Change Session Role"]'));
    await act(async () => view.button("Change Role").click());
    assert.deepEqual(calls, [[standalone.id, standalone.incarnationId], [standalone.id, standalone.incarnationId]]);
    await act(async () => complete(standalone as unknown as SessionSummary));
    assert.equal(view.document.querySelector('[role="dialog"]'), null);
  } finally { await view.dispose(); }
});

// @test-value v2
// kind = "contract"
// claim = "Role確認中に実行開始・read-only化・Session identity変更が起きても古い確認を別対象へ適用しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 自分自身の非実行Standaloneと保存identity" }
// fault = "非同期確認を古い対象または実行中対象へ適用する、または切替後に古い確認画面を再表示する"
// observable = "選択Sessionと状態を更新した後のdialog有無、昇格APIの呼出数と対象"
// observation_boundary = "component-behavior"
// scope = "Role確認中の対象・利用条件の変化"
// lifecycle = "permanent"
// impact = "native確認から非同期dialogになっても、利用者が確認した対象と実行条件を維持する"
// distinction = "Mainの最終認可とは別に、rendererが古い同意を別の表示対象へ持ち越さないことを実イベントで確認する"
// @end-test-value
test("Role確認は対象と実行可否の変化で閉じ、古い同意を持ち越さない", async () => {
  const calls: string[][] = [];
  const view = setup(async (...args) => { calls.push(args); return standalone as unknown as SessionSummary; });
  try {
    await view.render(); await view.open();
    await view.render({ ...standalone, runState: "running" });
    assert.equal(view.document.querySelector('[role="dialog"]'), null);
    await view.render();
    assert.equal(view.document.querySelector('[role="dialog"]'), null);
    await view.open(); await view.render(standalone, true);
    assert.equal(view.document.querySelector('[role="dialog"]'), null);
    await view.render(); await view.open();
    await view.render({ ...standalone, incarnationId: "replacement" });
    assert.equal(view.document.querySelector('[role="dialog"]'), null);
    await view.open();
    await act(async () => view.button("Change Role").click());
    assert.deepEqual(calls, [[standalone.id, "replacement"]]);
  } finally { await view.dispose(); }
});
