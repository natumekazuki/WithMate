import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAdditionalDirectoryListToggle,
  applyAgentPickerToggleCommand,
  applyCancelTitleEditCommand,
  applyCentralSurfaceOpenCommand,
  applyComposerSubmitCommand,
  applyComposerReferenceInsertionCommand,
  applyContextPaneTabCycleCommand,
  applyActionDockCollapseCommand,
  applyActionDockExpandCommand,
  applyAgentPickerCloseCommand,
  applyExpandedArtifactToggleCommand,
  applyExclusiveComposerPickerToggle,
  applyHeaderExpandedToggleCommand,
  applyPickedAdditionalDirectoryUiStateCommand,
  applyPickedComposerReferencePathCommand,
  applyPastedSessionAttachmentPathsCommand,
  applyQuoteMessageTextCommand,
  applySelectedPathReferenceInsertionCommand,
  applySkillPromptInsertionCommand,
  applySessionFilesReferencePathsCommand,
  applySkillPromptInsertionUiState,
  applySkillPickerToggleCommand,
  applyStartTitleEditCommand,
  applyTitleInputKeyCommand,
  applyUnavailableContextPaneTabFallbackCommand,
  createActionDockCollapseHandler,
  createActionDockExpandHandler,
  createAdditionalDirectoryListToggleHandler,
  createAgentPickerCloseHandler,
  createAgentPickerToggleHandler,
  createCancelTitleEditHandler,
  createContextPaneTabCycleHandler,
  createExpandedArtifactToggleHandler,
  createHeaderExpandedToggleHandler,
  createQuoteMessageTextHandler,
  createSessionFilesOpenHandler,
  createSkillPickerToggleHandler,
  createSkillPromptInsertionHandler,
  createStartTitleEditHandler,
  createTitleInputKeyHandler,
  resolveHeaderExpandedToggle,
  runSessionFilesOpenCommand,
  toggleExpandedArtifactState,
} from "../../src/chat/session-shell-handlers.js";
import type { ContextPaneTabKey } from "../../src/chat/runtime/session-ui-projection.js";

describe("toggleExpandedArtifactState", () => {
  it("指定 artifact の展開状態を反転する", () => {
    assert.deepEqual(toggleExpandedArtifactState({ a: true }, "a"), { a: false });
    assert.deepEqual(toggleExpandedArtifactState({ a: true }, "b"), { a: true, b: true });
  });
});

describe("applyExpandedArtifactToggleCommand", () => {
  it("指定 artifact の展開状態を setter 経由で反転する", () => {
    let expandedArtifacts: Record<string, boolean> = { a: true };

    applyExpandedArtifactToggleCommand({
      artifactKey: "a",
      setExpandedArtifacts: (updater) => {
        expandedArtifacts = updater(expandedArtifacts);
      },
    });
    assert.deepEqual(expandedArtifacts, { a: false });

    applyExpandedArtifactToggleCommand({
      artifactKey: "b",
      setExpandedArtifacts: (updater) => {
        expandedArtifacts = updater(expandedArtifacts);
      },
    });
    assert.deepEqual(expandedArtifacts, { a: false, b: true });
  });
});

describe("createExpandedArtifactToggleHandler", () => {
  it("artifact toggle handler を作る", () => {
    let expandedArtifacts: Record<string, boolean> = { a: true };
    const toggleArtifact = createExpandedArtifactToggleHandler({
      setExpandedArtifacts: (updater) => {
        expandedArtifacts = updater(expandedArtifacts);
      },
    });

    toggleArtifact("a");
    toggleArtifact("b");

    assert.deepEqual(expandedArtifacts, { a: false, b: true });
  });
});

describe("resolveHeaderExpandedToggle", () => {
  it("title 編集中は状態を維持し、それ以外は反転する", () => {
    assert.equal(resolveHeaderExpandedToggle(false, true), false);
    assert.equal(resolveHeaderExpandedToggle(true, true), true);
    assert.equal(resolveHeaderExpandedToggle(false, false), true);
    assert.equal(resolveHeaderExpandedToggle(true, false), false);
  });
});

describe("applyHeaderExpandedToggleCommand", () => {
  it("title 編集中でなければ header 展開状態を反転し、編集中は維持する", () => {
    let expanded = false;

    applyHeaderExpandedToggleCommand({
      isEditingTitle: false,
      setHeaderExpanded: (updater) => {
        expanded = updater(expanded);
      },
    });
    assert.equal(expanded, true);

    applyHeaderExpandedToggleCommand({
      isEditingTitle: true,
      setHeaderExpanded: (updater) => {
        expanded = updater(expanded);
      },
    });
    assert.equal(expanded, true);
  });
});

describe("createHeaderExpandedToggleHandler", () => {
  it("header 展開 toggle handler を作る", () => {
    let expanded = false;

    const toggleHeader = createHeaderExpandedToggleHandler({
      isEditingTitle: false,
      setHeaderExpanded: (updater) => {
        expanded = updater(expanded);
      },
    });
    toggleHeader();
    assert.equal(expanded, true);

    const editingToggle = createHeaderExpandedToggleHandler({
      isEditingTitle: true,
      setHeaderExpanded: (updater) => {
        expanded = updater(expanded);
      },
    });
    editingToggle();
    assert.equal(expanded, true);
  });
});

