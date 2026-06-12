import assert from "node:assert/strict";
import test from "node:test";

import { resolveChatHeaderVisibility } from "../../src/chat/chat-header-visibility.js";

test("resolveChatHeaderVisibility は通常 session の header 操作を capability で返す", () => {
  assert.deepEqual(resolveChatHeaderVisibility({}), {
    showRenameButton: true,
    showAuditLogButton: true,
    showDeleteButton: true,
  });
  assert.deepEqual(resolveChatHeaderVisibility({ canDeleteSession: false }), {
    showRenameButton: true,
    showAuditLogButton: true,
    showDeleteButton: false,
  });
  assert.deepEqual(resolveChatHeaderVisibility({ canViewAuditLog: false }), {
    showRenameButton: true,
    showAuditLogButton: false,
    showDeleteButton: true,
  });
});

test("resolveChatHeaderVisibility は Auxiliary mode で parent 操作を隠す", () => {
  assert.deepEqual(resolveChatHeaderVisibility({
    isAuxiliaryMode: true,
    canDeleteSession: true,
    canViewAuditLog: true,
  }), {
    showRenameButton: false,
    showAuditLogButton: false,
    showDeleteButton: false,
  });
  assert.deepEqual(resolveChatHeaderVisibility({
    isAuxiliaryMode: true,
    canViewAuxiliaryAuditLog: true,
    canDeleteSession: false,
    canViewAuditLog: true,
  }), {
    showRenameButton: false,
    showAuditLogButton: true,
    showDeleteButton: false,
  });
  assert.deepEqual(resolveChatHeaderVisibility({
    isAuxiliaryMode: true,
    canViewAuxiliaryAuditLog: true,
    canDeleteSession: false,
    canViewAuditLog: false,
  }), {
    showRenameButton: false,
    showAuditLogButton: false,
    showDeleteButton: false,
  });
});
