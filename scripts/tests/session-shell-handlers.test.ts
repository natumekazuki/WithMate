import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolvePathReferenceRemovalTargets } from "../../src/session-composer-paths.js";
import {
  applyAdditionalDirectoryListToggle,
  applyAgentPickerToggleCommand,
  applyCancelTitleEditCommand,
  applyComposerSubmitKeyCommand,
  applyContextPaneTabCycleCommand,
  applyActionDockCollapseCommand,
  applyActionDockExpandCommand,
  applyAgentPickerCloseCommand,
  applyExpandedArtifactToggleCommand,
  applyExclusiveComposerPickerToggle,
  applyHeaderExpandedToggleCommand,
  applyPathReferenceRemovalCommand,
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
  applyWorkspacePathMatchSelectionCommand,
  createActionDockCollapseHandler,
  createActionDockExpandHandler,
  createAdditionalDirectoryListToggleHandler,
  createComposerSubmitKeyHandler,
  createContextPaneTabCycleHandler,
  createExpandedArtifactToggleHandler,
  createHeaderExpandedToggleHandler,
  createSessionFilesOpenHandler,
  createTitleInputKeyHandler,
  resolveHeaderExpandedToggle,
  runSessionFilesOpenCommand,
  toggleExpandedArtifactState,
} from "../../src/chat/session-shell-handlers.js";

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

describe("applyComposerSubmitKeyCommand", () => {
  it("Ctrl/Cmd+Enter で送信し、それ以外や disabled では何もしない", () => {
    const events: string[] = [];
    const runCommand = (input: {
      key: string;
      ctrlKey?: boolean;
      metaKey?: boolean;
      isSubmitDisabled?: boolean;
    }) => applyComposerSubmitKeyCommand({
      key: input.key,
      ctrlKey: input.ctrlKey ?? false,
      metaKey: input.metaKey ?? false,
      isSubmitDisabled: input.isSubmitDisabled,
      preventDefault: () => events.push(`prevent:${input.key}`),
      submit: () => events.push("submit"),
    });

    assert.equal(runCommand({ key: "Tab", ctrlKey: true }), false);
    assert.equal(runCommand({ key: "Enter" }), false);
    assert.equal(runCommand({ key: "Enter", ctrlKey: true, isSubmitDisabled: true }), false);
    assert.deepEqual(events, []);

    assert.equal(runCommand({ key: "Enter", ctrlKey: true }), true);
    assert.equal(runCommand({ key: "Enter", metaKey: true }), true);
    assert.deepEqual(events, ["prevent:Enter", "submit", "prevent:Enter", "submit"]);
  });

  it("送信 shortcut が blocked の場合は feedback だけ呼ぶ", () => {
    const events: string[] = [];

    assert.equal(
      applyComposerSubmitKeyCommand({
        key: "Enter",
        ctrlKey: true,
        metaKey: false,
        isSubmitBlocked: true,
        preventDefault: () => events.push("prevent"),
        notifySubmitBlocked: () => events.push("blocked"),
        submit: () => events.push("submit"),
      }),
      false,
    );

    assert.deepEqual(events, ["prevent", "blocked"]);
  });

  it("shortcut ではない場合は disabled / blocked 判定を遅延評価しない", () => {
    const events: string[] = [];

    assert.equal(
      applyComposerSubmitKeyCommand({
        key: "a",
        ctrlKey: false,
        metaKey: false,
        isSubmitDisabled: () => {
          events.push("disabled");
          return false;
        },
        isSubmitBlocked: () => {
          events.push("blocked");
          return false;
        },
        preventDefault: () => events.push("prevent"),
        submit: () => events.push("submit"),
      }),
      false,
    );

    assert.deepEqual(events, []);
  });
});

