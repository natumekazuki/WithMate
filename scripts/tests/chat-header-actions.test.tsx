import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildLiveSessionHeaderProps,
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