describe("applyTitleInputKeyCommand", () => {
  it("Enter では保存、Escape ではキャンセルし、それ以外では何もしない", () => {
    const events: string[] = [];

    const runCommand = (key: string) => applyTitleInputKeyCommand({
      key,
      preventDefault: () => events.push(`prevent:${key}`),
      saveTitle: () => events.push("save"),
      cancelTitleEdit: () => events.push("cancel"),
    });

    runCommand("Enter");
    runCommand("Escape");
    runCommand("Tab");

    assert.deepEqual(events, ["prevent:Enter", "save", "prevent:Escape", "cancel"]);
  });
});

describe("createTitleInputKeyHandler", () => {
  it("title input keydown handler を作る", () => {
    const events: string[] = [];
    const handleKeyDown = createTitleInputKeyHandler({
      saveTitle: () => events.push("save"),
      cancelTitleEdit: () => events.push("cancel"),
    });

    const runHandler = (key: string) => handleKeyDown({
      key,
      preventDefault: () => events.push(`prevent:${key}`),
    });

    runHandler("Enter");
    runHandler("Escape");
    runHandler("ArrowLeft");

    assert.deepEqual(events, ["prevent:Enter", "save", "prevent:Escape", "cancel"]);
  });
});

describe("applyComposerSubmitCommand", () => {
  it("送信可能な場合だけ submit し、disabled では何もしない", () => {
    const events: string[] = [];
    const runCommand = (input: {
      isSubmitDisabled?: boolean;
    }) => applyComposerSubmitCommand({
      isSubmitDisabled: input.isSubmitDisabled,
      submit: () => events.push("submit"),
    });

    assert.equal(runCommand({ isSubmitDisabled: true }), false);
    assert.deepEqual(events, []);

    assert.equal(runCommand({}), true);
    assert.deepEqual(events, ["submit"]);
  });

  it("送信 shortcut が blocked の場合は feedback だけ呼ぶ", () => {
    const events: string[] = [];

    assert.equal(
      applyComposerSubmitCommand({
        isSubmitBlocked: true,
        notifySubmitBlocked: () => events.push("blocked"),
        submit: () => events.push("submit"),
      }),
      true,
    );

    assert.deepEqual(events, ["blocked"]);
  });

  it("disabled と blocked の判定を遅延評価する", () => {
    const events: string[] = [];

    assert.equal(
      applyComposerSubmitCommand({
        isSubmitDisabled: () => {
          events.push("disabled");
          return true;
        },
        isSubmitBlocked: () => {
          events.push("blocked");
          return false;
        },
        submit: () => events.push("submit"),
      }),
      false,
    );

    assert.deepEqual(events, ["disabled"]);
  });
});

describe("applyStartTitleEditCommand", () => {
  it("title draft を現在値に戻し、header を展開して title 編集中にする", () => {
    const events: string[] = [];

    applyStartTitleEditCommand({
      title: "現在のタイトル",
      setTitleDraft: (title) => events.push(`draft:${title}`),
      setHeaderExpanded: (expanded) => events.push(`expanded:${expanded}`),
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });

    assert.deepEqual(events, ["draft:現在のタイトル", "expanded:true", "editing:true"]);
  });
});

describe("createStartTitleEditHandler", () => {
  it("開始可能な場合だけ title 編集 state を反映する", () => {
    const events: string[] = [];
    const startTitleEdit = createStartTitleEditHandler({
      getTitle: () => "現在のタイトル",
      canStart: () => true,
      setTitleDraft: (title) => events.push(`draft:${title}`),
      setHeaderExpanded: (expanded) => events.push(`expanded:${expanded}`),
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });

    assert.equal(startTitleEdit(), true);
    assert.deepEqual(events, ["draft:現在のタイトル", "expanded:true", "editing:true"]);
  });

  it("開始不可または title がない場合は何もしない", () => {
    const events: string[] = [];
    const blockedStart = createStartTitleEditHandler({
      getTitle: () => "現在のタイトル",
      canStart: () => false,
      setTitleDraft: (title) => events.push(`draft:${title}`),
      setHeaderExpanded: (expanded) => events.push(`expanded:${expanded}`),
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });
    const missingTitleStart = createStartTitleEditHandler({
      getTitle: () => null,
      setTitleDraft: (title) => events.push(`draft:${title}`),
      setHeaderExpanded: (expanded) => events.push(`expanded:${expanded}`),
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });

    assert.equal(blockedStart(), false);
    assert.equal(missingTitleStart(), false);
    assert.deepEqual(events, []);
  });
});

describe("applyCancelTitleEditCommand", () => {
  it("title draft を現在値に戻し、title 編集中を解除する", () => {
    const events: string[] = [];

    applyCancelTitleEditCommand({
      title: "現在のタイトル",
      setTitleDraft: (title) => events.push(`draft:${title}`),
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });

    assert.deepEqual(events, ["draft:現在のタイトル", "editing:false"]);
  });
});

