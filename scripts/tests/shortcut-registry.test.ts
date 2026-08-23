import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";

import {
  captureShortcutAccelerator,
  DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
  getShortcutHelpProjection,
  getShortcutEntry,
  getShortcutLabel,
  getShortcutTooltip,
  SHORTCUT_COMMAND_IDS,
  SHORTCUT_ENTRIES,
  ShortcutDispatcher,
  ShortcutRegistryError,
  type ShortcutAccelerator,
  type ShortcutEntry,
  updateShortcutBinding,
  validateShortcutEntries,
  validateShortcutSettings,
} from "../../src/shortcut-registry.js";
import {
  isAllowedShortcutAccelerator,
  normalizeKeyboardShortcutSettings,
} from "../../src/keyboard-shortcut-state.js";

function createEntry(overrides: Partial<ShortcutEntry> = {}): ShortcutEntry {
  return {
    id: "command",
    label: "Command",
    kind: "standard",
    scope: "scope",
    accelerators: {
      windows: { key: "k", ctrlKey: true },
      linux: { key: "k", ctrlKey: true },
      macos: { key: "k", metaKey: true },
    },
    allowInEditingTarget: false,
    allowRepeat: false,
    showInHelp: true,
    customizable: false,
    assignment: "existing",
    ...overrides,
  };
}

