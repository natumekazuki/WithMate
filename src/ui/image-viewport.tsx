import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";

import { useViewportPan } from "./viewport-pan.js";
import { usePreviewWheelZoomStep } from "../settings/preview-zoom-settings-context.js";

/** ビューポートに収める自動倍率、またはパーセントで指定する固定倍率。 */
export type ImageZoom = "fit" | number;

/** 手動ズームで縮小できる下限（%）。Fitではこれより小さくなる場合がある。 */
export const IMAGE_ZOOM_MIN = 10;
/** 手動ズームで拡大できる上限（%）。 */
export const IMAGE_ZOOM_MAX = 800;
/** ズームボタン一回分の増減幅（パーセントポイント）。 */
export const IMAGE_ZOOM_STEP = 10;

/** 画像・スクロール領域・ウィンドウが重なる範囲の中心を返し、有効な交差がなければ null を返す。 */
export function resolveVisibleImageCopyPoint(
  image: HTMLImageElement,
  scrollport: HTMLElement,
): { x: number; y: number } | null {
  const rect = image.getBoundingClientRect();
  const scrollportRect = scrollport.getBoundingClientRect();
  const left = Math.max(0, rect.left, scrollportRect.left);
  const top = Math.max(0, rect.top, scrollportRect.top);
  const right = Math.min(window.innerWidth, rect.right, scrollportRect.right);
  const bottom = Math.min(
    window.innerHeight,
    rect.bottom,
    scrollportRect.bottom,
  );
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(right) ||
    !Number.isFinite(bottom) ||
    right <= left ||
    bottom <= top
  ) {
    return null;
  }
  return {
    x: Math.floor((left + right) / 2),
    y: Math.floor((top + bottom) / 2),
  };
}

/** 現在倍率から一段分だけ拡縮し、すでに手動設定の下限以下なら縮小しても動かさない。 */
function stepImageZoom(
  zoom: number,
  direction: -1 | 1,
  step = IMAGE_ZOOM_STEP,
): number {
  if (direction < 0)
    return zoom <= IMAGE_ZOOM_MIN
      ? zoom
      : Math.max(IMAGE_ZOOM_MIN, zoom - step);
  return zoom >= IMAGE_ZOOM_MAX
    ? zoom
    : Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, zoom + step));
}

/** ビューポート内の Ctrl+wheel をブラウザー既定のズームから切り離し、設定された刻み幅で拡縮する。 */
export function useCtrlWheelZoom(
  viewportRef: RefObject<HTMLDivElement | null>,
  fitZoom: number,
  setZoom: ImageViewportController["setZoom"],
) {
  const wheelZoomStep = usePreviewWheelZoomStep();
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    /** 自動倍率を起点に固定倍率へ移る。倍率が変わらない入力では現在のモードを維持する。 */
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (wheelZoomStep === null) return;
      setZoom((currentZoom) => {
        const effectiveZoom =
          typeof currentZoom === "number" ? currentZoom : fitZoom;
        const nextZoom =
          effectiveZoom < IMAGE_ZOOM_MIN && event.deltaY < 0
            ? IMAGE_ZOOM_MIN
            : stepImageZoom(
                effectiveZoom,
                event.deltaY < 0 ? 1 : -1,
                wheelZoomStep,
              );
        return nextZoom === effectiveZoom ? currentZoom : nextZoom;
      });
    };
    // React の passive な wheel リスナーでは、ブラウザーの Ctrl+wheel ズームをキャンセルできない。
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [fitZoom, setZoom, viewportRef, wheelZoomStep]);
}

/** 画像全体が収まる倍率を拡大せずに算出し、寸法が正でなければ 100% を返す。 */
export function calculateImageFitZoom(
  viewportWidth: number,
  viewportHeight: number,
  imageWidth: number,
  imageHeight: number,
): number {
  if (
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return 100;
  }
  const scale = Math.min(
    1,
    viewportWidth / imageWidth,
    viewportHeight / imageHeight,
  );
  return Math.max(0.1, Math.floor(scale * 1_000) / 10);
}

