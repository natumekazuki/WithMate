import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import CharacterEditorApp from "../../src/character-editor/CharacterEditorApp.js";
import type { StartCharacterAuthoringSessionInput } from "../../src-shared/character/character-authoring.js";
import { DEFAULT_CHARACTER_THEME, type CharacterDetail } from "../../src-shared/character/character-catalog.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createCharacterDetail(): CharacterDetail {
  return {
    id: "char-1",
    name: "Muse",
    description: "作業を一緒に進める相手",
    iconFilePath: "",
    theme: DEFAULT_CHARACTER_THEME,
    state: "active",
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    archivedAt: null,
    definitionMarkdown: [
      "---",
      "schema: withmate-character-v5",
      "name: \"Muse\"",
      "description: \"作業を一緒に進める相手\"",
      "---",
      "",
      "# Profile",
    ].join("\n"),
    notesMarkdown: "# Profile Notes",
  };
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.trim() === text
  );
  assert.ok(button, `${text} button should exist`);
  return button as HTMLButtonElement;
}

function createModelCatalog(): ModelCatalogSnapshot {
  return {
    revision: 1,
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] }],
      },
      {
        id: "copilot",
        label: "Copilot",
        defaultModelId: "claude-sonnet-4.5",
        defaultReasoningEffort: "medium",
        models: [{ id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", reasoningEfforts: ["medium"] }],
      },
    ],
  };
}