describe("createComposerSubmitKeyHandler", () => {
  it("keydown event から送信 shortcut command を実行する", () => {
    const events: string[] = [];
    const handleKeyDown = createComposerSubmitKeyHandler({
      isSubmitDisabled: () => {
        events.push("disabled");
        return false;
      },
      submit: () => events.push("submit"),
    });

    assert.equal(
      handleKeyDown({
        key: "Tab",
        ctrlKey: true,
        metaKey: false,
        preventDefault: () => events.push("prevent:Tab"),
      }),
      false,
    );
    assert.equal(events.length, 0);

    assert.equal(
      handleKeyDown({
        key: "Enter",
        ctrlKey: true,
        metaKey: false,
        preventDefault: () => events.push("prevent:Enter"),
      }),
      true,
    );
    assert.deepEqual(events, ["disabled", "prevent:Enter", "submit"]);
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
  it("skill prompt 挿入後の UI state と draft 反映後に focus と caret を復元する", () => {
    const events: string[] = [];
    const textarea = {
      focus: () => events.push("focus"),
      setSelectionRange: (start: number, end: number) => events.push(`selection:${start}:${end}`),
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
  it("利用可能な context pane tab の中で active tab を循環する", () => {
    let activeTab: "latest-command" | "reasoning" | "tasks" | "companion-group" = "latest-command";

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: ["latest-command", "tasks"],
      setActiveTab: (updater) => {
        activeTab = updater(activeTab);
      },
    });
    assert.equal(activeTab, "tasks");

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: ["latest-command", "tasks"],
      setActiveTab: (updater) => {
        activeTab = updater(activeTab);
      },
    });
    assert.equal(activeTab, "latest-command");

    applyContextPaneTabCycleCommand({
      direction: -1,
      availableTabs: ["latest-command", "tasks"],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });
    assert.equal(activeTab, "tasks");
  });

  it("active tab が利用可能タブにない場合は先頭から循環する", () => {
    let activeTab: "latest-command" | "reasoning" | "tasks" | "companion-group" = "reasoning";

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: ["latest-command", "tasks"],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });

    assert.equal(activeTab, "tasks");
  });

  it("利用可能タブが空の場合は latest-command を維持する", () => {
    let activeTab: "latest-command" | "reasoning" | "tasks" | "companion-group" = "reasoning";

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: [],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });

    assert.equal(activeTab, "latest-command");
  });
});

describe("createContextPaneTabCycleHandler", () => {
  it("context pane tab cycle handler を作る", () => {
    let activeTab: "latest-command" | "reasoning" | "tasks" | "companion-group" = "tasks";
    const cycleTab = createContextPaneTabCycleHandler({
      availableTabs: ["latest-command", "tasks"],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });

    cycleTab(-1);

    assert.equal(activeTab, "latest-command");
  });
});

describe("applyUnavailableContextPaneTabFallbackCommand", () => {
  it("active tab が利用可能なら維持し、利用不可なら利用可能な tab へ退避する", () => {
    const activeTabs: string[] = [];

    applyUnavailableContextPaneTabFallbackCommand({
      activeTab: "tasks",
      availableTabs: ["latest-command", "tasks"],
      setActiveTab: (tab) => {
        activeTabs.push(tab);
      },
    });
    assert.deepEqual(activeTabs, []);

    applyUnavailableContextPaneTabFallbackCommand({
      activeTab: "reasoning",
      availableTabs: ["latest-command", "tasks"],
      setActiveTab: (tab) => {
        activeTabs.push(tab);
      },
    });
    assert.deepEqual(activeTabs, ["latest-command"]);

    applyUnavailableContextPaneTabFallbackCommand({
      activeTab: "reasoning",
      availableTabs: [],
      setActiveTab: (tab) => {
        activeTabs.push(tab);
      },
    });
    assert.deepEqual(activeTabs, ["latest-command", "latest-command"]);
  });
});