describe("createCancelTitleEditHandler", () => {
  it("title 編集キャンセル handler を作り、title がない場合は空文字へ戻す", () => {
    const events: string[] = [];
    const cancelTitleEdit = createCancelTitleEditHandler({
      getTitle: () => null,
      setTitleDraft: (title) => events.push(`draft:${title}`),
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });

    cancelTitleEdit();

    assert.deepEqual(events, ["draft:", "editing:false"]);
  });
});

describe("applyActionDockExpandCommand", () => {
  it("dock を展開し、focusComposer が true の場合だけ composer focus を呼ぶ", () => {
    const events: string[] = [];

    applyActionDockExpandCommand({
      options: { focusComposer: false },
      setPinnedExpanded: (expanded) => {
        events.push(`expanded:${expanded}`);
      },
      focusComposer: () => {
        events.push("focus");
      },
    });
    applyActionDockExpandCommand({
      options: { focusComposer: true },
      setPinnedExpanded: (expanded) => {
        events.push(`expanded:${expanded}`);
      },
      focusComposer: () => {
        events.push("focus");
      },
    });

    assert.deepEqual(events, ["expanded:true", "expanded:true", "focus"]);
  });
});

describe("applyActionDockCollapseCommand", () => {
  it("collapse 可能な場合だけ pinned expanded を false にする", () => {
    const events: boolean[] = [];

    applyActionDockCollapseCommand({
      canCollapse: false,
      setPinnedExpanded: (expanded) => {
        events.push(expanded);
      },
    });
    applyActionDockCollapseCommand({
      canCollapse: true,
      setPinnedExpanded: (expanded) => {
        events.push(expanded);
      },
    });

    assert.deepEqual(events, [false]);
  });
});

describe("createActionDockExpandHandler", () => {
  it("default options を使いつつ、呼び出し時 options で composer focus を上書きできる", () => {
    const events: string[] = [];
    const expand = createActionDockExpandHandler({
      defaultOptions: { focusComposer: false },
      setPinnedExpanded: (expanded) => events.push(`expanded:${expanded}`),
      focusComposer: () => events.push("focus"),
    });

    expand();
    expand({ focusComposer: true });

    assert.deepEqual(events, ["expanded:true", "expanded:true", "focus"]);
  });
});

describe("createActionDockCollapseHandler", () => {
  it("collapse 可能性を固定した collapse handler を作る", () => {
    const events: boolean[] = [];
    const blockedCollapse = createActionDockCollapseHandler({
      canCollapse: false,
      setPinnedExpanded: (expanded) => events.push(expanded),
    });
    const collapse = createActionDockCollapseHandler({
      canCollapse: true,
      setPinnedExpanded: (expanded) => events.push(expanded),
    });

    blockedCollapse();
    collapse();

    assert.deepEqual(events, [false]);
  });
});

describe("applyCentralSurfaceOpenCommand", () => {
  it("Template編集の未保存変更が破棄拒否された場合は中央surfaceを切り替えない", () => {
    let closeCount = 0;

    const opened = applyCentralSurfaceOpenCommand({
      isPromptTemplateWorkspaceOpen: true,
      canClosePromptTemplate: () => false,
      closeCentralSurface: () => {
        closeCount += 1;
      },
    });

    assert.equal(opened, false);
    assert.equal(closeCount, 0);
  });

  it("現在の中央surfaceを閉じてから次のsurfaceへ進める", () => {
    let centralSurface: "file-preview" | "skill" | null = "file-preview";

    const opened = applyCentralSurfaceOpenCommand({
      isPromptTemplateWorkspaceOpen: false,
      canClosePromptTemplate: () => true,
      closeCentralSurface: () => {
        centralSurface = null;
      },
    });
    if (opened) {
      centralSurface = "skill";
    }

    assert.equal(opened, true);
    assert.equal(centralSurface, "skill");
  });
});

