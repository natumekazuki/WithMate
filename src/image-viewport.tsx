import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type ImageZoom = "fit" | number;

type ImagePanSession = {
  pointerId: number;
  clientX: number;
  clientY: number;
  scrollLeft: number;
  scrollTop: number;
};

export const IMAGE_ZOOM_MIN = 10;
export const IMAGE_ZOOM_MAX = 800;
export const IMAGE_ZOOM_STEP = 10;

export function calculateImageFitZoom(
  viewportWidth: number,
  viewportHeight: number,
  imageWidth: number,
  imageHeight: number,
): number {
  if (viewportWidth <= 0 || viewportHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return 100;
  }
  const scale = Math.min(1, viewportWidth / imageWidth, viewportHeight / imageHeight);
  return Math.max(0.1, Math.round(scale * 1_000) / 10);
}

export function useImageViewport(sourceKey: string) {
  const [zoom, setZoom] = useState<ImageZoom>("fit");
  const [fitZoom, setFitZoom] = useState(100);
  const [isPanning, setIsPanning] = useState(false);
  const panSessionRef = useRef<ImagePanSession | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setZoom("fit");
    setFitZoom(100);
    setIsPanning(false);
    panSessionRef.current = null;
  }, [sourceKey]);

  const updateFitZoom = useCallback(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!viewport || !canvas || !image) {
      return;
    }
    const styles = window.getComputedStyle(canvas);
    const horizontalPadding = (Number.parseFloat(styles.paddingLeft) || 0)
      + (Number.parseFloat(styles.paddingRight) || 0);
    const verticalPadding = (Number.parseFloat(styles.paddingTop) || 0)
      + (Number.parseFloat(styles.paddingBottom) || 0);
    setFitZoom(calculateImageFitZoom(
      viewport.clientWidth - horizontalPadding,
      viewport.clientHeight - verticalPadding,
      image.naturalWidth,
      image.naturalHeight,
    ));
  }, []);

  useLayoutEffect(() => {
    if (!sourceKey) {
      return;
    }
    updateFitZoom();
    if (typeof ResizeObserver === "undefined" || !viewportRef.current) {
      return;
    }
    const observer = new ResizeObserver(updateFitZoom);
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [sourceKey, updateFitZoom]);

  const startPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0
      || (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth
        && event.currentTarget.scrollHeight <= event.currentTarget.clientHeight)
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panSessionRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
    };
    setIsPanning(true);
  }, []);

  const movePan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = panSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = session.scrollLeft - (event.clientX - session.clientX);
    event.currentTarget.scrollTop = session.scrollTop - (event.clientY - session.clientY);
  }, []);

  const stopPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (panSessionRef.current?.pointerId !== event.pointerId) {
      return;
    }
    panSessionRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handlePanCaptureLoss = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (panSessionRef.current?.pointerId === event.pointerId) {
      panSessionRef.current = null;
      setIsPanning(false);
    }
  }, []);

  return {
    zoom,
    setZoom,
    fitZoom,
    effectiveZoom: typeof zoom === "number" ? zoom : fitZoom,
    isPanning,
    imageRef,
    viewportRef,
    canvasRef,
    updateFitZoom,
    startPan,
    movePan,
    stopPan,
    handlePanCaptureLoss,
  };
}

export type ImageViewportController = ReturnType<typeof useImageViewport>;

type ImageZoomControlsProps = {
  controller: ImageViewportController;
  className?: string;
  fitAriaLabel?: string;
};

export function ImageZoomControls({
  controller,
  className,
  fitAriaLabel = "Fit image to viewport",
}: ImageZoomControlsProps) {
  const { effectiveZoom, setZoom, zoom } = controller;
  return (
    <div className={className} role="group" aria-label="Image zoom">
      <button
        type="button"
        aria-label="Zoom image out"
        disabled={effectiveZoom <= IMAGE_ZOOM_MIN}
        onClick={() => setZoom(Math.max(IMAGE_ZOOM_MIN, effectiveZoom - IMAGE_ZOOM_STEP))}
      >−</button>
      <button type="button" aria-label="Reset image zoom to 100%" onClick={() => setZoom(100)}>
        {effectiveZoom}%
      </button>
      <button
        type="button"
        aria-label="Zoom image in"
        disabled={effectiveZoom >= IMAGE_ZOOM_MAX}
        onClick={() => setZoom(Math.min(IMAGE_ZOOM_MAX, effectiveZoom + IMAGE_ZOOM_STEP))}
      >＋</button>
      <button
        type="button"
        aria-label={fitAriaLabel}
        className={zoom === "fit" ? "is-active" : ""}
        onClick={() => setZoom("fit")}
      >Fit</button>
    </div>
  );
}

type ImageViewportProps = {
  controller: ImageViewportController;
  src: string;
  alt: string;
  viewportClassName?: string;
  canvasClassName?: string;
  imageClassName?: string;
  onImageContextMenu?: (event: ReactMouseEvent<HTMLImageElement>) => void;
};

export function ImageViewport({
  controller,
  src,
  alt,
  viewportClassName = "",
  canvasClassName = "",
  imageClassName = "",
  onImageContextMenu,
}: ImageViewportProps) {
  const {
    canvasRef,
    effectiveZoom,
    handlePanCaptureLoss,
    imageRef,
    isPanning,
    movePan,
    startPan,
    stopPan,
    updateFitZoom,
    viewportRef,
    zoom,
  } = controller;
  return (
    <div
      ref={viewportRef}
      className={`image-viewport${viewportClassName ? ` ${viewportClassName}` : ""}${isPanning ? " is-panning" : ""}`}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={stopPan}
      onPointerCancel={stopPan}
      onLostPointerCapture={handlePanCaptureLoss}
    >
      <div
        ref={canvasRef}
        className={`image-viewport-canvas${canvasClassName ? ` ${canvasClassName}` : ""}${zoom === "fit" ? " is-fit" : ""}`}
      >
        <img
          ref={imageRef}
          className={`image-viewport-image${imageClassName ? ` ${imageClassName}` : ""}${zoom === "fit" ? " is-fit" : ""}`}
          src={src}
          alt={alt}
          draggable={false}
          onContextMenu={onImageContextMenu}
          onLoad={updateFitZoom}
          style={{ zoom: effectiveZoom / 100 }}
        />
      </div>
    </div>
  );
}
