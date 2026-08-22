import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionHeader } from "../../src/session-components.js";

import {
  buildLiveSessionHeaderProps,
  createAuxiliaryHeaderActions,
  createMessageCollapseHeaderAction,
  createWorkspaceExplorerAction,
  resolveAuxiliaryHeaderActionState,
} from "../../src/chat/chat-header-actions.js";
const noop = () => {};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("SessionHeader は低頻度の管理操作を menu にまとめる", () => {
  const html = renderToStaticMarkup(
    <SessionHeader
      taskTitle="Session"
      isEditingTitle={false}
      titleDraft="Session"
      isRunning={false}
      onOpenAuditLog={noop}
      onOpenTerminal={noop}
      onTitleDraftChange={noop}
      onTitleInputKeyDown={noop}
      onSaveTitle={noop}
      onCancelTitleEdit={noop}
      onStartTitleEdit={noop}
      onDeleteSession={noop}
      onTogglePin={noop}
    />,
  );

  assert.match(html, /<summary aria-label="Session actions"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /role="menu"/);
  assert.match(html, /role="menuitem" aria-pressed="false">ピン止め<\/button>/);
  assert.match(html, /role="menuitem">Rename<\/button>/);
  assert.match(html, /role="menuitem">Audit Log<\/button>/);
  assert.match(html, /role="menuitem">Delete<\/button>/);
});

test("SessionHeader menu は外側操作、Escape、項目実行、trigger 再クリックで閉じる", async () => {
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    PointerEvent: globalThis.PointerEvent,
  };
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div><button id=\"outside\">Outside</button></body></html>", {
    pretendToBeVisual: true,
  });
  const container = dom.window.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  const actions: string[] = [];

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    Node: { configurable: true, value: dom.window.Node },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Event: { configurable: true, value: dom.window.Event },
    MouseEvent: { configurable: true, value: dom.window.MouseEvent },
    KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
    PointerEvent: { configurable: true, value: dom.window.PointerEvent ?? dom.window.MouseEvent },
  });

  try {
    await act(async () => root.render(
      <SessionHeader
        taskTitle="Session"
        isEditingTitle={false}
        titleDraft="Session"
        isRunning={false}
        onOpenAuditLog={() => actions.push("audit")}
        onOpenTerminal={noop}
        onTitleDraftChange={noop}
        onTitleInputKeyDown={noop}
        onSaveTitle={noop}
        onCancelTitleEdit={noop}
        onStartTitleEdit={() => actions.push("rename")}
        onDeleteSession={() => actions.push("delete")}
        onTogglePin={() => actions.push("pin")}
      />,
    ));

    const details = container.querySelector<HTMLDetailsElement>("details.session-header-more");
    const trigger = container.querySelector<HTMLElement>("summary[aria-label=\"Session actions\"]");
    assert.ok(details);
    assert.ok(trigger);

    await act(async () => trigger.click());
    assert.equal(details.open, true);
    await act(async () => trigger.click());
    assert.equal(details.open, false);

    await act(async () => trigger.click());
    await act(async () => {
      dom.window.document.getElementById("outside")?.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    });
    assert.equal(details.open, false);

    await act(async () => trigger.click());
    container.querySelector<HTMLButtonElement>("[role=\"menuitem\"]")?.focus();
    await act(async () => {
      details.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(details.open, false);
    assert.equal(dom.window.document.activeElement, trigger);

    for (const [label, action] of [["ピン止め", "pin"], ["Rename", "rename"], ["Audit Log", "audit"], ["Delete", "delete"]]) {
      await act(async () => trigger.click());
      const item = [...container.querySelectorAll<HTMLButtonElement>("[role=\"menuitem\"]")]
        .find((button) => button.textContent === label);
      assert.ok(item);
      await act(async () => item.click());
      assert.equal(details.open, false);
      assert.equal(actions.at(-1), action);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: previousGlobals.window },
      document: { configurable: true, value: previousGlobals.document },
      Node: { configurable: true, value: previousGlobals.Node },
      HTMLElement: { configurable: true, value: previousGlobals.HTMLElement },
      Event: { configurable: true, value: previousGlobals.Event },
      MouseEvent: { configurable: true, value: previousGlobals.MouseEvent },
      KeyboardEvent: { configurable: true, value: previousGlobals.KeyboardEvent },
      PointerEvent: { configurable: true, value: previousGlobals.PointerEvent },
    });
  }
});

