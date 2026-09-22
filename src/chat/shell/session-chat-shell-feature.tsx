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

export type SessionChatShellFeature = Omit<
  Parameters<typeof buildLiveSessionWindowShellProps>[0],
  "headerProps" | "messageColumnProps" | "errorNotices" | "recoveryActions"
  | "composerProps" | "compactActionDockProps" | "additionalDirectoryListProps"
  | "skillPickerProps" | "rightPaneProps" | "concurrentChats"
>;

/** Own dock interaction and project layout controllers into the shared shell. */
export function useSessionChatShellFeature(input: {
  ownerKey: string | null;
  presentation: ReturnType<typeof useChatLayoutPresentation>;
  sidePanes: ReturnType<typeof useSessionSidePanes>;
  isEditingTitle: boolean;
  forceActionDockExpanded: readonly boolean[];
  focusComposer: () => void;
}) {
  const { isActionDockExpanded, canCollapseActionDock } = buildActionDockRuntimeState({
    isActionDockPinnedExpanded: input.presentation.isActionDockPinnedExpanded,
    forceReasons: input.forceActionDockExpanded,
  });
  const isHeaderExpanded = input.presentation.isHeaderExpanded || input.isEditingTitle;
  const dock = useSessionVerticalDockResize({
    ownerKey: input.ownerKey,
    isHeaderExpanded,
    isActionDockExpanded,
  });
  const handleExpandActionDock = createActionDockExpandHandler({
    setPinnedExpanded: input.presentation.setIsActionDockPinnedExpanded,
    focusComposer: input.focusComposer,
  });
  const handleCollapseActionDock = createActionDockCollapseHandler({
    canCollapse: canCollapseActionDock,
    setPinnedExpanded: input.presentation.setIsActionDockPinnedExpanded,
  });
  const toggleHeader = createHeaderExpandedToggleHandler({
    isEditingTitle: input.isEditingTitle,
    setHeaderExpanded: input.presentation.setIsHeaderExpanded,
  });
  const handleToggleHeaderSplitter = () => dock.handleHeaderSplitterClick(toggleHeader);
  const handleToggleActionDock = () => dock.handleActionDockSplitterClick(
    isActionDockExpanded ? handleCollapseActionDock : handleExpandActionDock,
  );

  const buildSurface = (content: {
    mainContent?: ReactNode;
    leftPane?: ReactNode;
    themeStyle: CSSProperties | undefined;
    modals: ChatWindowProps["modals"];
    isAuxiliaryMode: boolean;
  }): SessionChatShellFeature => ({
    mode: "agent",
    style: { ...content.themeStyle, ...dock.sessionDockLayoutStyle },
    layoutRef: dock.sessionDockLayoutRef,
    headerDockRef: dock.headerDockRef,
    actionDockRef: dock.actionDockRef,
    isHeaderExpanded,
    workbenchRef: input.sidePanes.sessionWorkbenchRef,
    workbenchStyle: input.sidePanes.sessionWorkbenchStyle,
    mainContent: content.mainContent,
    isActionDockExpanded,
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
      onTogglePanel: handleToggleActionDock,
    },
    splitterProps: buildLiveSessionSplitterProps({
      isContextRailResizing: input.sidePanes.isContextRailResizing,
      isContextRailVisible: input.sidePanes.isContextRailVisible,
      onStartContextRailResize: input.sidePanes.handleStartContextRailResize,
      onKeyDownContextRailResize: input.sidePanes.handleKeyDownContextRailResize,
      onToggleContextRailVisibility: input.sidePanes.handleToggleContextRailVisibility,
    }),
    leftPane: content.leftPane,
    leftSplitterProps: {
      isActive: input.sidePanes.isFilesPaneResizing,
      isPanelExpanded: input.sidePanes.isFilesPaneVisible,
      onPointerDown: input.sidePanes.handleStartFilesPaneResize,
      onKeyDown: input.sidePanes.handleKeyDownFilesPaneResize,
      onTogglePanel: input.sidePanes.handleToggleFilesPaneVisibility,
      ariaLabel: input.sidePanes.isFilesPaneVisible ? "File Explorer を折りたたむ" : "File Explorer を開く",
      title: "クリックでFile Explorerを開閉し、展開中はドラッグまたは矢印キーでサイズを調整",
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
    handleToggleHeaderSplitter,
    handleToggleActionDock,
    buildSurface,
  };
}
