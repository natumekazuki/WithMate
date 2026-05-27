import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildLiveSessionHeaderProps,
  createAuxiliaryHeaderActions,
  createWorkspaceExplorerAction,
} from "../../src/chat/chat-header-actions.js";

const noop = () => {};

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
    onToggleExpanded: noop,
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
