import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionHeader } from "../../src/chat/shell/session-header.js";

import {
  buildLiveSessionHeaderProps,
  createMessageCollapseHeaderAction,
  createWorkspaceExplorerAction,
} from "../../src/chat/chat-header-actions.js";
const noop = () => {};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// @test-value v2
// kind = "contract"
// claim = "SessionHeaderは低頻度のsession管理操作をaccessible menu itemとしてPin・Rename・Audit Log・Deleteへまとめる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window" }
// fault = "管理操作を常設してsession headerを圧迫するか、menu itemのaccessible nameまたはpressed stateを失う"
// observable = "Session actions summaryとrole=menu/menuitem、Pinのaria-pressed、各操作label"
// observation_boundary = "component-behavior"
// scope = "SessionHeader management action menu"
// lifecycle = "permanent"
// impact = "session headerの対象と操作を識別し、低頻度操作を一貫したmenuから実行できる"
// distinction = "action builderのpropsだけでなく、実描画されたmenu semanticsと英語labelを確認する"
// @end-test-value
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
  assert.match(html, /role="menuitem" aria-pressed="false" aria-label="Pin">Pin<\/button>/);
  assert.match(html, /role="menuitem">Rename<\/button>/);
  assert.match(html, /role="menuitem">Audit Log<\/button>/);
  assert.match(html, /role="menuitem">Delete<\/button>/);
});

// @test-value v2
// kind = "contract"
// claim = "SessionHeader menuはtrigger再クリック・外側操作・Escape・項目実行の各経路で閉じ、実行したmenu actionを対応callbackへ渡す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window" }
// fault = "menuが閉じずfocusをtriggerへ戻さないか、表示labelとcallback actionの対応を取り違える"
// observable = "details.open、document.activeElement、menu itemの英語label、actions callbackの順序"
// observation_boundary = "component-behavior"
// scope = "SessionHeader menu interaction lifecycle"
// lifecycle = "permanent"
// impact = "menu操作後のfocusと表示状態を予測可能にし、対象session actionを誤実行しない"
// distinction = "静的markupだけでなく、pointerdown・Escape・clickの実DOMイベントによる閉じ方を確認する"
// @end-test-value
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

    for (const [label, action] of [["Pin", "pin"], ["Rename", "rename"], ["Audit Log", "audit"], ["Delete", "delete"]]) {
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

// @test-value v2
// kind = "contract"
// claim = "createMessageCollapseHeaderActionはCollapse/Expandの英語CTAとcompleted messages向けaccessible labelへshortcut名を付与する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window" }
// fault = "collapse状態に応じたCTAまたはaccessible labelを取り違えるか、keyboard shortcut名をtitleから失う"
// observable = "button text、aria-label、titleの文字列とCtrl+Shift+M shortcut"
// observation_boundary = "component-behavior"
// scope = "createMessageCollapseHeaderAction accessible labels"
// lifecycle = "permanent"
// impact = "message collapse actionを視覚表示と支援技術の双方で識別できる"
// distinction = "shortcut registry単体ではなく、header actionとしてrenderされた公開属性を確認する"
// @end-test-value
test("createMessageCollapseHeaderAction は既存header button語彙とshortcut名を使う", () => {
  const html = renderToStaticMarkup(createMessageCollapseHeaderAction({
    allMessagesCollapsed: false,
    onToggle: noop,
  }));

  assert.match(html, /class="drawer-toggle compact secondary"/);
  assert.match(html, /aria-label="Collapse all completed messages"/);
  assert.match(html, /title="Collapse all completed messages \(Ctrl\+Shift\+M\)"/);
  assert.match(html, />Collapse<\/button>/);

  const expandedHtml = renderToStaticMarkup(createMessageCollapseHeaderAction({
    allMessagesCollapsed: true,
    onToggle: noop,
  }));
  assert.match(expandedHtml, />Expand<\/button>/);
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

// @test-value v2
// kind = "invariant"
// claim = "SessionHeaderはpinned stateをaria-pressedへ投影し、pin pending中はmenu itemをdisabledにしてspinnerとaccessible stateを表示する"
// oracle = { type = "contract", ref = "Issue #731 session pin pending state" }
// fault = "pinned stateを反映しないか、pending中もpin操作を許可して重複更新を起こす、または状態を支援技術へ伝えない"
// observable = "pin menu itemのaria-pressed、aria-busy、aria-label、disabled属性、既存spinnerとaccessible state"
// observation_boundary = "component-behavior"
// scope = "SessionHeader pin and pending state"
// lifecycle = "permanent"
// impact = "pin状態を識別し、更新中の重複操作を防ぐ"
// distinction = "pin callbackだけでなく、stateに応じた操作buttonの公開属性とlabelを確認する"
// @end-test-value
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
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-label="Updating pin"/);
  assert.match(html, /<span class="settings-action-spinner" aria-hidden="true"><\/span>/);
  assert.match(html, /<span class="visually-hidden">Updating pin\.<\/span>/);
  assert.doesNotMatch(html, />Updating\.\.\.<\/button>/);
});