describe("applyPickedComposerReferencePathCommand", () => {
  it("選択 path がない場合は何もせず、ある場合は base directory 更新後に挿入する", () => {
    const events: string[] = [];
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
  it("quote 挿入できない場合は何もせず、できる場合は反映後に focus と caret を復元する", () => {
    const events: string[] = [];
    const textarea = {
      selectionStart: "hello".length,
      focus: () => events.push("focus"),
      setSelectionRange: (start: number, end: number) => events.push(`selection:${start}:${end}`),
    } as HTMLTextAreaElement;

    assert.equal(
      applyQuoteMessageTextCommand({
        messageText: "   ",
        draft: "hello world",
        fallbackCaret: "hello world".length,
        textarea,
        applyInsertion: ({ draft, caret }) => events.push(`apply:${caret}:${draft}`),
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
        applyInsertion: ({ draft, caret }) => events.push(`apply:${caret}:${draft}`),
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

describe("applyWorkspacePathMatchSelectionCommand", () => {
  it("textarea や active path reference がない場合は何もせず、選択できる場合は state 反映後に focus と caret を復元する", () => {
    const events: string[] = [];
    const textarea = {
      selectionStart: "open @src".length,
      focus: () => events.push("focus"),
      setSelectionRange: (start: number, end: number) => events.push(`selection:${start}:${end}`),
    } as HTMLTextAreaElement;
    const runCommand = (input: {
      draft: string;
      caret: number;
      match: string;
      textarea: HTMLTextAreaElement | null;
    }) =>
      applyWorkspacePathMatchSelectionCommand({
        ...input,
        applySelection: (state) => {
          events.push(`apply:${state.caret}:${state.draft}`);
          events.push(`matches:${state.workspacePathMatches.length}:${state.activeWorkspacePathMatchIndex}`);
        },
        restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
          textarea?.focus();
          textarea?.setSelectionRange(caret, caret);
        },
      });

    assert.equal(
      runCommand({
        draft: "open @src",
        caret: "open @src".length,
        match: "src/App.tsx",
        textarea: null,
      }),
      false,
    );
    assert.equal(
      runCommand({
        draft: "open src",
        caret: "open src".length,
        match: "src/App.tsx",
        textarea,
      }),
      false,
    );
    assert.deepEqual(events, []);

    assert.equal(
      runCommand({
        draft: "open @src",
        caret: "open @src".length,
        match: "src/App.tsx",
        textarea,
      }),
      true,
    );
    assert.deepEqual(events, [
      "apply:17:open @src/App.tsx",
      "matches:0:-1",
      "focus",
      "selection:17:17",
    ]);
  });
});

describe("applyPathReferenceRemovalCommand", () => {
  it("path reference 削除後の draft と closed workspace match state を反映する", () => {
    const events: string[] = [];

    applyPathReferenceRemovalCommand({
      draft: "確認 @src/App.tsx して",
      attachmentPathCandidates: ["src/App.tsx"],
      applyRemoval: (state) => {
        events.push(`apply:${state.caret}:${state.draft}`);
        events.push(`matches:${state.workspacePathMatches.length}:${state.activeWorkspacePathMatchIndex}`);
      },
    });

    assert.deepEqual(events, [
      "apply:5:確認 して",
      "matches:0:-1",
    ]);
  });

  it("正規化済みの削除対象で Windows separator の path reference も削除する", () => {
    const events: string[] = [];
    const removalTargets = resolvePathReferenceRemovalTargets(["src\\App.tsx"]);

    applyPathReferenceRemovalCommand({
      draft: "確認 @src/App.tsx して",
      attachmentPathCandidates: removalTargets,
      applyRemoval: (state) => {
        events.push(`apply:${state.caret}:${state.draft}`);
      },
    });

    assert.deepEqual(events, ["apply:5:確認 して"]);
  });
});

describe("applySelectedPathReferenceInsertionCommand", () => {
  it("選択 path がない場合は何もせず、ある場合は挿入 state 反映後に focus と caret を復元する", () => {
    const events: string[] = [];
    const textarea = {
      selectionStart: "see ".length,
      focus: () => events.push("focus"),
      setSelectionRange: (start: number, end: number) => events.push(`selection:${start}:${end}`),
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
          events.push(`matches:${state.workspacePathMatches.length}:${state.activeWorkspacePathMatchIndex}`);
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
      "matches:0:-1",
      "focus",
      "selection:17:17",
    ]);
  });

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
  it("session files open handler を作り、API がない場合は何もしない", async () => {
    const events: string[] = [];
    let openSessionFiles: ((sessionId: string) => Promise<void>) | null = null;
    const openHandler = createSessionFilesOpenHandler({
      getSessionId: () => "session-1",
      getOpenSessionFiles: () => openSessionFiles,
      alertError: (message) => events.push(`alert:${message}`),
      fallbackErrorMessage: "fallback",
    });

    assert.equal(await openHandler(), false);
    assert.deepEqual(events, []);

    openSessionFiles = async (sessionId) => {
      events.push(`open:${sessionId}`);
    };
    assert.equal(await openHandler(), true);
    assert.deepEqual(events, ["open:session-1"]);

    openSessionFiles = async (sessionId) => {
      events.push(`open:${sessionId}`);
      throw "failed";
    };
    assert.equal(await openHandler(), false);
    assert.deepEqual(events, ["open:session-1", "open:session-1", "alert:fallback"]);
  });
});