test("createWorkspaceExplorerAction は共通の workspace Explorer action を描画する", () => {
  const html = renderToStaticMarkup(createWorkspaceExplorerAction({ onOpenExplorer: noop }));

  assert.match(html, /class="drawer-toggle compact secondary"/);
  assert.match(html, /type="button"/);
  assert.match(html, />Explorer<\/button>/);
  assert.doesNotMatch(html, /disabled/);
});

test("createWorkspaceExplorerAction は disabled state を反映する", () => {
  const html = renderToStaticMarkup(createWorkspaceExplorerAction({
    disabled: true,
    onOpenExplorer: noop,
  }));

  assert.match(html, /disabled=""/);
});

test("createMessageCollapseHeaderAction は既存header button語彙とshortcut名を使う", () => {
  const html = renderToStaticMarkup(createMessageCollapseHeaderAction({
    allMessagesCollapsed: false,
    onToggle: noop,
  }));

  assert.match(html, /class="drawer-toggle compact secondary"/);
  assert.match(html, /aria-label="完了済みmessageをすべて縮小"/);
  assert.match(html, /title="完了済みmessageをすべて縮小 \(Ctrl\+Shift\+M\)"/);
  assert.match(html, />Collapse<\/button>/);

  const expandedHtml = renderToStaticMarkup(createMessageCollapseHeaderAction({
    allMessagesCollapsed: true,
    onToggle: noop,
  }));
  assert.match(expandedHtml, />Expand<\/button>/);
});

test("SessionHeader はmessage collapse actionをAuxiliaryの左隣へ描画する", () => {
  const html = renderToStaticMarkup(
    <SessionHeader
      taskTitle="Session"
      isEditingTitle={false}
      titleDraft="Session"
      isRunning={false}
      actions={(
        <>
          {createMessageCollapseHeaderAction({ allMessagesCollapsed: false, onToggle: noop })}
          {createAuxiliaryHeaderActions({
            isActive: false,
            onStart: noop,
            onReturnToMain: noop,
          })}
        </>
      )}
      showTerminalButton={false}
      showRenameButton={false}
      showAuditLogButton={false}
      showDeleteButton={false}
      onOpenAuditLog={noop}
      onOpenTerminal={noop}
      onTitleDraftChange={noop}
      onTitleInputKeyDown={noop}
      onSaveTitle={noop}
      onCancelTitleEdit={noop}
      onStartTitleEdit={noop}
      onDeleteSession={noop}
    />,
  );

  assert.ok(
    html.indexOf('aria-label="完了済みmessageをすべて縮小"')
      < html.indexOf('aria-label="Auxiliary session actions"'),
  );
});

test("createAuxiliaryHeaderActions は idle 時の Auxiliary start action を描画する", () => {
  const html = renderToStaticMarkup(createAuxiliaryHeaderActions({
    isActive: false,
    startDisabled: true,
    onStart: noop,
    onReturnToMain: noop,
  }));

  assert.match(html, /aria-label="Auxiliary session actions"/);
  assert.doesNotMatch(html, /session-window-control-group-label/);
  assert.match(html, />Auxiliary<\/button>/);
  assert.match(html, /disabled=""/);
});

test("createAuxiliaryHeaderActions は active 時の Return action を描画する", () => {
  const html = renderToStaticMarkup(createAuxiliaryHeaderActions({
    isActive: true,
    returnDisabled: true,
    onStart: noop,
    onReturnToMain: noop,
  }));

  assert.match(html, /<span class="session-window-control-group-label">Auxiliary<\/span>/);
  assert.match(html, />Return to main<\/button>/);
  assert.match(html, /disabled=""/);
});