function installDomGlobals(dom: JSDOM): () => void {
  const keys = ["window", "document", "navigator", "HTMLElement", "Node"] as const;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });

  return () => {
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

function createKeyboardEvent(dom: JSDOM, init: KeyboardEventInit): KeyboardEvent {
  return new dom.window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

describe("shortcut registry validation", () => {
  it("command IDの重複を拒否する", () => {
    assert.throws(
      () => validateShortcutEntries([
        createEntry({ id: "duplicate" }),
        createEntry({ id: "duplicate", label: "Other command" }),
      ]),
      ShortcutRegistryError,
    );
  });

  it("同一scope内のaccelerator衝突を拒否する", () => {
    assert.throws(
      () => validateShortcutEntries([
        createEntry({ id: "first" }),
        createEntry({ id: "second" }),
      ]),
      ShortcutRegistryError,
    );
  });

  it("同時activeになり得るscope間のaccelerator衝突を拒否する", () => {
    assert.throws(
      () => validateShortcutEntries([
        createEntry({ id: "first", scope: "first-scope" }),
        createEntry({ id: "second", scope: "second-scope" }),
      ]),
      ShortcutRegistryError,
    );
  });

  it("相互排他scopeの重複は許可し、同時active化で拒否する", () => {
    const entries = [
      createEntry({ id: "message-find", scope: "message-list" }),
      createEntry({ id: "preview-find", scope: "file-preview" }),
    ];
    assert.doesNotThrow(() => validateShortcutEntries(entries));

    const dom = new JSDOM("<!doctype html><body></body>");
    const restore = installDomGlobals(dom);
    try {
      const dispatcher = new ShortcutDispatcher({ eventTarget: dom.window, entries });
      const releaseMessageScope = dispatcher.registerScope("message-list");
      assert.throws(() => dispatcher.registerScope("file-preview"), ShortcutRegistryError);
      releaseMessageScope();
      dispatcher.dispose();
    } finally {
      restore();
      dom.window.close();
    }
  });

  it("customizableなWithMate assignmentをplatform別のpolicyに限定する", () => {
    const valid = createEntry({
      id: "new-withmate",
      kind: "withmate",
      assignment: "new",
      bindingKind: "letter",
      accelerators: {
        windows: { key: "a", ctrlKey: true, shiftKey: true },
        linux: { key: "a", ctrlKey: true, shiftKey: true },
        macos: { key: "a", metaKey: true, shiftKey: true },
      },
    });
    assert.doesNotThrow(() => validateShortcutEntries([valid]));
    assert.doesNotThrow(() => validateShortcutEntries([{
      ...valid,
      id: "alt-shift-withmate",
      accelerators: {
        windows: { key: "a", altKey: true, shiftKey: true },
        linux: { key: "a", altKey: true, shiftKey: true },
        macos: { key: "a", metaKey: true, altKey: true },
      },
    }]));

    const invalidAccelerators: ShortcutAccelerator[] = [
      { key: "a", ctrlKey: true },
      { key: "1", ctrlKey: true, shiftKey: true },
      { key: "a", ctrlKey: true, shiftKey: true, altKey: true },
    ];
    for (const accelerator of invalidAccelerators) {
      assert.throws(
        () => validateShortcutEntries([{
          ...valid,
          id: `invalid-${accelerator.key}`,
          accelerators: {
            windows: accelerator,
            linux: valid.accelerators.linux,
            macos: valid.accelerators.macos,
          },
        }]),
        ShortcutRegistryError,
      );
    }

    assert.throws(
      () => validateShortcutEntries([{
        ...valid,
        id: "invalid-macos",
        accelerators: {
          windows: valid.accelerators.windows,
          linux: valid.accelerators.linux,
          macos: { key: "a", ctrlKey: true, shiftKey: true },
        },
      }]),
      ShortcutRegistryError,
    );
  });

  it("shortcut policyは文字入力を奪う組み合わせとcollisionを拒否する", () => {
    assert.equal(
      isAllowedShortcutAccelerator({ key: "x", ctrlKey: true, shiftKey: true }, "windows", "letter"),
      true,
    );
    assert.equal(
      isAllowedShortcutAccelerator({ key: "x", altKey: true, shiftKey: true }, "linux", "letter"),
      true,
    );
    assert.equal(
      isAllowedShortcutAccelerator({ key: "x", metaKey: true, shiftKey: true }, "macos", "letter"),
      true,
    );
    assert.equal(
      isAllowedShortcutAccelerator({ key: "x", metaKey: true, altKey: true }, "macos", "letter"),
      true,
    );

    for (const accelerator of [
      { key: "x" },
      { key: "x", shiftKey: true },
      { key: "x", altKey: true },
      { key: "x", ctrlKey: true, altKey: true },
    ]) {
      assert.equal(
        isAllowedShortcutAccelerator(accelerator, "windows", "letter"),
        false,
      );
    }

    assert.equal(
      isAllowedShortcutAccelerator({ key: "Enter", ctrlKey: true }, "windows", "enter"),
      true,
    );
    assert.equal(
      isAllowedShortcutAccelerator({ key: "Enter", altKey: true }, "windows", "enter"),
      true,
    );
    assert.equal(
      isAllowedShortcutAccelerator({ key: "Enter", metaKey: true }, "macos", "enter"),
      true,
    );
    assert.equal(
      isAllowedShortcutAccelerator({ key: "Enter", altKey: true }, "macos", "enter"),
      true,
    );
    assert.equal(
      isAllowedShortcutAccelerator({ key: "Enter", ctrlKey: true, altKey: true }, "windows", "enter"),
      false,
    );

    const captured = captureShortcutAccelerator({
      key: "X",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      isComposing: false,
      repeat: false,
    });
    assert.equal(captured.kind, "accepted");
    if (captured.kind === "accepted") {
      assert.throws(
        () => updateShortcutBinding(
          DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
          SHORTCUT_COMMAND_IDS.messageToggleCollapse,
          "windows",
          captured.accelerator,
        ),
        /Invalid keyboard shortcut accelerator/,
      );
    }

    assert.throws(
      () => updateShortcutBinding(
        DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
        SHORTCUT_COMMAND_IDS.messageToggleCollapse,
        "windows",
        { key: "f", ctrlKey: true },
      ),
      /Invalid keyboard shortcut accelerator/,
    );
  });

  it("保存済み設定の無効platform overrideを除外し、有効なoverrideを保持する", () => {
    const normalized = normalizeKeyboardShortcutSettings({
      overrides: {
        [SHORTCUT_COMMAND_IDS.messageToggleCollapse]: {
          windows: { key: "x" },
          linux: { key: "x", altKey: true, shiftKey: true },
          macos: { key: "x", metaKey: true, shiftKey: true },
        },
        [SHORTCUT_COMMAND_IDS.composerSubmit]: {
          windows: { key: "Enter", ctrlKey: true, altKey: true },
        },
        [SHORTCUT_COMMAND_IDS.messageFind]: {
          windows: { key: "g", ctrlKey: true },
        },
        "unknown.command": {
          windows: { key: "x", ctrlKey: true, shiftKey: true },
        },
      },
    });

    assert.deepEqual(normalized.overrides, {
      [SHORTCUT_COMMAND_IDS.messageToggleCollapse]: {
        linux: { key: "x", altKey: true, shiftKey: true },
        macos: { key: "x", metaKey: true, shiftKey: true },
      },
    });

    const collisionPolicy = [
      {
        id: "first",
        scope: "scope",
        accelerators: {
          windows: { key: "a", ctrlKey: true, shiftKey: true },
          linux: { key: "a", ctrlKey: true, shiftKey: true },
          macos: { key: "a", metaKey: true, shiftKey: true },
        },
        customizable: true,
        bindingKind: "letter",
      },
      {
        id: "second",
        scope: "scope",
        accelerators: {
          windows: { key: "b", ctrlKey: true, shiftKey: true },
          linux: { key: "b", ctrlKey: true, shiftKey: true },
          macos: { key: "b", metaKey: true, shiftKey: true },
        },
        customizable: true,
        bindingKind: "letter",
      },
    ] as const;
    assert.deepEqual(
      normalizeKeyboardShortcutSettings({
        overrides: {
          first: {
            windows: { key: "b", ctrlKey: true, shiftKey: true },
          },
        },
      }, collisionPolicy).overrides,
      {},
    );

    const firstEntry = createEntry({
      id: "first",
      customizable: true,
      bindingKind: "letter",
      accelerators: {
        windows: { key: "a", ctrlKey: true, shiftKey: true },
        linux: { key: "a", ctrlKey: true, shiftKey: true },
        macos: { key: "a", metaKey: true, shiftKey: true },
      },
    });
    const secondEntry = createEntry({
      id: "second",
      customizable: true,
      bindingKind: "letter",
      accelerators: {
        windows: { key: "b", ctrlKey: true, shiftKey: true },
        linux: { key: "b", ctrlKey: true, shiftKey: true },
        macos: { key: "b", metaKey: true, shiftKey: true },
      },
    });
    assert.throws(
      () => validateShortcutSettings([firstEntry, secondEntry], {
        overrides: {
          first: {
            windows: { key: "b", ctrlKey: true, shiftKey: true },
          },
        },
      }),
      ShortcutRegistryError,
    );
  });
});

describe("shortcut projection", () => {
  it("platform modifierとHelp projectionが同じregistryから生成される", () => {
    assert.equal(getShortcutLabel("session.composer.submit", "windows"), "Ctrl+Enter");
    assert.equal(getShortcutLabel("session.composer.submit", "linux"), "Ctrl+Enter");
    assert.equal(getShortcutLabel("session.composer.submit", "macos"), "⌘Enter");

    const groups = getShortcutHelpProjection("macos");
    const sendItem = groups
      .flatMap((group) => group.items)
      .find((item) => item.id === "session.composer.submit");
    assert.deepEqual(sendItem, {
      id: "session.composer.submit",
      label: "Send message",
      acceleratorLabel: "⌘Enter",
    });
    assert.equal(
      getShortcutEntry(SHORTCUT_COMMAND_IDS.composerSubmit).customizable,
      true,
    );

    const windowsSettings = updateShortcutBinding(
      DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
      SHORTCUT_COMMAND_IDS.composerSubmit,
      "windows",
      { key: "Enter", altKey: true },
    );
    assert.equal(
      getShortcutLabel(SHORTCUT_COMMAND_IDS.composerSubmit, "windows", windowsSettings),
      "Alt+Enter",
    );
    assert.equal(
      getShortcutTooltip(SHORTCUT_COMMAND_IDS.composerSubmit, "windows", windowsSettings),
      "Send message (Alt+Enter)",
    );
    const windowsHelpItem = getShortcutHelpProjection("windows", windowsSettings)
      .flatMap((group) => group.items)
      .find((item) => item.id === SHORTCUT_COMMAND_IDS.composerSubmit);
    assert.equal(windowsHelpItem?.acceleratorLabel, "Alt+Enter");

    const resetSettings = updateShortcutBinding(
      windowsSettings,
      SHORTCUT_COMMAND_IDS.composerSubmit,
      "windows",
      null,
    );
    assert.equal(
      getShortcutLabel(SHORTCUT_COMMAND_IDS.composerSubmit, "windows", resetSettings),
      "Ctrl+Enter",
    );
  });

  it("message collapse shortcut はplatform acceleratorとHelp projectionをregistryから共有する", () => {
    const entry = SHORTCUT_ENTRIES.find((candidate) => candidate.id === SHORTCUT_COMMAND_IDS.messageToggleCollapse);
    assert.ok(entry);
    assert.deepEqual(entry.accelerators, {
      windows: { key: "m", ctrlKey: true, shiftKey: true },
      linux: { key: "m", ctrlKey: true, shiftKey: true },
      macos: { key: "m", metaKey: true, shiftKey: true },
    });
    assert.equal(entry.scope, "message-list");
    assert.equal(entry.allowInEditingTarget, true);
    assert.equal(entry.allowRepeat, false);
    assert.equal(getShortcutLabel(SHORTCUT_COMMAND_IDS.messageToggleCollapse, "windows"), "Ctrl+Shift+M");
    assert.equal(getShortcutLabel(SHORTCUT_COMMAND_IDS.messageToggleCollapse, "macos"), "⌘⇧M");
    const helpItem = getShortcutHelpProjection("windows")
      .flatMap((group) => group.items)
      .find((item) => item.id === SHORTCUT_COMMAND_IDS.messageToggleCollapse);
    assert.deepEqual(helpItem, {
      id: SHORTCUT_COMMAND_IDS.messageToggleCollapse,
      label: "Toggle message collapse",
      acceleratorLabel: "Ctrl+Shift+M",
    });
  });

  it("ユーザー設定のoverrideを実効labelとHelp projectionへ反映する", () => {
    const settings = updateShortcutBinding(
      DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
      SHORTCUT_COMMAND_IDS.messageToggleCollapse,
      "windows",
      { key: "x", ctrlKey: true, shiftKey: true },
    );

    assert.equal(getShortcutLabel(SHORTCUT_COMMAND_IDS.messageToggleCollapse, "windows", settings), "Ctrl+Shift+X");
    assert.equal(
      getShortcutLabel(SHORTCUT_COMMAND_IDS.messageFind, "windows", {
        overrides: {
          [SHORTCUT_COMMAND_IDS.messageFind]: {
            windows: { key: "g", ctrlKey: true },
          },
        },
      }),
      "Ctrl+F",
    );
    const helpItem = getShortcutHelpProjection("windows", settings)
      .flatMap((group) => group.items)
      .find((item) => item.id === SHORTCUT_COMMAND_IDS.messageToggleCollapse);
    assert.equal(helpItem?.acceleratorLabel, "Ctrl+Shift+X");

    assert.throws(
      () => updateShortcutBinding(
        settings,
        SHORTCUT_COMMAND_IDS.messageToggleCollapse,
        "windows",
        { key: "Enter", ctrlKey: true },
      ),
      /Invalid keyboard shortcut accelerator/,
    );
    assert.throws(
      () => updateShortcutBinding(
        settings,
        SHORTCUT_COMMAND_IDS.messageFind,
        "windows",
        { key: "g", ctrlKey: true },
      ),
      ShortcutRegistryError,
    );
  });

  it("登録入力は修飾キー単独、IME、repeat、AltGraphを拒否する", () => {
    const baseEvent = {
      key: "M",
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
      isComposing: false,
      repeat: false,
      getModifierState: () => false,
    };
    assert.deepEqual(captureShortcutAccelerator(baseEvent), {
      kind: "accepted",
      accelerator: { key: "m", ctrlKey: true, shiftKey: true },
    });
    assert.equal(captureShortcutAccelerator({ ...baseEvent, key: "Shift" }).kind, "rejected");
    assert.equal(captureShortcutAccelerator({ ...baseEvent, isComposing: true }).kind, "rejected");
    assert.equal(captureShortcutAccelerator({ ...baseEvent, repeat: true }).kind, "rejected");
    assert.equal(captureShortcutAccelerator({ ...baseEvent, altKey: true }).kind, "rejected");
    assert.equal(captureShortcutAccelerator({
      ...baseEvent,
      key: "Dead",
      ctrlKey: false,
      shiftKey: false,
    }).kind, "rejected");
    assert.equal(captureShortcutAccelerator({
      ...baseEvent,
      key: "Process",
      ctrlKey: false,
      shiftKey: false,
    }).kind, "rejected");
    assert.equal(captureShortcutAccelerator({
      ...baseEvent,
      key: "",
      ctrlKey: false,
      shiftKey: false,
    }).kind, "rejected");
  });
});

describe("shortcut dispatcher", () => {
  it("active scope、editing target、repeat、IME、dead key、AltGraph、defaultPreventedを判定する", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const restore = installDomGlobals(dom);
    try {
      const entry = createEntry({ id: "command", scope: "scope" });
      const dispatcher = new ShortcutDispatcher({
        eventTarget: dom.window,
        platform: "windows",
        entries: [entry],
      });
      let calls = 0;
      dispatcher.registerHandler(entry.id, () => {
        calls += 1;
        return true;
      });

      const body = dom.window.document.body;
      const textarea = dom.window.document.createElement("textarea");
      body.append(textarea);

      const inactiveEvent = createKeyboardEvent(dom, { key: "k", ctrlKey: true });
      body.dispatchEvent(inactiveEvent);
      assert.equal(calls, 0);
      assert.equal(inactiveEvent.defaultPrevented, false);

      const releaseScope = dispatcher.registerScope("scope");
      const handledEvent = createKeyboardEvent(dom, { key: "K", ctrlKey: true });
      body.dispatchEvent(handledEvent);
      assert.equal(calls, 1);
      assert.equal(handledEvent.defaultPrevented, true);

      const alreadyPreventedEvent = createKeyboardEvent(dom, { key: "k", ctrlKey: true });
      alreadyPreventedEvent.preventDefault();
      body.dispatchEvent(alreadyPreventedEvent);
      assert.equal(calls, 1);

      for (const init of [
        { key: "k", ctrlKey: true, repeat: true },
        { key: "k", ctrlKey: true, isComposing: true },
        { key: "Dead", ctrlKey: true },
        { key: "k", ctrlKey: true, altKey: true },
      ]) {
        const event = createKeyboardEvent(dom, init);
        body.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false);
      }
      assert.equal(calls, 1);

      const editingEvent = createKeyboardEvent(dom, { key: "k", ctrlKey: true });
      textarea.dispatchEvent(editingEvent);
      assert.equal(calls, 1);
      assert.equal(editingEvent.defaultPrevented, false);

      releaseScope();
      dispatcher.dispose();
    } finally {
      restore();
      dom.window.close();
    }
  });

  it("editingTargetScopeでcomposer以外の入力への送信を拒否する", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const restore = installDomGlobals(dom);
    try {
      const entry = createEntry({
        id: "composer-submit",
        scope: "composer",
        accelerators: {
          windows: { key: "Enter", ctrlKey: true },
          linux: { key: "Enter", ctrlKey: true },
          macos: { key: "Enter", metaKey: true },
        },
        allowInEditingTarget: true,
        editingTargetScope: "composer",
      });
      const dispatcher = new ShortcutDispatcher({
        eventTarget: dom.window,
        platform: "windows",
        entries: [entry],
      });
      let calls = 0;
      dispatcher.registerHandler(entry.id, () => {
        calls += 1;
        return true;
      });
      const releaseScope = dispatcher.registerScope("composer");

      const outsideInput = dom.window.document.createElement("input");
      const composer = dom.window.document.createElement("textarea");
      composer.dataset.shortcutScope = "composer";
      dom.window.document.body.append(outsideInput, composer);

      const outsideEvent = createKeyboardEvent(dom, { key: "Enter", ctrlKey: true });
      outsideInput.dispatchEvent(outsideEvent);
      assert.equal(calls, 0);
      assert.equal(outsideEvent.defaultPrevented, false);

      const composerEvent = createKeyboardEvent(dom, { key: "Enter", ctrlKey: true });
      composer.dispatchEvent(composerEvent);
      assert.equal(calls, 1);
      assert.equal(composerEvent.defaultPrevented, true);

      releaseScope();
      dispatcher.dispose();
    } finally {
      restore();
      dom.window.close();
    }
  });

  it("Send messageの有効なoverrideをdispatcherへ反映する", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const restore = installDomGlobals(dom);
    try {
      const entry = getShortcutEntry(SHORTCUT_COMMAND_IDS.composerSubmit);
      const settings = updateShortcutBinding(
        DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
        entry.id,
        "windows",
        { key: "Enter", altKey: true },
      );
      const dispatcher = new ShortcutDispatcher({
        eventTarget: dom.window,
        platform: "windows",
        settings,
      });
      let calls = 0;
      dispatcher.registerHandler(entry.id, () => {
        calls += 1;
        return true;
      });
      const releaseScope = dispatcher.registerScope(entry.scope);
      const composer = dom.window.document.createElement("textarea");
      composer.dataset.shortcutScope = "composer";
      dom.window.document.body.append(composer);

      const defaultEvent = createKeyboardEvent(dom, { key: "Enter", ctrlKey: true });
      composer.dispatchEvent(defaultEvent);
      assert.equal(calls, 0);
      assert.equal(defaultEvent.defaultPrevented, false);

      const overrideEvent = createKeyboardEvent(dom, { key: "Enter", altKey: true });
      composer.dispatchEvent(overrideEvent);
      assert.equal(calls, 1);
      assert.equal(overrideEvent.defaultPrevented, true);

      releaseScope();
      dispatcher.dispose();
    } finally {
      restore();
      dom.window.close();
    }
  });

  it("message collapse shortcut はcomposerへfocus中もmessage-list scopeで発火する", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const restore = installDomGlobals(dom);
    try {
      const entry = getShortcutEntry(SHORTCUT_COMMAND_IDS.messageToggleCollapse);
      const dispatcher = new ShortcutDispatcher({
        eventTarget: dom.window,
        platform: "windows",
        entries: [entry],
      });
      let calls = 0;
      dispatcher.registerHandler(entry.id, () => {
        calls += 1;
        return true;
      });
      const releaseScope = dispatcher.registerScope("message-list");
      const textarea = dom.window.document.createElement("textarea");
      dom.window.document.body.append(textarea);
      textarea.focus();

      const event = createKeyboardEvent(dom, { key: "M", ctrlKey: true, shiftKey: true });
      textarea.dispatchEvent(event);
      assert.equal(calls, 1);
      assert.equal(event.defaultPrevented, true);

      releaseScope();
      dispatcher.dispose();
    } finally {
      restore();
      dom.window.close();
    }
  });

  it("dispatcherは保存済みoverrideを使い、既定キーでは発火しない", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const restore = installDomGlobals(dom);
    try {
      const entry = getShortcutEntry(SHORTCUT_COMMAND_IDS.messageToggleCollapse);
      const settings = updateShortcutBinding(
        DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
        entry.id,
        "windows",
        { key: "x", ctrlKey: true, shiftKey: true },
      );
      const dispatcher = new ShortcutDispatcher({
        eventTarget: dom.window,
        platform: "windows",
        settings,
      });
      let calls = 0;
      dispatcher.registerHandler(entry.id, () => {
        calls += 1;
        return true;
      });
      const releaseScope = dispatcher.registerScope(entry.scope);

      const defaultEvent = createKeyboardEvent(dom, { key: "m", ctrlKey: true, shiftKey: true });
      dom.window.document.body.dispatchEvent(defaultEvent);
      assert.equal(calls, 0);
      assert.equal(defaultEvent.defaultPrevented, false);

      const overrideEvent = createKeyboardEvent(dom, { key: "x", ctrlKey: true, shiftKey: true });
      dom.window.document.body.dispatchEvent(overrideEvent);
      assert.equal(calls, 1);
      assert.equal(overrideEvent.defaultPrevented, true);

      releaseScope();
      dispatcher.dispose();
    } finally {
      restore();
      dom.window.close();
    }
  });

  it("collisionする保存値でdispatcher初期化を失敗させず、既定値へfallbackする", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const restore = installDomGlobals(dom);
    try {
      const first = createEntry({
        id: "first",
        customizable: true,
        bindingKind: "letter",
        accelerators: {
          windows: { key: "a", ctrlKey: true, shiftKey: true },
          linux: { key: "a", ctrlKey: true, shiftKey: true },
          macos: { key: "a", metaKey: true, shiftKey: true },
        },
      });
      const second = createEntry({
        id: "second",
        customizable: true,
        bindingKind: "letter",
        accelerators: {
          windows: { key: "b", ctrlKey: true, shiftKey: true },
          linux: { key: "b", ctrlKey: true, shiftKey: true },
          macos: { key: "b", metaKey: true, shiftKey: true },
        },
      });

      const dispatcher = new ShortcutDispatcher({
        eventTarget: dom.window,
        platform: "windows",
        entries: [first, second],
        settings: {
          overrides: {
            first: {
              windows: { key: "b", ctrlKey: true, shiftKey: true },
            },
          },
        },
      });
      let calls = 0;
      dispatcher.registerHandler(first.id, () => {
        calls += 1;
        return true;
      });
      const releaseScope = dispatcher.registerScope(first.scope);
      const event = createKeyboardEvent(dom, { key: "a", ctrlKey: true, shiftKey: true });
      dom.window.document.body.dispatchEvent(event);
      assert.equal(calls, 1);
      assert.equal(event.defaultPrevented, true);

      releaseScope();
      dispatcher.dispose();
    } finally {
      restore();
      dom.window.close();
    }
  });

  it("handlerがfalseを返した場合はpreventDefaultしない", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const restore = installDomGlobals(dom);
    try {
      const entry = createEntry({ id: "not-handled" });
      const dispatcher = new ShortcutDispatcher({ eventTarget: dom.window, entries: [entry] });
      dispatcher.registerHandler(entry.id, () => false);
      const releaseScope = dispatcher.registerScope(entry.scope);

      const event = createKeyboardEvent(dom, { key: "k", ctrlKey: true });
      dom.window.document.body.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false);

      releaseScope();
      dispatcher.dispose();
    } finally {
      restore();
      dom.window.close();
    }
  });
});
