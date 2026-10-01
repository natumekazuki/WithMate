import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

type PanSession = {
  pointerId: number;
  clientX: number;
  clientY: number;
  scrollLeft: number;
  scrollTop: number;
};

export function useViewportPan(sourceKey: string) {
  const [isPanning, setIsPanning] = useState(false);
  const panSessionRef = useRef<PanSession | null>(null);

  useEffect(() => {
    panSessionRef.current = null;
    setIsPanning(false);
  }, [sourceKey]);

  const startPan = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 || !event.ctrlKey
      || (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth
        && event.currentTarget.scrollHeight <= event.currentTarget.clientHeight)
    ) return;
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

  const movePan = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const session = panSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.clientX;
    const dy = event.clientY - session.clientY;
    event.preventDefault();
    event.currentTarget.scrollLeft = session.scrollLeft - dx;
    event.currentTarget.scrollTop = session.scrollTop - dy;
  }, []);

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

  return { isPanning, startPan, movePan, stopPan, handlePanCaptureLoss };
}
