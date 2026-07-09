import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import CharacterEditorApp from "../../src/CharacterEditorApp.js";
import type { StartCharacterAuthoringSessionInput } from "../../src/character/character-authoring.js";
import { DEFAULT_CHARACTER_THEME, type CharacterDetail } from "../../src/character/character-catalog.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import { buildNewSession } from "../../src/session-state.js";
import type { WithMateWindowApi } from "../../src/withmate-window-api.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createCharacterDetail(): CharacterDetail {
  return {
    id: "char-1",
    name: "Muse",
    description: "作業を一緒に進める相手",
    iconFilePath: "",
    theme: DEFAULT_CHARACTER_THEME,
    state: "active",
    isDefault: false,
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
  const metadataUpdates: Array<{ name: string; description: string }> = [];

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
      });
      return {
        session,
        workspacePath: "C:/tmp/withmate-authoring",
        runId: "run-1",
      };
    },
    async updateCharacterDefinition(input) {
      assert.equal(input.characterId, "char-1");
      currentCharacter = {
        ...currentCharacter,
        definitionMarkdown: input.definitionMarkdown,
        notesMarkdown: input.notesMarkdown,
      };
      return currentCharacter;
    },
    async updateCharacterMetadata(input) {
      assert.equal(input.characterId, "char-1");
      metadataUpdates.push({
        name: input.name,
        description: input.description,
      });
      currentCharacter = {
        ...currentCharacter,
        name: input.name,
        description: input.description,
        iconFilePath: input.iconFilePath ?? "",
        theme: input.theme,
      };
      return currentCharacter;
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
    const button = findButtonByText(rootElement, "Improve with Agent");
    assert.equal(button.disabled, false);

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

    assert.equal(startInputs.length, 1);
    assert.equal(startInputs[0]?.mode, "improve");
    assert.equal(startInputs[0]?.characterId, "char-1");
    assert.equal(startInputs[0]?.name, "Muse");
    assert.equal(startInputs[0]?.userInstruction, "");
    assert.equal(startInputs[0]?.provider, "copilot");
    assert.equal(startInputs[0]?.model, undefined);
    assert.equal(startInputs[0]?.reasoningEffort, undefined);

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

    const button = findButtonByText(rootElement, "Author with Agent");
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
