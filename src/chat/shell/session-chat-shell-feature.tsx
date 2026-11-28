import type { CSSProperties, ReactNode } from "react";

import { buildActionDockRuntimeState } from "../approval/action-dock-state.js";
import { buildLiveSessionSplitterProps } from "../chat-window-adapter.js";
import type { ChatWindowProps } from "../chat-window.js";
import type { buildLiveSessionWindowShellProps } from "../live-session-window-props.js";
import {
  createActionDockCollapseHandler,
  createActionDockExpandHandler,
  createHeaderExpandedToggleHandler,
} from "../session-shell-handlers.js";
import {
  type useChatLayoutPresentation,
  type useSessionSidePanes,
  useSessionVerticalDockResize,
} from "./session-chat-layout-hooks.js";

/** ヘッダーやメッセージ、入力欄の中身を除いたセッション画面の配置・操作契約。 */
export type SessionChatShellFeature = Omit<
  Parameters<typeof buildLiveSessionWindowShellProps>[0],
  | "headerProps"
  | "messageColumnProps"
  | "errorNotices"
  | "recoveryActions"
  | "composerProps"
  | "compactActionDockProps"
  | "additionalDirectoryListProps"
  | "skillPickerProps"
  | "rightPaneProps"
  | "concurrentChats"
>;