// @test-value v2
// kind = "contract"
// claim = "Character EditorのImprove with Agent操作はauthoring session開始要求をcharacter metadataへ結び付ける"
// oracle = { type = "contract", ref = "CharacterEditorApp authoring session launch contract" }
// fault = "Improve操作がsession開始を呼ばない、対象characterを失う、またはmetadata更新とicon選択を混同する"
// observable = "startCharacterAuthoringSession input、metadata updates、icon picker calls"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp Improve with Agent"
// lifecycle = "permanent"
// @end-test-value
test("CharacterEditorApp は Improve with Agent 押下で authoring session を開始する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://withmate.local/character-editor.html?characterId=char-1",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousTextEncoder = globalThis.TextEncoder;
  const previousTextDecoder = globalThis.TextDecoder;
  const previousWithMate = (globalThis.window as typeof window | undefined)?.withmate;
  const startInputs: StartCharacterAuthoringSessionInput[] = [];
  const metadataUpdates: Array<{ name: string; description: string; iconFilePath: string }> = [];
  const iconPickerCalls: Array<{ initialPath: string | null; purpose: string | undefined }> = [];
  let selectedIconPath: string | null = "C:\\icons\\muse.webp";
  let definitionUpdateCount = 0;

  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "TextEncoder", { value: TextEncoder, configurable: true });
  Object.defineProperty(globalThis, "TextDecoder", { value: TextDecoder, configurable: true });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;
  let currentCharacter = createCharacterDetail();

  dom.window.prompt = () => {
    throw new Error("Improve with Agent should not depend on window.prompt");
  };
  dom.window.withmate = {
    async getModelCatalog() {
      return createModelCatalog();
    },
    async getAppSettings() {
      return {
        ...createDefaultAppSettings(),
        codingProviderSettings: {
          codex: {
            enabled: true,
            apiKey: "",
            skillRootPath: "",
            skillRelativePath: "",
            instructionRelativePath: "",
          },
          copilot: {
            enabled: true,
            apiKey: "",
            skillRootPath: "",
            skillRelativePath: "",
            instructionRelativePath: "",
          },
        },
      };
    },
    async getCharacter(characterId: string) {
      assert.equal(characterId, "char-1");
      return currentCharacter;
    },
    async startCharacterAuthoringSession(input) {
      startInputs.push(input);
      const session = buildNewSession({
        taskTitle: "Muse の character.md 改善",
        workspaceLabel: "Muse authoring",
        workspacePath: "C:/tmp/withmate-authoring",
        branch: "main",
        sessionKind: "character-authoring",
        characterId: "char-1",
        character: "Muse",
        characterIconPath: "",
        characterThemeColors: { main: DEFAULT_CHARACTER_THEME.main, sub: DEFAULT_CHARACTER_THEME.sub },
        approvalMode: "on-request",
      });
      return {
        session,
        workspacePath: "C:/tmp/withmate-authoring",
        runId: "run-1",
      };
    },
    async updateCharacterDefinition(input) {
      assert.equal(input.characterId, "char-1");
      definitionUpdateCount += 1;
      currentCharacter = {
        ...currentCharacter,
        definitionMarkdown: input.definitionMarkdown,
        notesMarkdown: input.notesMarkdown ?? "",
      };
      return currentCharacter;
    },
    async updateCharacterMetadata(input) {
      assert.equal(input.characterId, "char-1");
      metadataUpdates.push({
        name: input.name ?? "",
        description: input.description ?? "",
        iconFilePath: input.iconFilePath ?? "",
      });
      currentCharacter = {
        ...currentCharacter,
        name: input.name ?? "",
        description: input.description ?? "",
        iconFilePath: input.iconFilePath ?? "",
        theme: { ...currentCharacter.theme, ...(input.theme ?? {}) },
      };
      return currentCharacter;
    },
    async pickImageFile(initialPath, purpose) {
      iconPickerCalls.push({
        initialPath: initialPath ?? null,
        purpose,
      });
      return selectedIconPath;
    },
  } as Partial<WithMateWindowApi> as WithMateWindowApi;

  try {
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<CharacterEditorApp />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      findButtonByText(rootElement, "ImportImage")
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.deepEqual(iconPickerCalls, [{
      initialPath: null,
      purpose: "character-icon",
    }]);

    await act(async () => {
      findButtonByText(rootElement, "Save")
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(definitionUpdateCount, 0);
    assert.equal(metadataUpdates.length, 0);
    assert.match(
      rootElement.textContent ?? "",
      /Character icon must be a PNG, JPG, or JPEG image file\./,
    );
    selectedIconPath = "C:\\icons\\muse.png";
    await act(async () => {
      findButtonByText(rootElement, "ImportImage")
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const button = findButtonByText(rootElement, "ImproveWithAgent");
    assert.equal(button.disabled, false);

    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(startInputs.length, 0);
    assert.match(rootElement.textContent ?? "", /Save your changes before starting an authoring session\./);

    await act(async () => {
      findButtonByText(rootElement, "Save")
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(definitionUpdateCount, 1);
    assert.equal(metadataUpdates.length, 1);

    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    const codexProviderButton = findButtonByText(rootElement, "Codex");
    assert.equal(codexProviderButton.getAttribute("aria-selected"), "true");
    const copilotProviderButton = findButtonByText(rootElement, "Copilot");
    await act(async () => {
      copilotProviderButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    const startButton = findButtonByText(rootElement, "Start");
    assert.equal(startButton.disabled, false);
    await act(async () => {
      startButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    assert.deepEqual(startInputs, [{
      mode: "improve",
      characterId: "char-1",
      provider: "copilot",
    }]);

    currentCharacter = {
      ...currentCharacter,
      definitionMarkdown: [
        "---",
        "schema: withmate-character-v5",
        "name: \"Muse Prime\"",
        "description: \"agent が更新した説明\"",
        "---",
        "",
        "# Updated By Agent",
      ].join("\n"),
      notesMarkdown: "# Updated Notes",
    };

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      await Promise.resolve();
    });

    const definitionTab = findButtonByText(rootElement, "character.md");
    await act(async () => {
      definitionTab.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    const definitionTextarea = rootElement.querySelector("textarea.character-editor-textarea") as HTMLTextAreaElement | null;
    assert.ok(definitionTextarea);
    assert.match(definitionTextarea.value, /# Updated By Agent/);

    const saveButton = findButtonByText(rootElement, "Save");
    assert.equal(saveButton.disabled, false);
    await act(async () => {
      saveButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    assert.deepEqual(metadataUpdates.at(-1), {
      name: "Muse Prime",
      description: "agent が更新した説明",
      iconFilePath: "C:\\icons\\muse.png",
    });
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    dom.window.close();
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: previousNavigator, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
    Object.defineProperty(globalThis, "TextEncoder", { value: previousTextEncoder, configurable: true });
    Object.defineProperty(globalThis, "TextDecoder", { value: previousTextDecoder, configurable: true });
    if (previousWindow) {
      previousWindow.withmate = previousWithMate;
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "未保存のCharacterではauthoring開始を拒否し、icon validation失敗を保存・開始処理へ進めない"
// oracle = { type = "contract", ref = "docs/design/character-authoring-growth.md#launch-boundary" }
// fault = "invalid iconを保存する、未保存draftでauthoring APIを呼ぶ、またはvalidationとsave gateのfeedbackを失う"
// observable = "icon validation feedback、ImproveWithAgent buttonのdisabled state、startCharacterAuthoringSession input、metadata update count"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp authoring and icon validation gate"
// lifecycle = "permanent"
// impact = "保存前の不正なCharacterをauthoringへ渡さず、次に必要な修正操作をユーザーへ残す"
// distinction = "authoring開始APIの呼び出しだけでなく、icon選択・validation・保存後の開始条件を同一UI経路で確認する"
// @end-test-value
test("CharacterEditorApp は未保存 Character では Author with Agent を開始できない", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://withmate.local/character-editor.html",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousTextEncoder = globalThis.TextEncoder;
  const previousTextDecoder = globalThis.TextDecoder;
  const previousWithMate = (globalThis.window as typeof window | undefined)?.withmate;
  const startInputs: StartCharacterAuthoringSessionInput[] = [];

  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "TextEncoder", { value: TextEncoder, configurable: true });
  Object.defineProperty(globalThis, "TextDecoder", { value: TextDecoder, configurable: true });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;

  dom.window.withmate = {
    async getModelCatalog() {
      return createModelCatalog();
    },
    async getAppSettings() {
      return createDefaultAppSettings();
    },
    async startCharacterAuthoringSession(input) {
      startInputs.push(input);
      throw new Error("authoring should not start for unsaved Character");
    },
  } as Partial<WithMateWindowApi> as WithMateWindowApi;

  try {
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<CharacterEditorApp />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const button = findButtonByText(rootElement, "AuthorWithAgent");
    assert.equal(button.disabled, true);
    assert.equal(startInputs.length, 0);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    dom.window.close();
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: previousNavigator, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
    Object.defineProperty(globalThis, "TextEncoder", { value: previousTextEncoder, configurable: true });
    Object.defineProperty(globalThis, "TextDecoder", { value: previousTextDecoder, configurable: true });
    if (previousWindow) {
      previousWindow.withmate = previousWithMate;
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "新規Character Editorのdirtyなnative closeは破棄確認を表示し、Cancelでは保持し明示的な破棄後だけWindowを閉じる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#character-editor-window" }
// fault = "dirty draftのnative closeを確認なしで閉じる、Cancelで内容を失う、または確認後もcloseを実行しない"
// observable = "beforeunload defaultPrevented、discard dialog copy、Cancel/DiscardAndClose controls、window close call count"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp dirty native close"
// lifecycle = "permanent"
// impact = "ユーザーのCharacter定義・notes・metadataを意図しないcloseから保護する"
// distinction = "beforeunloadの抑止だけでなく、確認のキャンセルと明示破棄後のcloseを連続操作で確認する"
// @end-test-value
test("CharacterEditorApp は新規作成中のnative closeで破棄確認を表示する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://withmate.local/character-editor.html",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousTextEncoder = globalThis.TextEncoder;
  const previousTextDecoder = globalThis.TextDecoder;
  const previousWithMate = (globalThis.window as typeof window | undefined)?.withmate;
  const closeDom = dom.window.close.bind(dom.window);
  let closeCalls = 0;

  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "TextEncoder", { value: TextEncoder, configurable: true });
  Object.defineProperty(globalThis, "TextDecoder", { value: TextDecoder, configurable: true });
  Object.defineProperty(dom.window, "close", {
    configurable: true,
    value: () => {
      closeCalls += 1;
    },
  });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;

  dom.window.withmate = {
    async getModelCatalog() {
      return createModelCatalog();
    },
    async getAppSettings() {
      return createDefaultAppSettings();
    },
  } as Partial<WithMateWindowApi> as WithMateWindowApi;

  try {
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<CharacterEditorApp />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const firstCloseEvent = new dom.window.Event("beforeunload", { cancelable: true });
    await act(async () => {
      dom.window.dispatchEvent(firstCloseEvent);
    });
    assert.equal(firstCloseEvent.defaultPrevented, true);
    assert.match(rootElement.textContent ?? "", /Discard new character\?/);
    assert.doesNotMatch(rootElement.textContent ?? "", /The unsaved content will be lost\./);
    const closeDialog = rootElement.querySelector(".character-editor-close-dialog");
    assert.ok(closeDialog);
    assert.equal(closeDialog.querySelector(".launch-section"), null);
    assert.equal(closeCalls, 0);

    await act(async () => {
      findButtonByText(rootElement, "Cancel")
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.doesNotMatch(rootElement.textContent ?? "", /Discard new character\?/);
    assert.equal(closeCalls, 0);

    const secondCloseEvent = new dom.window.Event("beforeunload", { cancelable: true });
    await act(async () => {
      dom.window.dispatchEvent(secondCloseEvent);
    });
    assert.equal(secondCloseEvent.defaultPrevented, true);

    await act(async () => {
      findButtonByText(rootElement, "DiscardAndClose")
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    assert.equal(closeCalls, 1);

    const confirmedCloseEvent = new dom.window.Event("beforeunload", { cancelable: true });
    assert.equal(dom.window.dispatchEvent(confirmedCloseEvent), true);
    assert.equal(confirmedCloseEvent.defaultPrevented, false);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    closeDom();
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: previousNavigator, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
    Object.defineProperty(globalThis, "TextEncoder", { value: previousTextEncoder, configurable: true });
    Object.defineProperty(globalThis, "TextDecoder", { value: previousTextDecoder, configurable: true });
    if (previousWindow) {
      previousWindow.withmate = previousWithMate;
    }
  }
});