describe("applyExclusiveComposerPickerToggle", () => {
  it("agent picker を toggle すると skill picker を閉じる", () => {
    let agentOpen = false;
    let skillOpen = true;

    applyExclusiveComposerPickerToggle({
      target: "agent",
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    assert.equal(agentOpen, true);
    assert.equal(skillOpen, false);
  });

  it("skill picker を toggle すると agent picker を閉じる", () => {
    let agentOpen = true;
    let skillOpen = false;

    applyExclusiveComposerPickerToggle({
      target: "skill",
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    assert.equal(agentOpen, false);
    assert.equal(skillOpen, true);
  });
});

describe("applyAgentPickerToggleCommand", () => {
  it("agent picker を toggle し、skill picker を閉じる", () => {
    let agentOpen = false;
    let skillOpen = true;

    applyAgentPickerToggleCommand({
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    assert.equal(agentOpen, true);
    assert.equal(skillOpen, false);
  });
});

describe("createAgentPickerToggleHandler", () => {
  it("agent picker toggle handler を作り、skill picker を閉じる", () => {
    let agentOpen = false;
    let skillOpen = true;
    const toggleAgentPicker = createAgentPickerToggleHandler({
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    toggleAgentPicker();

    assert.equal(agentOpen, true);
    assert.equal(skillOpen, false);
  });
});

describe("applyAgentPickerCloseCommand", () => {
  it("agent picker を閉じる", () => {
    const values: boolean[] = [];

    applyAgentPickerCloseCommand({
      setAgentPickerOpen: (open) => {
        values.push(open);
      },
    });

    assert.deepEqual(values, [false]);
  });
});

describe("createAgentPickerCloseHandler", () => {
  it("agent picker close handler を作る", () => {
    const values: boolean[] = [];
    const closeAgentPicker = createAgentPickerCloseHandler({
      setAgentPickerOpen: (open) => {
        values.push(open);
      },
    });

    closeAgentPicker();

    assert.deepEqual(values, [false]);
  });
});

describe("applySkillPickerToggleCommand", () => {
  it("skill picker を toggle し、agent picker を閉じる", () => {
    let agentOpen = true;
    let skillOpen = false;

    applySkillPickerToggleCommand({
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    assert.equal(agentOpen, false);
    assert.equal(skillOpen, true);
  });
});

describe("createSkillPickerToggleHandler", () => {
  it("skill picker toggle handler を作り、agent picker を閉じる", () => {
    let agentOpen = true;
    let skillOpen = false;
    const toggleSkillPicker = createSkillPickerToggleHandler({
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    toggleSkillPicker();

    assert.equal(agentOpen, false);
    assert.equal(skillOpen, true);
  });
});

describe("applySkillPromptInsertionUiState", () => {
  it("skill prompt 挿入後の UI state を setter に反映する", () => {
    const events: string[] = [];

    applySkillPromptInsertionUiState({
      state: {
        caret: 12,
        isActionDockPinnedExpanded: true,
        isSkillPickerOpen: false,
      },
      setActionDockPinnedExpanded: (expanded) => events.push(`dock:${expanded}`),
      setCaret: (caret) => events.push(`caret:${caret}`),
      setSkillPickerOpen: (open) => events.push(`skill:${open}`),
    });

    assert.deepEqual(events, ["dock:true", "caret:12", "skill:false"]);
  });
});

describe("applySkillPromptInsertionCommand", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "skill prompt挿入後はdraft/UI stateを反映してfocusとcaret復元を行う"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "draftだけ更新してfocus/caret復元を失う、またはstate反映順を壊す"
  // observable = "handler eventsのdraft/UI state/focus/caret sequence"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.skill-prompt"
  // lifecycle = "permanent"
  // distinction = "handler callbackへ渡る順序と引数をevent logで確認する"
  // @end-test-value
  it("skill prompt 挿入後の UI state と draft 反映後に focus と caret を復元する", () => {
    const events: string[] = [];
    const textarea = {
      focus: () => { events.push("focus"); },
      setSelectionRange: (start: number, end: number) => { events.push(`selection:${start}:${end}`); },
    } as HTMLTextAreaElement;

    applySkillPromptInsertionCommand({
      state: {
        draft: "/review ",
        caret: 8,
        isActionDockPinnedExpanded: true,
        isSkillPickerOpen: false,
      },
      textarea,
      setActionDockPinnedExpanded: (expanded) => events.push(`dock:${expanded}`),
      setCaret: (caret) => events.push(`caret:${caret}`),
      setSkillPickerOpen: (open) => events.push(`skill:${open}`),
      applyDraft: (draft, caret) => events.push(`draft:${caret}:${draft}`),
      restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
        textarea?.focus();
        textarea?.setSelectionRange(caret, caret);
      },
    });

    assert.deepEqual(events, [
      "dock:true",
      "caret:8",
      "skill:false",
      "draft:8:/review ",
      "focus",
      "selection:8:8",
    ]);
  });
});

describe("createSkillPromptInsertionHandler", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "providerがある場合はskill prompt handlerがdraftとUI stateを反映する"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "providerなしでもdraft/stateを更新する、またはproviderありの反映を欠落させる"
  // observable = "providerありのhandler return valueとdraft/UI state events"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.skill-prompt"
  // lifecycle = "permanent"
  // distinction = "provider存在時の反映契約を確認する（providerなしのno-opは別testで扱う）"
  // @end-test-value
  it("skill prompt 挿入 handler を作り、provider がある場合だけ draft と UI state を反映する", () => {
    const events: string[] = [];
    const textarea = {
      focus: () => { events.push("focus"); },
      setSelectionRange: (start: number, end: number) => { events.push(`selection:${start}:${end}`); },
    } as HTMLTextAreaElement;
    const selectSkill = createSkillPromptInsertionHandler({
      getProvider: () => "codex",
      getDraft: () => "",
      getTextarea: () => textarea,
      setActionDockPinnedExpanded: (expanded) => events.push(`dock:${expanded}`),
      setCaret: (caret) => events.push(`caret:${caret}`),
      setSkillPickerOpen: (open) => events.push(`skill:${open}`),
      applyDraft: (draft, caret) => events.push(`draft:${caret}:${draft}`),
      restoreComposerTextareaFocusAndCaret: (targetTextarea, caret) => {
        targetTextarea?.focus();
        targetTextarea?.setSelectionRange(caret, caret);
      },
    });

    selectSkill({ name: "review" });

    assert.deepEqual(events, [
      "dock:true",
      "caret:8",
      "skill:false",
      "draft:8:$review\n",
      "focus",
      "selection:8:8",
    ]);
  });

  it("provider がない場合は何もしない", () => {
    const events: string[] = [];
    const selectSkill = createSkillPromptInsertionHandler({
      getProvider: () => null,
      getDraft: () => "",
      getTextarea: () => null,
      setActionDockPinnedExpanded: (expanded) => events.push(`dock:${expanded}`),
      setCaret: (caret) => events.push(`caret:${caret}`),
      setSkillPickerOpen: (open) => events.push(`skill:${open}`),
      applyDraft: (draft, caret) => events.push(`draft:${caret}:${draft}`),
      restoreComposerTextareaFocusAndCaret: (_textarea, caret) => events.push(`focus:${caret}`),
    });

    selectSkill({ name: "review" });

    assert.deepEqual(events, []);
  });
});

describe("applyAdditionalDirectoryListToggle", () => {
  it("additional directory list の開閉状態を反転する", () => {
    let open = false;

    applyAdditionalDirectoryListToggle({
      setAdditionalDirectoryListOpen: (updater) => {
        open = updater(open);
      },
    });
    assert.equal(open, true);

    applyAdditionalDirectoryListToggle({
      setAdditionalDirectoryListOpen: (updater) => {
        open = updater(open);
      },
    });
    assert.equal(open, false);
  });
});

describe("createAdditionalDirectoryListToggleHandler", () => {
  it("additional directory list toggle handler を作る", () => {
    let open = false;
    const toggleList = createAdditionalDirectoryListToggleHandler({
      setAdditionalDirectoryListOpen: (updater) => {
        open = updater(open);
      },
    });

    toggleList();
    assert.equal(open, true);

    toggleList();
    assert.equal(open, false);
  });
});

describe("applyPickedAdditionalDirectoryUiStateCommand", () => {
  it("選択 directory がある場合だけ base directory と optional UI state を反映する", () => {
    const events: string[] = [];
    const runCommand = (selectedPath: string | null | undefined) =>
      applyPickedAdditionalDirectoryUiStateCommand({
        selectedPath,
        setPickerBaseDirectory: (baseDirectory) => events.push(`base:${baseDirectory}`),
        applyPickedDirectory: (directoryPath) => events.push(`apply:${directoryPath}`),
        setAdditionalDirectoryListOpen: (open) => events.push(`open:${open}`),
      });

    assert.equal(runCommand(null), false);
    assert.equal(runCommand(undefined), false);
    assert.equal(runCommand(""), false);
    assert.deepEqual(events, []);

    assert.equal(runCommand("C:\\workspace\\fixtures"), true);
    assert.deepEqual(events, [
      "base:C:\\workspace\\fixtures",
      "apply:C:\\workspace\\fixtures",
      "open:true",
    ]);
  });
});

describe("applyContextPaneTabCycleCommand", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "context paneのactive tabは利用可能なtabだけを循環する"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "削除済みtabを循環対象にして存在しないpaneを選択する"
  // observable = "tab cycle後のactive tab"
  // observation_boundary = "public-boundary"
  // scope = "context-pane-tab-cycle"
  // lifecycle = "permanent"
  // @end-test-value
  it("利用可能な context pane tab の中で active tab を循環する", () => {
    let activeTab: ContextPaneTabKey = "latest-command";

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });
    assert.equal(activeTab, "tasks");

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });
    assert.equal(activeTab, "latest-command");

    applyContextPaneTabCycleCommand({
      direction: -1,
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });
    assert.equal(activeTab, "tasks");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "利用不可のactive tabは利用可能なcontext pane tabへ退避する"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "利用不可tabを保持してpaneが空になる"
  // observable = "fallback後のactive tab"
  // observation_boundary = "public-boundary"
  // scope = "context-pane-tab-cycle"
  // lifecycle = "permanent"
  // @end-test-value
  it("active tab が利用可能タブにない場合は先頭から循環する", () => {
    let activeTab: ContextPaneTabKey = "reasoning";

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });

    assert.equal(activeTab, "tasks");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "利用可能tabが空でもactive tabはlatest-commandへ戻る"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "空のtab一覧で無効なtabを保持する"
  // observable = "空一覧処理後のactive tab"
  // observation_boundary = "public-boundary"
  // scope = "context-pane-tab-cycle"
  // lifecycle = "permanent"
  // @end-test-value
  it("利用可能タブが空の場合は latest-command を維持する", () => {
    let activeTab: ContextPaneTabKey = "reasoning";

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: [] as ContextPaneTabKey[],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });

    assert.equal(activeTab, "latest-command");
  });
});

describe("createContextPaneTabCycleHandler", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "context pane tab cycle handlerはsetterへ循環結果を渡す"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "handlerがactive tabを更新しない"
  // observable = "handler実行後のactive tab"
  // observation_boundary = "public-boundary"
  // scope = "context-pane-tab-cycle-handler"
  // lifecycle = "permanent"
  // @end-test-value
  it("context pane tab cycle handler を作る", () => {
    let activeTab: ContextPaneTabKey = "tasks";
    const cycleTab = createContextPaneTabCycleHandler({
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });

    cycleTab(-1);

    assert.equal(activeTab, "latest-command");
  });
});

describe("applyUnavailableContextPaneTabFallbackCommand", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "active context pane tabは利用可能なら維持し、利用不可なら利用可能tabへ退避する"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "利用不可tabを保持して存在しないpaneを選択する"
  // observable = "available tab集合ごとのsetActiveTab呼出値"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.context-pane"
  // lifecycle = "permanent"
  // distinction = "handlerのfallback projectionをavailable tabの変化で確認する"
  // @end-test-value
  it("active tab が利用可能なら維持し、利用不可なら利用可能な tab へ退避する", () => {
    let activeTabs: string[] = [];

    applyUnavailableContextPaneTabFallbackCommand({
      activeTab: "tasks",
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      setActiveTab: (tab) => {
        activeTabs = [...activeTabs, tab];
      },
    });
    assert.deepEqual(activeTabs, []);

    applyUnavailableContextPaneTabFallbackCommand({
      activeTab: "reasoning",
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      setActiveTab: (tab) => {
        activeTabs = [...activeTabs, tab];
      },
    });
    assert.deepEqual(activeTabs, ["latest-command"]);

    applyUnavailableContextPaneTabFallbackCommand({
      activeTab: "reasoning",
      availableTabs: [] as ContextPaneTabKey[],
      setActiveTab: (tab) => {
        activeTabs = [...activeTabs, tab];
      },
    });
    assert.deepEqual(activeTabs, ["latest-command", "latest-command"]);
  });
});

describe("applyPickedComposerReferencePathCommand", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "選択pathがある場合だけbase directory更新後にcommandを挿入し、空入力はno-opにする"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "空pathでstateを変更する、またはbase directory更新と挿入の順序を逆にする"
  // observable = "runCommand return valueとbase directory/insert events"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.path-command"
  // lifecycle = "permanent"
  // distinction = "入力境界と副作用順序をevent logで直接確認する"
  // @end-test-value
  it("選択 path がない場合は何もせず、ある場合は base directory 更新後に挿入する", () => {
    let events: string[] = [];
    const runCommand = (
      selectedPath: string | null | undefined,
      kind: "file" | "folder" | "image" = "file",
    ) =>
      applyPickedComposerReferencePathCommand({
        kind,
        selectedPath,
        setPickerBaseDirectory: (baseDirectory) => events.push(`base:${baseDirectory}`),
        insertReferencePath: (path, kind) => events.push(`insert:${kind}:${path}`),
      });

    assert.equal(runCommand(null), false);
    assert.equal(runCommand(undefined), false);
    assert.equal(runCommand(""), false);
    assert.deepEqual(events, []);

    assert.equal(
      runCommand("C:\\workspace\\project\\src\\App.tsx"),
      true,
    );
    assert.deepEqual(events, [
      "base:C:\\workspace\\project\\src",
      "insert:file:C:\\workspace\\project\\src\\App.tsx",
    ]);

    assert.equal(
      runCommand("C:\\workspace\\project\\docs", "folder"),
      true,
    );
    assert.deepEqual(events, [
      "base:C:\\workspace\\project\\src",
      "insert:file:C:\\workspace\\project\\src\\App.tsx",
      "base:C:\\workspace\\project\\docs",
      "insert:folder:C:\\workspace\\project\\docs",
    ]);
  });
});

describe("applyQuoteMessageTextCommand", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "quoteを挿入できる場合だけstate反映後にfocusとcaretを復元する"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "quote不可でも副作用を実行する、または挿入後のfocus/caret復元を失う"
  // observable = "insert resultとeventsのstate/focus/caret sequence"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.quote"
  // lifecycle = "permanent"
  // distinction = "可否分岐とDOM復元callbackの実行順をevent logで確認する"
  // @end-test-value
  it("quote 挿入できない場合は何もせず、できる場合は反映後に focus と caret を復元する", () => {
    let events: string[] = [];
    const textarea = {
      selectionStart: "hello".length,
      focus: () => { events.push("focus"); },
      setSelectionRange: (start: number, end: number) => { events.push(`selection:${start}:${end}`); },
    } as HTMLTextAreaElement;

    assert.equal(
      applyQuoteMessageTextCommand({
        messageText: "   ",
        draft: "hello world",
        fallbackCaret: "hello world".length,
        textarea,
        applyInsertion: ({ draft, caret }) => { events = [...events, `apply:${caret}:${draft}`]; },
        restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
          textarea?.focus();
          textarea?.setSelectionRange(caret, caret);
        },
      }),
      false,
    );
    assert.deepEqual(events, []);

    assert.equal(
      applyQuoteMessageTextCommand({
        messageText: "quoted\ntext",
        draft: "hello world",
        fallbackCaret: "hello world".length,
        textarea,
        applyInsertion: ({ draft, caret }) => { events = [...events, `apply:${caret}:${draft}`]; },
        restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
          textarea?.focus();
          textarea?.setSelectionRange(caret, caret);
        },
      }),
      true,
    );

    assert.deepEqual(events, [
      "apply:25:hello\n\n> quoted\n> text\n\n\n world",
      "focus",
      "selection:25:25",
    ]);
  });
});

