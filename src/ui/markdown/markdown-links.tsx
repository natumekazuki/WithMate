import {
  useContext,
  type ComponentPropsWithoutRef,
  type MouseEvent,
} from "react";
import { defaultUrlTransform, type UrlTransform } from "react-markdown";

import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { toLocalFileUrl } from "../local-file-url.js";
import {
  resolveOpenPathFeedback,
  showOpenPathFeedback,
} from "../../file-explorer/open-path-result.js";
import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../../../src-shared/window/markdown-link-context-menu.js";
import { MarkdownRenderContext } from "./markdown-context.js";

function decodeEncodedWindowsPathSeparators(target: string): string {
  return target.replace(/%5c/gi, "\\");
}
function isWindowsAbsolutePathTarget(target: string): boolean {
  const normalizedTarget = decodeEncodedWindowsPathSeparators(target);
  return (
    /^[a-zA-Z]:[\\/]/.test(normalizedTarget) ||
    /^\\\\[^\\]+\\[^\\]+/.test(normalizedTarget)
  );
}
function hasUnsupportedUrlScheme(target: string): boolean {
  if (isWindowsAbsolutePathTarget(target)) return false;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target);
  if (!schemeMatch) return false;
  const scheme = schemeMatch[1].toLowerCase();
  return (
    scheme !== "http" &&
    scheme !== "https" &&
    scheme !== "file" &&
    scheme !== "mailto" &&
    scheme !== "tel"
  );
}
function isAllowedMarkdownHref(target: string): boolean {
  if (
    !target ||
    target.startsWith("#") ||
    target.startsWith("//") ||
    isWindowsAbsolutePathTarget(target)
  )
    return true;
  return !hasUnsupportedUrlScheme(target);
}
function isAllowedMarkdownImageSource(target: string): boolean {
  if (!target || target.startsWith("//") || isWindowsAbsolutePathTarget(target))
    return true;
  if (/^data:image\//i.test(target) || /^blob:/i.test(target)) return true;
  return !hasUnsupportedUrlScheme(target);
}
export function isDirectMarkdownImageSource(target: string): boolean {
  return Boolean(
    target &&
    (target.startsWith("//") ||
      isWindowsAbsolutePathTarget(target) ||
      /^(?:https?:|file:|data:image\/|blob:)/i.test(target)),
  );
}
export function shouldLoadMarkdownImageEagerly(target: string): boolean {
  return /^(?:file:|data:image\/|blob:)/i.test(target);
}
export const markdownUrlTransform: UrlTransform = (url, key) => {
  if (key === "src") {
    if (!isAllowedMarkdownImageSource(url)) return "";
    if (url.startsWith("//")) return `https:${url}`;
    return isWindowsAbsolutePathTarget(url)
      ? toLocalFileUrl(decodeEncodedWindowsPathSeparators(url))
      : url;
  }
  if (key !== "href") return defaultUrlTransform(url);
  if (!isAllowedMarkdownHref(url)) return "";
  return url.startsWith("//") ? `https:${url}` : url;
};
export function openMarkdownLink(
  target: string,
  onOpenPath?: (target: string) => void,
): void {
  if (onOpenPath) {
    onOpenPath(target);
    return;
  }
  const api = getWithMateApi();
  if (api)
    void resolveOpenPathFeedback(
      () => api.openPath(target),
      "The path could not be opened.",
    ).then(showOpenPathFeedback);
}
export function handleMarkdownLinkClick(
  event: Pick<
    MouseEvent<HTMLAnchorElement>,
    "button" | "defaultPrevented" | "preventDefault"
  >,
  target: string,
  onOpenPath?: (target: string) => void,
): void {
  if (
    !target ||
    target.startsWith("#") ||
    hasUnsupportedUrlScheme(target) ||
    event.defaultPrevented ||
    event.button !== 0
  )
    return;
  event.preventDefault();
  openMarkdownLink(target, onOpenPath);
}
type MarkdownLinkContextMenuEvent = {
  clientX: number;
  clientY: number;
  currentTarget: { getBoundingClientRect(): Pick<DOMRect, "bottom" | "left"> };
  preventDefault(): void;
};
type ShowMarkdownLinkContextMenu = (
  request: MarkdownLinkContextMenuRequest,
) => Promise<MarkdownLinkContextMenuResult>;
export async function handleMarkdownLinkContextMenu(
  event: MarkdownLinkContextMenuEvent,
  target: string,
  showContextMenu?: ShowMarkdownLinkContextMenu,
  fileContext?: MarkdownLinkContextMenuRequest["fileContext"],
): Promise<MarkdownLinkContextMenuResult | null> {
  if (!target || target.startsWith("#") || hasUnsupportedUrlScheme(target))
    return null;
  const showMenu =
    showContextMenu ?? getWithMateApi()?.showMarkdownLinkContextMenu;
  if (!showMenu) return null;
  const anchorRect = event.currentTarget.getBoundingClientRect();
  const keyboardTriggered = event.clientX === 0 && event.clientY === 0;
  const point = keyboardTriggered
    ? {
        x: Math.max(0, Math.round(anchorRect.left)),
        y: Math.max(0, Math.round(anchorRect.bottom)),
      }
    : {
        x: Math.max(0, Math.round(event.clientX)),
        y: Math.max(0, Math.round(event.clientY)),
      };
  event.preventDefault();
  try {
    return await showMenu({
      target,
      point,
      ...(fileContext ? { fileContext } : {}),
    });
  } catch (error) {
    return {
      status: "failed",
      message:
        error instanceof Error
          ? error.message
          : "Could not open the link menu.",
    };
  }
}
export function MarkdownLink({
  children,
  href,
  node,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  const { onOpenPath, linkFileContext, onLinkContextMenuResult } = useContext(
    MarkdownRenderContext,
  );
  const target = href?.trim() ?? "";
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => handleMarkdownLinkClick(event, target, onOpenPath)}
      onContextMenu={(event) => {
        void handleMarkdownLinkContextMenu(
          event,
          target,
          undefined,
          linkFileContext,
        ).then((result) => {
          if (result && result.status !== "dismissed")
            onLinkContextMenuResult?.(result);
        });
      }}
    >
      {children}
    </a>
  );
}
