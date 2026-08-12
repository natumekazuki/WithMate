import type { ComponentProps, ReactNode, RefObject } from "react";
import { ChatDockSplitter, type ChatWindowProps } from "./chat-window.js";
import {
  SessionContextPane,
  SessionPaneErrorBoundary,
  type SessionContextPaneProps,
} from "../session-components.js";

type LiveSessionWindowShellPropsInput = {
  mode: ChatWindowProps["mode"];
  style?: ChatWindowProps["style"];
  isHeaderExpanded: boolean;
  layoutRef?: ChatWindowProps["layoutRef"];
  headerDockRef?: ChatWindowProps["headerDockRef"];
  actionDockRef?: ChatWindowProps["actionDockRef"];
  workbenchRef: RefObject<HTMLDivElement | null>;
  workbenchStyle?: ChatWindowProps["workbenchStyle"];
  layoutPriority: ChatWindowProps["layoutPriority"];
  onActivateSidePanePriority: () => void;
  onActivateDockPriority: () => void;
  headerProps: ChatWindowProps["headerProps"];
  messageColumnProps: ChatWindowProps["messageColumnProps"];
  recoveryActions?: ChatWindowProps["recoveryActions"];
  mainContent?: ReactNode;
  isActionDockExpanded: boolean;
  composerProps: ChatWindowProps["composerProps"];
  skillPickerProps: ChatWindowProps["skillPickerProps"];
  compactActionDockProps: ChatWindowProps["compactActionDockProps"];
  headerSplitterProps?: Omit<ComponentProps<typeof ChatDockSplitter>, "edge">;
  actionDockSplitterProps?: Omit<ComponentProps<typeof ChatDockSplitter>, "edge">;
  splitterProps: Omit<ComponentProps<typeof ChatDockSplitter>, "edge">;
  leftPane?: ReactNode;
  leftSplitterProps?: Omit<ComponentProps<typeof ChatDockSplitter>, "edge">;
  isLeftPaneVisible?: boolean;
  isRightPaneVisible: boolean;
  rightPaneProps: SessionContextPaneProps;
  modals: ChatWindowProps["modals"];
  baseClassName?: string;
  isAuxiliaryMode?: boolean;
};

export function buildLiveSessionWindowShellProps(
  input: LiveSessionWindowShellPropsInput,
): ChatWindowProps {
  return {
    mode: input.mode,
    className: `${input.baseClassName ?? ""}${input.isAuxiliaryMode ? " auxiliary-session-mode" : ""}`,
    style: input.style,
    layoutRef: input.layoutRef,
    headerDockRef: input.headerDockRef,
    actionDockRef: input.actionDockRef,
    workbenchRef: input.workbenchRef,
    workbenchStyle: input.workbenchStyle,
    layoutPriority: input.layoutPriority,
    isHeaderExpanded: input.isHeaderExpanded,
    headerProps: input.headerProps,
    messageColumnProps: {
      ...input.messageColumnProps,
      isContentActive: input.mainContent === undefined,
    },
    recoveryActions: input.recoveryActions,
    mainContent: input.mainContent,
    isActionDockExpanded: input.isActionDockExpanded,
    composerProps: input.composerProps,
    skillPickerProps: input.skillPickerProps,
    compactActionDockProps: input.compactActionDockProps,
    headerSplitter: (
      <ChatDockSplitter edge="top" onActivate={input.onActivateDockPriority} {...input.headerSplitterProps} />
    ),
    actionDockSplitter: (
      <ChatDockSplitter edge="bottom" onActivate={input.onActivateDockPriority} {...input.actionDockSplitterProps} />
    ),
    splitter: <ChatDockSplitter edge="right" onActivate={input.onActivateSidePanePriority} {...input.splitterProps} />,
    leftPane: input.leftPane,
    leftSplitter: input.leftSplitterProps ? (
      <ChatDockSplitter edge="left" onActivate={input.onActivateSidePanePriority} {...input.leftSplitterProps} />
    ) : null,
    isLeftPaneVisible: input.isLeftPaneVisible ?? false,
    isRightPaneVisible: input.isRightPaneVisible,
    rightPane: (
      <SessionPaneErrorBoundary>
        <SessionContextPane {...input.rightPaneProps} />
      </SessionPaneErrorBoundary>
    ),
    modals: input.modals,
  };
}