describe("createQuoteMessageTextHandler", () => {
  // @test-value v2
  // kind = "security"
  // claim = "blocked時は通知だけでquoteを挿入せず、許可時だけcomposer stateから挿入する"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "blocked操作を通す、または許可時に現在のcomposer stateでなく古い入力を使う"
  // observable = "blocked/allowed return valueとfeedback/apply/focus events"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.quote"
  // lifecycle = "permanent"
  // impact = "禁止中のcomposer mutationを防ぐ"
  // distinction = "blocked guardと許可時のstate sourceを両方確認する"
  // @end-test-value
  it("blocked の場合は通知だけ行い、許可時は composer state を使って quote を挿入する", () => {
    const events: Array<string> = [];
    const textarea = {
      selectionStart: "hello".length,
      focus: () => { events.push("focus"); },
      setSelectionRange: (start: number, end: number) => { events.push(`selection:${start}:${end}`); },
    } as HTMLTextAreaElement;
     let composerState = {
       draft: "hello world",
       fallbackCaret: 0,
       textarea,
     };
     const createHandler = (blocked: boolean) => createQuoteMessageTextHandler({
       isBlocked: () => blocked,
       notifyBlocked: () => events.push("blocked"),
       getComposerState: () => composerState,
      applyInsertion: ({ draft, caret }) => events.push(`apply:${caret}:${draft}`),
      restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
        textarea?.focus();
        textarea?.setSelectionRange(caret, caret);
      },
    });

    assert.equal(createHandler(true)("quoted"), false);
    assert.deepEqual(events, ["blocked"]);

     const allowedHandler = createHandler(false);
     composerState = { ...composerState, draft: "updated composer state" };
     textarea.selectionStart = composerState.draft.length;
     assert.equal(allowedHandler("quoted"), true);
    assert.deepEqual(events, [
      "blocked",
       "apply:34:updated composer state\n\n> quoted\n\n",
      "focus",
       "selection:34:34",
    ]);
  });
});

