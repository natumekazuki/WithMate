import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  ImageViewport,
  ImageZoomControls,
  resolveVisibleImageCopyPoint,
  useImageViewport,
} from "../image-viewport.js";
import { useDialogA11y } from "../a11y.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { MarkdownRenderContext, type MessageCopyFeedback } from "./markdown-context.js";
import type { MarkdownImageResolver } from "./image-resource-loader.js";
import { resolveMarkdownImageTarget } from "./image-resource-source.js";
import {
  isDirectMarkdownImageSource,
  shouldLoadMarkdownImageEagerly,
} from "./markdown-links.js";
import { pickMarkdownSourceAttributes, type MarkdownSourceAttributes } from "./markdown-source-ranges.js";

const MARKDOWN_IMAGE_LOADING_DELAY_MS = 1_000;
type MarkdownImageProps = {
  source: string;
  alt?: string;
  title?: string;
  resolveImageSource?: MarkdownImageResolver;
  sourceAttributes?: MarkdownSourceAttributes;
};
type ImageContextMenuHandler = (
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  image: HTMLImageElement | null,
  viewport: HTMLElement | null,
) => boolean;

function MessageImageLightbox({
  source,
  alt,
  onClose,
  onContextMenu,
  feedback,
}: {
  source: string;
  alt: string;
  onClose: () => void;
  onContextMenu: ImageContextMenuHandler;
  feedback: ReactNode;
}) {
  const initialFocusRef = useRef<HTMLElement | null>(null);
  const imageViewport = useImageViewport(source);
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open: true,
    onClose,
    initialFocusRef,
  });
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="message-image-lightbox"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <section
        ref={(element) => {
          dialogRef.current = element;
          initialFocusRef.current = element;
        }}
        className="message-image-lightbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={alt ? `Image preview: ${alt}` : "Image preview"}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (!onContextMenu(event, imageViewport.imageRef.current, imageViewport.viewportRef.current)) {
            handleDialogKeyDown(event);
          }
        }}
      >
        <ImageZoomControls
          controller={imageViewport}
          className="message-image-lightbox-controls"
        />
        <ImageViewport
          controller={imageViewport}
          src={source}
          alt={alt}
          viewportClassName="message-image-lightbox-viewport"
          canvasClassName="message-image-lightbox-canvas"
          imageClassName="message-image-lightbox-image"
          onImageContextMenu={(event) => onContextMenu(event, event.currentTarget, imageViewport.viewportRef.current)}
        />
        {feedback}
      </section>
    </div>,
    document.body,
  );
}
export const MarkdownImage = memo(function MarkdownImage({
  source,
  alt,
  title,
  resolveImageSource,
  sourceAttributes,
}: MarkdownImageProps) {
  const { imageContext } = useContext(MarkdownRenderContext);
  const canLoadDirectly =
    !resolveImageSource && isDirectMarkdownImageSource(source);
  const shouldLoadEagerly = shouldLoadMarkdownImageEagerly(source);
  const isLocalResource = !!resolveImageSource && resolveMarkdownImageTarget(source).kind === "local";
  const shellRef = useRef<HTMLSpanElement | null>(null);
  const resource = useMemo(() => ({ source, resolver: resolveImageSource }), [resolveImageSource, source]);
  const [requestedResource, setRequestedResource] = useState<typeof resource | null>(null);
  const shouldResolve = !isLocalResource || requestedResource === resource;
  const [resolvedSource, setResolvedSource] = useState(
    canLoadDirectly ? source : "",
  );
  const [loadStatus, setLoadStatus] = useState<
    "deferred" | "resolving" | "loading" | "ready" | "error"
  >(isLocalResource ? "deferred" : resolveImageSource ? "resolving" : canLoadDirectly ? "loading" : "error");
  const [isLoadingIndicatorVisible, setIsLoadingIndicatorVisible] =
    useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<MessageCopyFeedback | null>(null);
  const copyRevisionRef = useRef(0);
  useEffect(() => {
    setCopyFeedback(null);
    return () => { copyRevisionRef.current += 1; };
  }, [resource]);
  useEffect(() => {
    if (!copyFeedback) return;
    const timeout = window.setTimeout(() => setCopyFeedback(null), 2_400);
    return () => window.clearTimeout(timeout);
  }, [copyFeedback]);
  const loadingIndicatorTimeoutRef = useRef<number | null>(null);
  const clearLoadingIndicatorTimer = useCallback(() => {
    if (loadingIndicatorTimeoutRef.current !== null) {
      window.clearTimeout(loadingIndicatorTimeoutRef.current);
      loadingIndicatorTimeoutRef.current = null;
    }
  }, []);
  useEffect(() => {
    if (!isLocalResource || !resource.resolver || !shellRef.current) return;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (!active || !entries.some((entry) => entry.isIntersecting)) return;
      setRequestedResource(resource);
      observer.disconnect();
    });
    observer.observe(shellRef.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [isLocalResource, resource]);
  useEffect(() => {
    setIsLoadingIndicatorVisible(false);
    if (!shouldResolve || (!resolveImageSource && !canLoadDirectly)) return;
    const timeout = window.setTimeout(() => {
      loadingIndicatorTimeoutRef.current = null;
      setIsLoadingIndicatorVisible(true);
    }, MARKDOWN_IMAGE_LOADING_DELAY_MS);
    loadingIndicatorTimeoutRef.current = timeout;
    return () => window.clearTimeout(timeout);
  }, [canLoadDirectly, resolveImageSource, shouldResolve, source]);
  useEffect(() => {
    if (!resolveImageSource) return;
    setResolvedSource("");
    if (!shouldResolve) {
      setLoadStatus("deferred");
      return;
    }
    const controller = new AbortController();
    let active = true;
    let ownedObjectUrl: string | null = null;
    setLoadStatus("resolving");
    void resolveImageSource(source, controller.signal)
      .then((resolved) => {
        if (!active) {
          if (resolved && resolved !== source && resolved.startsWith("blob:"))
            URL.revokeObjectURL(resolved);
          return;
        }
        if (!resolved) {
          clearLoadingIndicatorTimer();
          setLoadStatus("error");
          return;
        }
        if (resolved !== source && resolved.startsWith("blob:"))
          ownedObjectUrl = resolved;
        setResolvedSource(resolved);
        setLoadStatus("loading");
      })
      .catch(() => {
        if (active) {
          clearLoadingIndicatorTimer();
          setResolvedSource("");
          setLoadStatus("error");
        }
      });
    return () => {
      active = false;
      controller.abort();
      if (ownedObjectUrl) URL.revokeObjectURL(ownedObjectUrl);
    };
  }, [clearLoadingIndicatorTimer, resolveImageSource, shouldResolve, source]);
  const isLoading = loadStatus === "resolving" || loadStatus === "loading";
  const showLoadingIndicator = isLoading && isLoadingIndicatorVisible;
  const isResolvingWithoutSource =
    (loadStatus === "deferred" || loadStatus === "resolving") && !resolvedSource;
  const showContextMenu: ImageContextMenuHandler = (event, image, viewport) => {
    if ("key" in event && event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return false;
    const api = getWithMateApi();
    if (!api || !imageContext || !image || !viewport || loadStatus !== "ready") return false;
    event.preventDefault();
    event.stopPropagation();
    const point = "key" in event || (event.clientX === 0 && event.clientY === 0)
      ? resolveVisibleImageCopyPoint(image, viewport)
      : { x: Math.max(0, Math.round(event.clientX)), y: Math.max(0, Math.round(event.clientY)) };
    if (!point) {
      setCopyFeedback({ message: "The image is not currently visible.", tone: "error" });
      return true;
    }
    const revision = ++copyRevisionRef.current;
    setCopyFeedback(null);
    void api.showSessionFilePreviewImageContextMenu({
      sessionId: imageContext.sessionId,
      point,
      ...(resolveMarkdownImageTarget(source).kind === "local" ? { image: {
        target: source,
        ...(imageContext.baseResource ? { baseResource: imageContext.baseResource } : {}),
      } } : {}),
    }).then((result) => {
      if (revision !== copyRevisionRef.current || result.status === "dismissed") return;
      setCopyFeedback({
        message: result.status === "copied" ? "Image copied."
          : result.status === "copied-path" ? "Path copied." : result.message,
        tone: result.status === "failed" ? "error" : "success",
      });
    }).catch(() => {
      if (revision === copyRevisionRef.current) {
        setCopyFeedback({ message: "Image context menu could not be opened.", tone: "error" });
      }
    });
    return true;
  };
  const feedback = copyFeedback ? (
    <span
      className={`message-copy-toast ${copyFeedback.tone}`}
      role={copyFeedback.tone === "error" ? "alert" : "status"}
      aria-live={copyFeedback.tone === "error" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      {copyFeedback.message}
    </span>
  ) : null;
  return (
    <span
      {...sourceAttributes}
      ref={shellRef}
      className={`message-image-shell${isResolvingWithoutSource ? " is-resolving" : ""}`}
    >
      {showLoadingIndicator ? (
        <span
          className="message-image-loading"
          role="status"
          aria-label="Loading image"
        />
      ) : null}
      {loadStatus === "error" ? (
        <span className="message-image-error" role="alert" title={source}>
          Image could not be loaded.
        </span>
      ) : null}
      {resolvedSource ? (
        <button
          className="message-image-trigger"
          type="button"
          aria-label={alt ? `Open image preview: ${alt}` : "Open image preview"}
          disabled={loadStatus !== "ready"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setLightboxOpen(true);
          }}
          onContextMenu={(event) => showContextMenu(event, event.currentTarget.querySelector("img"), event.currentTarget)}
          onKeyDown={(event) => showContextMenu(event, event.currentTarget.querySelector("img"), event.currentTarget)}
        >
          <img
            className="message-image"
            src={resolvedSource}
            alt={alt ?? ""}
            title={title}
            loading={shouldLoadEagerly ? "eager" : "lazy"}
            fetchPriority={shouldLoadEagerly ? "high" : "auto"}
            onLoad={() => {
              clearLoadingIndicatorTimer();
              setLoadStatus("ready");
            }}
            onError={() => {
              clearLoadingIndicatorTimer();
              setLoadStatus("error");
            }}
          />
        </button>
      ) : null}
      {lightboxOpen && resolvedSource ? (
        <MessageImageLightbox
          source={resolvedSource}
          alt={alt ?? ""}
          onClose={() => setLightboxOpen(false)}
          onContextMenu={showContextMenu}
          feedback={feedback}
        />
      ) : null}
      {!lightboxOpen && feedback ? createPortal(feedback, document.body) : null}
    </span>
  );
});
export function MarkdownImageComponent({
  src,
  alt,
  title,
  node,
  ...props
}: React.ComponentPropsWithoutRef<"img"> & { node?: unknown }) {
  const { resolveImageSource } = useContext(MarkdownRenderContext);
  const source = typeof src === "string" ? src.trim() : "";
  return source ? (
    <MarkdownImage
      key={`${resolveImageSource ? "resolved" : "direct"}:${source}`}
      source={source}
      alt={alt}
      title={title}
      resolveImageSource={resolveImageSource}
      sourceAttributes={pickMarkdownSourceAttributes(props)}
    />
  ) : null;
}