/** ドックの操作を管理し、レイアウトの制御を共有シェルに渡す。 */
export function useSessionChatShellFeature(input: {
  ownerKey: string | null;
  presentation: ReturnType<typeof useChatLayoutPresentation>;
  sidePanes: ReturnType<typeof useSessionSidePanes>;
  isEditingTitle: boolean;
  forceActionDockExpanded: readonly boolean[];
  focusComposer: () => void;
  terminalDock?: {
    mode: "prompt" | "terminal";
    /** 入力欄とターミナルのどちらをドックに表示するか切り替える。 */
    onChange(mode: "prompt" | "terminal"): void;
    /** 表示中のターミナルにキーボードフォーカスを移す。 */
    focus(): void;
  };
}) {
  const { isActionDockExpanded, canCollapseActionDock } =
    buildActionDockRuntimeState({
      isActionDockPinnedExpanded: input.presentation.isActionDockPinnedExpanded,
      forceReasons:
        input.terminalDock?.mode === "terminal"
          ? []
          : input.forceActionDockExpanded,
    });
  const isHeaderExpanded =
    input.presentation.isHeaderExpanded || input.isEditingTitle;
  const dock = useSessionVerticalDockResize({
    ownerKey: input.ownerKey,
    isHeaderExpanded,
    isActionDockExpanded,
    sidePaneLayoutKey: `${input.sidePanes.activeSidePane}:${JSON.stringify(input.sidePanes.sessionWorkbenchStyle)}`,
  });
  const expandPrompt = createActionDockExpandHandler({
    setPinnedExpanded: input.presentation.setIsActionDockPinnedExpanded,
    focusComposer: input.focusComposer,
  });
  /** 入力欄へ切り替えてドックを展開し、指定された場合は入力を開始できるようにする。 */
  const handleExpandActionDock = (options?: { focusComposer?: boolean }) => {
    input.terminalDock?.onChange("prompt");
    expandPrompt(options);
  };
  /** ドックを開いた状態で表示を切り替え、ターミナルなら次のフレームでフォーカスする。 */
  const handleChangeActionDockMode = (mode: "prompt" | "terminal") => {
    input.terminalDock?.onChange(mode);
    input.presentation.setIsActionDockPinnedExpanded(true);
    if (mode === "terminal")
      requestAnimationFrame(() => input.terminalDock?.focus());
  };
  const handleCollapseActionDock = createActionDockCollapseHandler({
    canCollapse: canCollapseActionDock,
    setPinnedExpanded: input.presentation.setIsActionDockPinnedExpanded,
  });
  const toggleHeader = createHeaderExpandedToggleHandler({
    isEditingTitle: input.isEditingTitle,
    setHeaderExpanded: input.presentation.setIsHeaderExpanded,
  });
  /** ヘッダーの区切りを押したとき、編集中かどうかを考慮して開閉する。 */
  const handleToggleHeaderSplitter = () =>
    dock.handleHeaderSplitterClick(toggleHeader);
  /** ドックを閉じるか、前回の表示モードを保って開き直す。 */
  const handleToggleActionDock = () =>
    dock.handleActionDockSplitterClick(
      isActionDockExpanded
        ? handleCollapseActionDock
        : () => {
            if (input.terminalDock?.mode === "terminal")
              handleChangeActionDockMode("terminal");
            else handleExpandActionDock();
          },
    );

  /** 実際に表示する内容に、各ペインの参照・寸法・区切り操作を結び付ける。 */
  const buildSurface = (content: {
    mainContent?: ReactNode;
    leftPane?: ReactNode;
    themeStyle: CSSProperties | undefined;
    modals: ChatWindowProps["modals"];
    isAuxiliaryMode: boolean;
    terminalContent?: ReactNode;
  }): SessionChatShellFeature => ({
    mode: "agent",
    style: { ...content.themeStyle, ...dock.sessionDockLayoutStyle },
    layoutRef: dock.sessionDockLayoutRef,
    headerDockRef: dock.headerDockRef,
    actionDockRef: dock.actionDockRef,
    isHeaderExpanded,
    isSidePaneBudgetCollapsed: dock.isSidePaneBudgetCollapsed,
    workbenchRef: input.sidePanes.sessionWorkbenchRef,
    workbenchStyle: input.sidePanes.sessionWorkbenchStyle,
    mainContent: content.mainContent,
    isActionDockExpanded,
    terminalContent: content.terminalContent,
    actionDockModeControl: input.terminalDock
      ? { mode: input.terminalDock.mode, onChange: handleChangeActionDockMode }
      : undefined,
    headerSplitterProps: {
      isPanelExpanded: isHeaderExpanded,
      canCollapse: !input.isEditingTitle,
      onTogglePanel: handleToggleHeaderSplitter,
    },
    actionDockSplitterProps: {
      isActive: dock.isActionDockResizing,
      isPanelExpanded: isActionDockExpanded,
      canCollapse: canCollapseActionDock,
      onPointerDown: dock.handleStartActionDockResize,
      onKeyDown: dock.handleActionDockKeyDown,
      onTogglePanel: handleToggleActionDock,
    },
    splitterProps: buildLiveSessionSplitterProps({
      isContextRailResizing: input.sidePanes.isContextRailResizing,
      isContextRailVisible: input.sidePanes.isContextRailVisible,
      onStartContextRailResize: input.sidePanes.handleStartContextRailResize,
      onKeyDownContextRailResize:
        input.sidePanes.handleKeyDownContextRailResize,
      onToggleContextRailVisibility:
        input.sidePanes.handleToggleContextRailVisibility,
    }),
    leftPane: content.leftPane,
    leftSplitterProps: {
      isActive: input.sidePanes.isFilesPaneResizing,
      isPanelExpanded: input.sidePanes.isFilesPaneVisible,
      onPointerDown: input.sidePanes.handleStartFilesPaneResize,
      onKeyDown: input.sidePanes.handleKeyDownFilesPaneResize,
      onTogglePanel: input.sidePanes.handleToggleFilesPaneVisibility,
      ariaLabel: input.sidePanes.isFilesPaneVisible
        ? "Collapse File explorer"
        : "Open File explorer",
      title:
        "Click to toggle File explorer. Drag or use arrow keys to resize when expanded.",
    },
    isLeftPaneVisible: input.sidePanes.isFilesPaneVisible,
    isRightPaneVisible: input.sidePanes.isContextRailVisible,
    modals: content.modals,
    isAuxiliaryMode: content.isAuxiliaryMode,
  });

  return {
    isActionDockExpanded,
    canCollapseActionDock,
    handleExpandActionDock,
    handleCollapseActionDock,
    handleChangeActionDockMode,
    handleToggleHeaderSplitter,
    handleToggleActionDock,
    buildSurface,
  };
}
