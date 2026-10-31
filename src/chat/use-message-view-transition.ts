import { useCallback, useLayoutEffect, useRef, useState, type RefObject, type SetStateAction } from "react";
import type { MessageViewMode } from "../ui/markdown/MessageRichText.js";

// Only representation changes wait for motion; live state and request controls do not.
export function useMessageViewTransition(
  mainRef: RefObject<HTMLElement | null>,
  auxiliaryRef: RefObject<HTMLElement | null>,
  owner: string,
  visible: boolean,
) {
  const [selectedMode, setSelectedMode] = useState<MessageViewMode>("preview");
  const [renderedMode, setRenderedMode] = useState<MessageViewMode>("preview");
  const selectedRef = useRef(selectedMode);
  const previousOwner = useRef(owner);
  const stopRef = useRef<(() => void) | null>(null);
  const revealRef = useRef(false);
  const opacityRef = useRef(new WeakMap<HTMLElement, string>());
  const reducedMotionRef = useRef<MediaQueryList | null>(null);

  const changeMode = useCallback((mode: SetStateAction<MessageViewMode>) => {
    window.getSelection()?.removeAllRanges();
    const next = typeof mode === "function" ? mode(selectedRef.current) : mode;
    selectedRef.current = next;
    setSelectedMode(next);
  }, []);

  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = media;
    const settle = () => {
      if (!media.matches && document.visibilityState !== "hidden") return;
      stopRef.current?.();
      revealRef.current = false;
      opacityRef.current = new WeakMap();
      setRenderedMode(selectedRef.current);
    };
    media.addEventListener("change", settle);
    document.addEventListener("visibilitychange", settle);
    return () => {
      media.removeEventListener("change", settle);
      document.removeEventListener("visibilitychange", settle);
    };
  }, []);

  useLayoutEffect(() => {
    const ownerChanged = previousOwner.current !== owner;
    previousOwner.current = owner;
    if (ownerChanged || !visible || document.visibilityState === "hidden" || reducedMotionRef.current?.matches) {
      revealRef.current = false;
      opacityRef.current = new WeakMap();
      setRenderedMode(selectedMode);
      return;
    }
    const fadingOut = selectedMode !== renderedMode;
    if (!fadingOut && !revealRef.current) return;
    const bodies = [mainRef.current, auxiliaryRef.current].flatMap((root) => root
      ? Array.from(root.querySelectorAll<HTMLElement>("[data-message-body] .rich-text"))
        .filter((body) => body.getClientRects().length > 0)
      : []);
    if (!bodies.length) {
      revealRef.current = false;
      setRenderedMode(selectedMode);
      return;
    }
    let active = true;
    const animations = bodies.map((body) => body.animate([
      { opacity: opacityRef.current.get(body) ?? (fadingOut ? "1" : "0") },
      { opacity: fadingOut ? "0" : "1" },
    ], { duration: fadingOut ? 70 : 110, easing: "ease-out", fill: "forwards" }));
    opacityRef.current = new WeakMap();
    const stop = () => {
      if (!active) return;
      active = false;
      bodies.forEach((body) => opacityRef.current.set(body, window.getComputedStyle(body).opacity));
      animations.forEach((animation) => animation.cancel());
    };
    stopRef.current = stop;
    revealRef.current = fadingOut;
    void Promise.all(animations.map((animation) => animation.finished)).then(() => {
      if (!active) return;
      if (fadingOut) {
        setRenderedMode(selectedMode);
      } else {
        stop();
        opacityRef.current = new WeakMap();
      }
    }, () => { /* Cancellation belongs to the latest selection or lifecycle cleanup. */ });
    return () => {
      stop();
      if (stopRef.current === stop) stopRef.current = null;
    };
  }, [selectedMode, renderedMode, owner, visible, mainRef, auxiliaryRef]);

  return { selectedMode, renderedMode, changeMode };
}
