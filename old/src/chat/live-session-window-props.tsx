import type { ComponentProps, RefObject } from "react";
import { ChatWorkbenchSplitter, type ChatWindowProps } from "./chat-window.js";
import {
  SessionContextPane,
  SessionPaneErrorBoundary,
  type SessionContextPaneProps,
} from "../session-components.js";
import { buildChatPageClassName } from "./chat-window-adapter.js";

type LiveSessionWindowShellPropsInput = {
  mode: ChatWindowProps["mode"];
  style?: ChatWindowProps["style"];
  isHeaderExpanded: boolean;
  workbenchRef: RefObject<HTMLDivElement | null>;
  workbenchStyle?: ChatWindowProps["workbenchStyle"];
  headerProps: ChatWindowProps["headerProps"];
  messageColumnProps: ChatWindowProps["messageColumnProps"];
  isActionDockExpanded: boolean;
  composerProps: ChatWindowProps["composerProps"];
  compactActionDockProps: ChatWindowProps["compactActionDockProps"];
  splitterProps: ComponentProps<typeof ChatWorkbenchSplitter>;
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
    className: `${buildChatPageClassName({
      baseClassName: input.baseClassName,
      isHeaderExpanded: input.isHeaderExpanded,
    })}${input.isAuxiliaryMode ? " auxiliary-session-mode" : ""}`,
    style: input.style,
    workbenchRef: input.workbenchRef,
    workbenchStyle: input.workbenchStyle,
    isHeaderExpanded: input.isHeaderExpanded,
    headerProps: input.headerProps,
    messageColumnProps: input.messageColumnProps,
    isActionDockExpanded: input.isActionDockExpanded,
    composerProps: input.composerProps,
    compactActionDockProps: input.compactActionDockProps,
    splitter: <ChatWorkbenchSplitter {...input.splitterProps} />,
    rightPane: (
      <SessionPaneErrorBoundary>
        <SessionContextPane {...input.rightPaneProps} />
      </SessionPaneErrorBoundary>
    ),
    modals: input.modals,
  };
}