describe("applySelectedPathReferenceInsertionCommand", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "選択pathがある場合だけinsert stateを反映し、その後focusとcaretを復元する"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "空選択で挿入する、またはstate反映前にfocus/caretを復元する"
  // observable = "runCommand return valueとapply/focus/caret events"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.path-insert"
  // lifecycle = "permanent"
  // distinction = "空配列と有効pathの副作用差をevent logで確認する"
  // @end-test-value
  it("選択 path がない場合は何もせず、ある場合は挿入 state 反映後に focus と caret を復元する", () => {
    const events: string[] = [];
    const textarea = {
      selectionStart: "see ".length,
      focus: () => { events.push("focus"); },
      setSelectionRange: (start: number, end: number) => { events.push(`selection:${start}:${end}`); },
    } as HTMLTextAreaElement;
    const runCommand = (selectedPaths: string[]) =>
      applySelectedPathReferenceInsertionCommand({
        draft: "see here",
        fallbackCaret: "see here".length,
        selectedPaths,
        textarea,
        workspacePath: null,
        applyInsertion: (state) => {
          events.push(`apply:${state.caret}:${state.draft}`);
        },
        restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
          textarea?.focus();
          textarea?.setSelectionRange(caret, caret);
        },
      });

    assert.equal(runCommand([]), false);
    assert.deepEqual(events, []);

    assert.equal(runCommand(["src/App.tsx"]), true);
    assert.deepEqual(events, [
      "apply:17:see @src/App.tsx here",
      "focus",
      "selection:17:17",
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "textareaがないpath reference挿入でもfallback caretでdraftを更新し、focus復元callbackへnullを渡す"
  // oracle = { type = "contract", ref = "src/chat/shell/session-shell-handlers.ts" }
  // fault = "textarea不在時にpath referenceを挿入できない、caretを誤る、またはfocus復元へ存在しないtextareaを渡す"
  // observable = "apply insertionとrestore callbackのevent列"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers path reference insertion without textarea"
  // lifecycle = "permanent"
  // @end-test-value
  it("textarea がない場合は fallback caret で挿入し、focus 復元は no-op にできる", () => {
    const events: string[] = [];

    assert.equal(
      applySelectedPathReferenceInsertionCommand({
        draft: "see here",
        fallbackCaret: "see".length,
      selectedPaths: ["src/App.tsx"],
        textarea: null,
        workspacePath: null,
        applyInsertion: (state) => {
          events.push(`apply:${state.caret}:${state.draft}`);
        },
        restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
          events.push(`restore:${textarea === null ? "none" : "textarea"}:${caret}`);
        },
      }),
      true,
    );

    assert.deepEqual(events, [
      "apply:16:see @src/App.tsx here",
      "restore:none:16",
    ]);
  });
});

describe("applyComposerReferenceInsertionCommand", () => {
  it("paste attachment の表示形式を保って挿入し、caret を復元する", () => {
    const events: string[] = [];
    const textarea = { selectionStart: 0 } as HTMLTextAreaElement;

    assert.equal(
      applyComposerReferenceInsertionCommand({
        draft: "",
        fallbackCaret: 0,
        references: [
          { path: "C:/session-files/image one.png", presentation: "image" },
          { path: "C:/session-files/note.txt", presentation: "path" },
        ],
        textarea,
        applyInsertion: (state) => events.push(`apply:${state.draft}`),
        restoreComposerTextareaFocusAndCaret: (_textarea, caret) => events.push(`caret:${caret}`),
      }),
      true,
    );
    assert.deepEqual(events, [
      "apply:![image one.png](C:/session-files/image%20one.png) @C:/session-files/note.txt",
      "caret:77",
    ]);
  });
});

describe("applySessionFilesReferencePathsCommand", () => {
  it("元の選択 path から base directory を更新し、挿入 path は referencePaths を使う", () => {
    const events: string[] = [];
    const runCommand = (selectedPaths: string[], referencePaths: string[]) =>
      applySessionFilesReferencePathsCommand({
        selectedPaths,
        referencePaths,
        setPickerBaseDirectory: (baseDirectory) => events.push(`base:${baseDirectory}`),
        insertReferencePaths: (paths) => events.push(`insert:${paths.join(",")}`),
      });

    assert.equal(runCommand([], ["session-files/a.txt"]), false);
    assert.equal(runCommand(["C:\\workspace\\a.txt"], []), false);
    assert.deepEqual(events, []);

    assert.equal(
      runCommand(["C:\\workspace\\picked\\a.txt"], ["session-files/a.txt"]),
      true,
    );
    assert.deepEqual(events, [
      "base:C:\\workspace\\picked",
      "insert:session-files/a.txt",
    ]);
  });
});

describe("applyPastedSessionAttachmentPathsCommand", () => {
  it("保存済み paste attachment path がある場合だけ挿入する", () => {
    const events: string[] = [];
    const runCommand = (savedPaths: string[]) =>
      applyPastedSessionAttachmentPathsCommand({
        savedPaths,
        insertReferencePaths: (paths) => events.push(`insert:${paths.join(",")}`),
      });

    assert.equal(runCommand([]), false);
    assert.deepEqual(events, []);

    assert.equal(runCommand(["session-files/a.txt", "session-files/b.png"]), true);
    assert.deepEqual(events, ["insert:session-files/a.txt,session-files/b.png"]);
  });
});

describe("runSessionFilesOpenCommand", () => {
  it("session id がある場合だけ session files action を実行し、失敗時は alert する", async () => {
    const events: string[] = [];
    const runCommand = (input: {
      sessionId: string | null | undefined;
      shouldThrow?: unknown;
    }) =>
      runSessionFilesOpenCommand({
        sessionId: input.sessionId,
        openSessionFiles: async (sessionId) => {
          events.push(`open:${sessionId}`);
          if (input.shouldThrow !== undefined) {
            throw input.shouldThrow;
          }
        },
        alertError: (message) => events.push(`alert:${message}`),
        fallbackErrorMessage: "fallback",
      });

    assert.equal(await runCommand({ sessionId: null }), false);
    assert.equal(await runCommand({ sessionId: undefined }), false);
    assert.deepEqual(events, []);

    assert.equal(await runCommand({ sessionId: "" }), true);
    assert.deepEqual(events, ["open:"]);

    assert.equal(await runCommand({ sessionId: "session-1" }), true);
    assert.deepEqual(events, ["open:", "open:session-1"]);

    assert.equal(
      await runCommand({ sessionId: "session-2", shouldThrow: new Error("failed") }),
      false,
    );
    assert.deepEqual(events, [
      "open:",
      "open:session-1",
      "open:session-2",
      "alert:failed",
    ]);

    assert.equal(
      await runCommand({ sessionId: "session-3", shouldThrow: "failed" }),
      false,
    );
    assert.deepEqual(events, [
      "open:",
      "open:session-1",
      "open:session-2",
      "alert:failed",
      "open:session-3",
      "alert:fallback",
    ]);
  });
});

describe("createSessionFilesOpenHandler", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Files open handlerはAPI未提供時に何も呼ばず、提供時は現在のSessionを開き、非Error失敗をfallback文言で通知する"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts createSessionFilesOpenHandler" }
  // fault = "未提供APIを呼び出す、別Sessionを開く、またはAPIの失敗を成功扱いする"
  // observable = "handlerの成否とopen/alert呼び出し列"
  // observation_boundary = "component-behavior"
  // scope = "createSessionFilesOpenHandler"
  // lifecycle = "permanent"
  // @end-test-value
  it("session files open handler を作り、API がない場合は何もしない", async () => {
    let events: string[] = [];
    let openSessionFiles: ((sessionId: string) => Promise<void>) | null = null;
    const openHandler = createSessionFilesOpenHandler({
      getSessionId: () => "session-1",
      getOpenSessionFiles: () => openSessionFiles,
      alertError: (message) => events.push(`alert:${message}`),
      fallbackErrorMessage: "fallback",
    });

    assert.equal(await openHandler(), false);
    assert.deepEqual(events, []);

    openSessionFiles = async (sessionId: string) => {
      events = [...events, `open:${sessionId}`];
    };
    assert.equal(await openHandler(), true);
    assert.deepEqual(events, ["open:session-1"]);

    openSessionFiles = async (sessionId: string) => {
      events = [...events, `open:${sessionId}`];
      throw "failed";
    };
    assert.equal(await openHandler(), false);
    assert.deepEqual(events, ["open:session-1", "open:session-1", "alert:fallback"]);
  });
});