test("createAuxiliaryHeaderActions は idle label を任意に表示する", () => {
  const html = renderToStaticMarkup(createAuxiliaryHeaderActions({
    isActive: false,
    showIdleLabel: true,
    onStart: noop,
    onReturnToMain: noop,
  }));

  assert.match(html, /<span class="session-window-control-group-label">Auxiliary<\/span>/);
  assert.match(html, />Auxiliary<\/button>/);
});

test("resolveAuxiliaryHeaderActionState は start/return disabled state を解決する", () => {
  assert.deepEqual(
    resolveAuxiliaryHeaderActionState({
      isActive: true,
      showIdleLabel: true,
      isActionPending: false,
      isStartBlocked: false,
      activeRunState: "running",
    }),
    {
      isActive: true,
      showIdleLabel: true,
      startDisabled: false,
      returnDisabled: true,
    },
  );
  assert.deepEqual(
    resolveAuxiliaryHeaderActionState({
      isActive: false,
      isActionPending: true,
      isStartBlocked: false,
      activeRunState: null,
    }),
    {
      isActive: false,
      showIdleLabel: undefined,
      startDisabled: true,
      returnDisabled: true,
    },
  );
  assert.deepEqual(
    resolveAuxiliaryHeaderActionState({
      isActive: false,
      isActionPending: false,
      isStartBlocked: true,
      activeRunState: "idle",
    }),
    {
      isActive: false,
      showIdleLabel: undefined,
      startDisabled: true,
      returnDisabled: false,
    },
  );
});

test("buildLiveSessionHeaderProps は live session header の共通 action を組み立てる", () => {
  const onOpenSessionFilesExplorer = () => {};
  const onOpenSessionFilesTerminal = () => {};
  const onOpenWorkspaceExplorer = () => {};
  const props = buildLiveSessionHeaderProps({
    taskTitle: "Session",
    isEditingTitle: false,
    titleDraft: "Session",
    isRunning: false,
    isAuxiliaryMode: true,
    canViewAuxiliaryAuditLog: true,
    canDeleteSession: true,
    canViewAuditLog: true,
    onOpenAuditLog: noop,
    onOpenTerminal: noop,
    onOpenSessionFilesExplorer,
    onOpenSessionFilesTerminal,
    onTitleDraftChange: noop,
    onTitleInputKeyDown: noop,
    onSaveTitle: noop,
    onCancelTitleEdit: noop,
    onStartTitleEdit: noop,
    onDeleteSession: noop,
    onOpenWorkspaceExplorer,
  });
  const workspaceHtml = renderToStaticMarkup(props.workspaceActions);
  const sessionFilesHtml = renderToStaticMarkup(props.sessionFilesActions);

  assert.equal(props.taskTitle, "Session");
  assert.equal(props.showRenameButton, false);
  assert.equal(props.showAuditLogButton, true);
  assert.equal(props.showDeleteButton, false);
  assert.match(workspaceHtml, />Explorer<\/button>/);
  assert.match(sessionFilesHtml, />Explorer<\/button>/);
  assert.match(sessionFilesHtml, />Terminal<\/button>/);
});

test("SessionHeader はpin stateとpending stateを操作ボタンへ投影する", () => {
  const html = renderToStaticMarkup(<SessionHeader
    taskTitle="Pinned session"
    isEditingTitle={false}
    titleDraft="Pinned session"
    isRunning={true}
    isReadOnly={true}
    isPinned={true}
    isPinPending={true}
    showRenameButton={false}
    showAuditLogButton={false}
    showTerminalButton={false}
    showDeleteButton={false}
    onTogglePin={noop}
    onOpenAuditLog={noop}
    onOpenTerminal={noop}
    onTitleDraftChange={noop}
    onTitleInputKeyDown={noop}
    onSaveTitle={noop}
    onCancelTitleEdit={noop}
    onStartTitleEdit={noop}
    onDeleteSession={noop}
  />);

  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /role="menu"/);
  assert.match(html, /role="menuitem"/);
  assert.match(html, /disabled=""/);
  assert.match(html, />変更中\.\.\.<\/button>/);
});
