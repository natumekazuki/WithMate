import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";

type PanSession = {
  pointerId: number;
  clientX: number;
  clientY: number;
  scrollLeft: number;
  scrollTop: number;
  dragged: boolean;
};

export function useViewportPan(sourceKey: string, button: 0 | 2 = 0) {
  const [isPanning, setIsPanning] = useState(false);
  const panSessionRef = useRef<PanSession | null>(null);
  const suppressContextMenuRef = useRef(false);

  useEffect(() => {
    panSessionRef.current = null;
    suppressContextMenuRef.current = false;
    setIsPanning(false);
  }, [sourceKey, button]);

  const startPan = useCallback((event: PointerEvent<HTMLDivElement>) => {
    suppressContextMenuRef.current = false;
    if (
      event.button !== button
      || (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth
        && event.currentTarget.scrollHeight <= event.currentTarget.clientHeight)
    ) return;
    if (button === 0) event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panSessionRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
      dragged: false,
    };
    if (button === 0) setIsPanning(true);
  }, [button]);

  const movePan = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const session = panSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.clientX;
    const dy = event.clientY - session.clientY;
    if (button === 2 && !session.dragged && Math.hypot(dx, dy) < 3) return;
    session.dragged = true;
    event.preventDefault();
    if (button === 2) suppressContextMenuRef.current = true;
    setIsPanning(true);
    event.currentTarget.scrollLeft = session.scrollLeft - dx;
    event.currentTarget.scrollTop = session.scrollTop - dy;
  }, [button]);

  const stopPan = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (panSessionRef.current?.pointerId !== event.pointerId) return;
    panSessionRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handlePanCaptureLoss = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (panSessionRef.current?.pointerId === event.pointerId) {
      panSessionRef.current = null;
      setIsPanning(false);
    }
  }, []);

  const handlePanContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (button !== 2 || event.button !== 2 || !suppressContextMenuRef.current) return;
    suppressContextMenuRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, [button]);

  return { isPanning, startPan, movePan, stopPan, handlePanCaptureLoss, handlePanContextMenu };
}