/** 画像の切り替えでズームを Fit に戻し、表示領域と画像の実寸から自動倍率を更新する。 */
export function useImageViewport(sourceKey: string) {
  const [zoom, setZoom] = useState<ImageZoom>("fit");
  const [fitZoom, setFitZoom] = useState(100);
  const pan = useViewportPan(sourceKey);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setZoom("fit");
    setFitZoom(100);
  }, [sourceKey]);

  const updateFitZoom = useCallback(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!viewport || !canvas || !image) {
      return;
    }
    const styles = window.getComputedStyle(canvas);
    const horizontalPadding =
      (Number.parseFloat(styles.paddingLeft) || 0) +
      (Number.parseFloat(styles.paddingRight) || 0);
    const verticalPadding =
      (Number.parseFloat(styles.paddingTop) || 0) +
      (Number.parseFloat(styles.paddingBottom) || 0);
    setFitZoom(
      calculateImageFitZoom(
        viewport.clientWidth - horizontalPadding,
        viewport.clientHeight - verticalPadding,
        image.naturalWidth,
        image.naturalHeight,
      ),
    );
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

  return {
    zoom,
    setZoom,
    fitZoom,
    effectiveZoom: typeof zoom === "number" ? zoom : fitZoom,
    ...pan,
    imageRef,
    viewportRef,
    canvasRef,
    updateFitZoom,
  };
}

/** 画像と操作バーが共有するズーム値、パン操作、計測対象の参照。 */
export type ImageViewportController = ReturnType<typeof useImageViewport>;

/** 拡縮ボタンが使うズーム状態と、画像・図に応じた操作ラベルの設定。 */
type ImageZoomControlsProps = {
  controller: Pick<
    ImageViewportController,
    "effectiveZoom" | "setZoom" | "zoom"
  >;
  className?: string;
  fitAriaLabel?: string;
  target?: "image" | "diagram";
};

/** 手動の拡大・縮小、100%へのリセット、Fitへの切り替えを提供する。 */
export function ImageZoomControls({
  controller,
  className,
  fitAriaLabel = "Fit image to viewport",
  target = "image",
}: ImageZoomControlsProps) {
  const { effectiveZoom, setZoom, zoom } = controller;
  return (
    <div
      className={className}
      role="group"
      aria-label={target === "image" ? "Image zoom" : "Diagram zoom"}
    >
      <button
        type="button"
        aria-label={`Zoom ${target} out`}
        title={`Zoom ${target} out`}
        disabled={effectiveZoom <= IMAGE_ZOOM_MIN}
        onClick={() => setZoom(stepImageZoom(effectiveZoom, -1))}
      >
        −
      </button>
      <button
        type="button"
        aria-label={`Reset ${target} zoom to 100%`}
        title={`Reset ${target} zoom to 100%`}
        onClick={() => setZoom(100)}
      >
        {effectiveZoom}%
      </button>
      <button
        type="button"
        aria-label={`Zoom ${target} in`}
        title={`Zoom ${target} in`}
        disabled={effectiveZoom >= IMAGE_ZOOM_MAX}
        onClick={() => setZoom(stepImageZoom(effectiveZoom, 1))}
      >
        ＋
      </button>
      <button
        type="button"
        aria-label={fitAriaLabel}
        title={fitAriaLabel}
        aria-pressed={zoom === "fit"}
        className={zoom === "fit" ? "is-active" : ""}
        onClick={() => setZoom("fit")}
      >
        Fit
      </button>
    </div>
  );
}

/** パンとズームの操作状態に加え、画像の参照先、代替テキスト、任意の右クリック操作を受け取る。 */
type ImageViewportProps = {
  controller: ImageViewportController;
  src: string;
  alt: string;
  viewportClassName?: string;
  canvasClassName?: string;
  imageClassName?: string;
  onImageContextMenu?: (event: ReactMouseEvent<HTMLImageElement>) => void;
};

/** コントローラーの実効倍率で画像を描画し、ドラッグによる移動と Ctrl+wheel の拡縮をつなぐ。 */
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
  useCtrlWheelZoom(viewportRef, controller.fitZoom, controller.setZoom);
  return (
    <div
      ref={viewportRef}
      className={`image-viewport${viewportClassName ? ` ${viewportClassName}` : ""}${isPanning ? " is-panning" : ""}`}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={stopPan}
      onPointerCancel={stopPan}
      onLostPointerCapture={handlePanCaptureLoss}
      title="Ctrl + left-drag to pan"
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
