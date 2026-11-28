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
import { resolveMarkdownImageTarget } from "./image-resource-source.js";

/** ドライブやUNCの判別に使う区切りだけを復号し、他のURLエンコードは残す。 */
function decodeEncodedWindowsPathSeparators(target: string): string {
  return target.replace(/%5c/gi, "\\");
}
/** ドライブ直下のパスと、サーバー・共有名のあるバックスラッシュ形式のUNCを判定する。 */
function isWindowsAbsolutePathTarget(target: string): boolean {
  const normalizedTarget = decodeEncodedWindowsPathSeparators(target);
  return (
    /^[a-zA-Z]:[\\/]/.test(normalizedTarget) ||
    /^\\\\[^\\]+\\[^\\]+/.test(normalizedTarget)
  );
}
/** Windowsの絶対パスはスキーム扱いせず、明示されたURLスキームだけを許可リストと照合する。 */
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
/** 相対参照やページ内アンカーを残し、許可外の明示スキームを拒む。 */
export function isAllowedMarkdownHref(target: string): boolean {
  if (
    !target ||
    target.startsWith("#") ||
    target.startsWith("//") ||
    isWindowsAbsolutePathTarget(target)
  )
    return true;
  return !hasUnsupportedUrlScheme(target);
}
/** リンクの許可リストではなく、画像の直接読込・ローカル解決の分類で表示可否を決める。 */
function isAllowedMarkdownImageSource(target: string): boolean {
  return resolveMarkdownImageTarget(target).kind !== "unsupported";
}
/** セッションのファイル解決を経由せず画像URLを直接使えるかを判定する。 */
export function isDirectMarkdownImageSource(target: string): boolean {
  return resolveMarkdownImageTarget(target).kind === "external";
}
/** file・画像data・Blob URLは優先読込の対象とし、リモート画像とは区別する。 */
export function shouldLoadMarkdownImageEagerly(target: string): boolean {
  return /^(?:file:|data:image\/|blob:)/i.test(target);
}
/** 属性ごとの許可規則を適用し、Windows画像パスだけをfile URLに、`//` 参照をHTTPSへ正規化する。 */
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
/** 認識済みの参照を呼び出し側へ渡すか、既定のIPCを使って開いた結果を通知する。 */
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
/** 有効な主ボタンクリックの参照を復号せずに開き、ページ内アンカーはブラウザーの既定動作に任せる。 */
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
/** ポインター位置またはアンカー位置からメニューを配置するために必要なイベント情報。 */
type MarkdownLinkContextMenuEvent = {
  clientX: number;
  clientY: number;
  currentTarget: {
    /** キーボード起点のメニューを置くアンカーの左端と下端を返す。 */
    getBoundingClientRect(): Pick<DOMRect, "bottom" | "left">;
  };
  /** 専用メニューを開く場合にブラウザー標準のメニューを抑止する。 */
  preventDefault(): void;
};
/** 元のリンク先と表示座標を受け取り、コピー等のメニュー操作結果を返す境界。 */
type ShowMarkdownLinkContextMenu = (
  request: MarkdownLinkContextMenuRequest,
) => Promise<MarkdownLinkContextMenuResult>;
/** ページ内アンカー等を除き、変換しない参照とセッション文脈を専用メニューへ渡す。失敗は結果に変換する。 */
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
/** アンカーの表示属性を維持し、参照を開く操作とメニューの確定結果を描画側の文脈につなぐ。 */
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
