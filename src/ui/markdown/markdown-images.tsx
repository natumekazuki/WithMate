import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  ImageViewport,
  ImageZoomControls,
  useImageViewport,
} from "../image-viewport.js";
import { useDialogA11y } from "../a11y.js";
import { MarkdownRenderContext } from "./markdown-context.js";
import {
  isDirectMarkdownImageSource,
  shouldLoadMarkdownImageEagerly,
} from "./markdown-links.js";

const MARKDOWN_IMAGE_LOADING_DELAY_MS = 1_000;
type MarkdownImageProps = {
  source: string;
  alt?: string;
  title?: string;
  resolveImageSource?: (target: string) => Promise<string | null>;
};
function MessageImageLightbox({
  source,
  alt,
  onClose,
}: {
  source: string;
  alt: string;
  onClose: () => void;
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
    <div className="message-image-lightbox" onClick={onClose}>
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
        onKeyDown={handleDialogKeyDown}
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
        />
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
}: MarkdownImageProps) {
  const canLoadDirectly =
    !resolveImageSource && isDirectMarkdownImageSource(source);
  const shouldLoadEagerly = shouldLoadMarkdownImageEagerly(source);
  const [resolvedSource, setResolvedSource] = useState(
    canLoadDirectly ? source : "",
  );
  const [loadStatus, setLoadStatus] = useState<
    "resolving" | "loading" | "ready" | "error"
  >(resolveImageSource ? "resolving" : canLoadDirectly ? "loading" : "error");
  const [isLoadingIndicatorVisible, setIsLoadingIndicatorVisible] =
    useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const loadingIndicatorTimeoutRef = useRef<number | null>(null);
  const clearLoadingIndicatorTimer = useCallback(() => {
    if (loadingIndicatorTimeoutRef.current !== null) {
      window.clearTimeout(loadingIndicatorTimeoutRef.current);
      loadingIndicatorTimeoutRef.current = null;
    }
  }, []);
  useEffect(() => {
    if (!resolveImageSource && !canLoadDirectly) return;
    setIsLoadingIndicatorVisible(false);
    const timeout = window.setTimeout(() => {
      loadingIndicatorTimeoutRef.current = null;
      setIsLoadingIndicatorVisible(true);
    }, MARKDOWN_IMAGE_LOADING_DELAY_MS);
    loadingIndicatorTimeoutRef.current = timeout;
    return () => window.clearTimeout(timeout);
  }, [canLoadDirectly, resolveImageSource, source]);
  useEffect(() => {
    if (!resolveImageSource) return;
    let active = true;
    let ownedObjectUrl: string | null = null;
    setResolvedSource("");
    setLoadStatus("resolving");
    void resolveImageSource(source)
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
      if (ownedObjectUrl) URL.revokeObjectURL(ownedObjectUrl);
    };
  }, [clearLoadingIndicatorTimer, resolveImageSource, source]);
  const isLoading = loadStatus === "resolving" || loadStatus === "loading";
  const showLoadingIndicator = isLoading && isLoadingIndicatorVisible;
  const isResolvingWithoutSource =
    loadStatus === "resolving" && !resolvedSource;
  return (
    <span
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
          onClick={() => setLightboxOpen(true)}
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
        />
      ) : null}
    </span>
  );
});
export function MarkdownImageComponent({
  src,
  alt,
  title,
  node,
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
    />
  ) : null;
}
