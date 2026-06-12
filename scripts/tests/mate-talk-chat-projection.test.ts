import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import type { KeyboardEvent } from "react";

import {
  buildMateTalkChatWindowProps,
  buildMateTalkComposerCapabilityProps,
} from "../../src/chat/mate-talk-chat-projection.js";

test("buildMateTalkComposerCapabilityProps は runtime controls を表示し picker は隠す", () => {
  const onCollapse = () => {};
  const props = buildMateTalkComposerCapabilityProps({
    onCollapseActionDock: onCollapse,
  });

  assert.equal(props.showAttachmentControls, true);
  assert.equal(props.showAdditionalDirectoryControls, true);
  assert.equal(props.showExecutionModeControls, true);
  assert.equal(props.showCustomAgentPicker, false);
  assert.equal(props.showSkillPicker, false);
  assert.equal(props.canCollapseActionDock, true);
  assert.equal(props.onCollapse, onCollapse);
});

test("buildMateTalkComposerCapabilityProps は picker override を MateTalk 固有値で上書きする", () => {
  const props = buildMateTalkComposerCapabilityProps({
    composerCapabilityProps: {
      showCustomAgentPicker: true,
      showSkillPicker: true,
    },
    onCollapseActionDock: () => {},
  });

  assert.equal(props.showCustomAgentPicker, false);
  assert.equal(props.showSkillPicker, false);
});

test("buildMateTalkChatWindowProps は composition handlers を composer props へ渡す", () => {
  const onCompositionStart = () => {};
  const onCompositionEnd = () => {};
  const props = buildMateTalkChatWindowProps({
    mateName: "ユニバーサル",
    isHeaderExpanded: false,
    isActionDockExpanded: true,
    messages: [],
    input: "こんにちは",
    modelOptions: [],
    selectedModel: "",
    selectedModelFallbackLabel: "",
    reasoningOptions: [],
    selectedReasoningEffort: "low",
    messageListRef: React.createRef<HTMLDivElement>(),
    composerTextareaRef: React.createRef<HTMLTextAreaElement>(),
    onChangeInput() {},
    onChangeModel() {},
    onChangeReasoningEffort() {},
    onSubmit() {},
    onToggleHeaderExpanded() {},
    onOpenSessionFilesExplorer() {},
    onOpenSessionFilesTerminal() {},
    onCollapseActionDock() {},
    onExpandActionDock() {},
    isRunning: false,
    feedback: "",
    composerCapabilityProps: {
      onDraftCompositionStart: onCompositionStart,
      onDraftCompositionEnd: onCompositionEnd,
    },
  });

  assert.equal(props.composerProps.onDraftCompositionStart, onCompositionStart);
  assert.equal(props.composerProps.onDraftCompositionEnd, onCompositionEnd);
});

test("buildMateTalkChatWindowProps は native composition 中の submit shortcut を抑止する", () => {
  let submitted = false;
  let prevented = false;
  const props = buildMateTalkChatWindowProps({
    mateName: "ユニバーサル",
    isHeaderExpanded: false,
    isActionDockExpanded: true,
    messages: [],
    input: "こんにちは",
    modelOptions: [],
    selectedModel: "",
    selectedModelFallbackLabel: "",
    reasoningOptions: [],
    selectedReasoningEffort: "low",
    messageListRef: React.createRef<HTMLDivElement>(),
    composerTextareaRef: React.createRef<HTMLTextAreaElement>(),
    onChangeInput() {},
    onChangeModel() {},
    onChangeReasoningEffort() {},
    onSubmit() {
      submitted = true;
    },
    onToggleHeaderExpanded() {},
    onOpenSessionFilesExplorer() {},
    onOpenSessionFilesTerminal() {},
    onCollapseActionDock() {},
    onExpandActionDock() {},
    isRunning: false,
    feedback: "",
  });
  const event = {
    key: "Enter",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    nativeEvent: { isComposing: true },
    preventDefault() {
      prevented = true;
    },
  } as KeyboardEvent<HTMLTextAreaElement>;

  props.composerProps.onDraftKeyDown(event);

  assert.equal(submitted, false);
  assert.equal(prevented, false);
});

test("buildMateTalkChatWindowProps は MateTalk composition ref 中の submit shortcut を抑止する", () => {
  let submitted = false;
  let prevented = false;
  const props = buildMateTalkChatWindowProps({
    mateName: "ユニバーサル",
    isHeaderExpanded: false,
    isActionDockExpanded: true,
    messages: [],
    input: "こんにちは",
    modelOptions: [],
    selectedModel: "",
    selectedModelFallbackLabel: "",
    reasoningOptions: [],
    selectedReasoningEffort: "low",
    messageListRef: React.createRef<HTMLDivElement>(),
    composerTextareaRef: React.createRef<HTMLTextAreaElement>(),
    onChangeInput() {},
    onChangeModel() {},
    onChangeReasoningEffort() {},
    onSubmit() {
      submitted = true;
    },
    onToggleHeaderExpanded() {},
    onOpenSessionFilesExplorer() {},
    onOpenSessionFilesTerminal() {},
    onCollapseActionDock() {},
    onExpandActionDock() {},
    isInputImeComposing: () => true,
    isRunning: false,
    feedback: "",
  });
  const event = {
    key: "Enter",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    nativeEvent: { isComposing: false },
    preventDefault() {
      prevented = true;
    },
  } as KeyboardEvent<HTMLTextAreaElement>;

  props.composerProps.onDraftKeyDown(event);

  assert.equal(submitted, false);
  assert.equal(prevented, false);
});

test("MateTalkChatModeApp は composition handlers を projection に渡す", () => {
  const source = readFileSync("src/chat/MateTalkChatModeApp.tsx", "utf8");

  assert.match(source, /isInputImeComposing:\s*state\.isInputImeComposing/);
  assert.match(source, /onDraftCompositionStart:\s*state\.onDraftCompositionStart/);
  assert.match(source, /onDraftCompositionEnd:\s*state\.onDraftCompositionEnd/);
});
