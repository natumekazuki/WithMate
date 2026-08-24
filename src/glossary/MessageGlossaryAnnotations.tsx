import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Components } from "react-markdown";
import type { Plugin } from "unified";

import type {
  GlossaryAnnotationMatcher,
  GlossaryAnnotationRange,
} from "./glossary-annotation-projection.js";

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

type GlossaryAnnotationRenderScope = {
  annotations: GlossaryAnnotationRange[];
};

type GlossaryAnnotationController = {
  renderScope: GlossaryAnnotationRenderScope;
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  registerElement: (index: number, element: HTMLSpanElement | null) => void;
  moveFocus: (currentIndex: number, command: "previous" | "next" | "first" | "last") => void;
  activate: (canonicalTerm: string) => void;
};

export type MessageGlossaryAnnotationProjection = {
  controller: GlossaryAnnotationController | null;
  rehypePlugin: Plugin | null;
};

const GlossaryAnnotationContext = createContext<GlossaryAnnotationController | null>(null);
const GLOSSARY_ANNOTATION_PROPERTY = "data-glossary-annotation-index";
const GLOSSARY_ANNOTATION_EXCLUDED_TAGS = new Set(["a", "code", "pre", "script", "style"]);

function hasExcludedGlossaryProjectionClass(node: HastNode): boolean {
  const className = node.properties?.className;
  const classes = Array.isArray(className) ? className : typeof className === "string" ? className.split(/\s+/u) : [];
  return classes.includes("katex")
    || classes.includes("math")
    || classes.includes("math-inline")
    || classes.includes("math-display")
    || classes.includes("message-mermaid");
}

function createGlossaryAnnotationPlugin(
  matcher: GlossaryAnnotationMatcher,
  renderScope: GlossaryAnnotationRenderScope,
): Plugin {
  return () => (tree) => {
    renderScope.annotations.length = 0;
    const budget = matcher.createMessageBudget();

    const visit = (node: HastNode) => {
      if (
        node.type === "element"
        && (GLOSSARY_ANNOTATION_EXCLUDED_TAGS.has(node.tagName ?? "") || hasExcludedGlossaryProjectionClass(node))
      ) {
        return;
      }
      if (!Array.isArray(node.children)) {
        return;
      }

      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index];
        if (child.type !== "text" || typeof child.value !== "string") {
          visit(child);
          continue;
        }

        const matches = matcher.matchText(child.value, budget);
        if (matches.length === 0) {
          continue;
        }
        const replacements: HastNode[] = [];
        let cursor = 0;
        for (const match of matches) {
          if (match.start > cursor) {
            replacements.push({ type: "text", value: child.value.slice(cursor, match.start) });
          }
          const annotationIndex = renderScope.annotations.length;
          renderScope.annotations.push(match);
          replacements.push({
            type: "element",
            tagName: "span",
            properties: { [GLOSSARY_ANNOTATION_PROPERTY]: annotationIndex },
            children: [{ type: "text", value: child.value.slice(match.start, match.end) }],
          });
          cursor = match.end;
        }
        if (cursor < child.value.length) {
          replacements.push({ type: "text", value: child.value.slice(cursor) });
        }
        node.children.splice(index, 1, ...replacements);
        index += replacements.length - 1;
      }
    };

    visit(tree as HastNode);
  };
}

function resolveTooltipPosition(
  anchorRect: DOMRect,
  tooltipRect: Pick<DOMRect, "width" | "height">,
): CSSProperties {
  const viewportPadding = 8;
  const offset = 8;
  const width = Math.min(tooltipRect.width || 360, 360, Math.max(0, window.innerWidth - viewportPadding * 2));
  const height = Math.min(tooltipRect.height || 240, 240, Math.max(0, window.innerHeight - viewportPadding * 2));
  const left = Math.min(
    Math.max(viewportPadding, anchorRect.left),
    Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
  );
  const below = anchorRect.bottom + offset;
  const above = anchorRect.top - height - offset;
  const top = below + height <= window.innerHeight - viewportPadding
    ? below
    : Math.max(viewportPadding, above);
  return { left, top, visibility: "visible" };
}

function shouldIgnoreGlossaryAnnotationKey(event: ReactKeyboardEvent<HTMLSpanElement>): boolean {
  return event.defaultPrevented
    || event.nativeEvent.isComposing
    || event.key === "Dead"
    || event.getModifierState("AltGraph")
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey;
}

function GlossaryAnnotationElement({
  annotationIndex,
  children,
}: {
  annotationIndex: number;
  children: ReactNode;
}) {
  const controller = useContext(GlossaryAnnotationContext);
  const annotation = controller?.renderScope.annotations[annotationIndex];
  const targetRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const tooltipId = useId();
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const annotationCount = controller?.renderScope.annotations.length ?? 0;
  const effectiveActiveIndex = controller && controller.activeIndex < annotationCount ? controller.activeIndex : 0;

  const setTargetElement = useCallback((element: HTMLSpanElement | null) => {
    targetRef.current = element;
    controller?.registerElement(annotationIndex, element);
  }, [annotationIndex, controller]);

  useLayoutEffect(() => {
    if (!tooltipVisible || typeof window === "undefined") {
      return;
    }
    const updatePosition = () => {
      const target = targetRef.current;
      const tooltip = tooltipRef.current;
      if (!target || !tooltip) return;
      setTooltipStyle(resolveTooltipPosition(target.getBoundingClientRect(), tooltip.getBoundingClientRect()));
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [tooltipVisible]);

  if (!controller || !annotation) {
    return <span>{children}</span>;
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (shouldIgnoreGlossaryAnnotationKey(event)) return;
    let handled = true;
    switch (event.key) {
      case "ArrowLeft":
        controller.moveFocus(annotationIndex, "previous");
        break;
      case "ArrowRight":
        controller.moveFocus(annotationIndex, "next");
        break;
      case "Home":
        controller.moveFocus(annotationIndex, "first");
        break;
      case "End":
        controller.moveFocus(annotationIndex, "last");
        break;
      case "Enter":
      case " ":
        controller.activate(annotation.canonicalTerm);
        break;
      case "Escape":
        if (tooltipVisible) {
          setTooltipVisible(false);
        } else {
          handled = false;
        }
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const tooltip = tooltipVisible && typeof document !== "undefined" ? createPortal(
    <span
      ref={tooltipRef}
      id={tooltipId}
      className="glossary-annotation-tooltip"
      role="tooltip"
      style={tooltipStyle}
    >
      <span className="glossary-annotation-tooltip-term">{annotation.canonicalTerm}</span>
      <span className="glossary-annotation-tooltip-definition">{annotation.definition}</span>
    </span>,
    document.body,
  ) : null;

  return (
    <>
      <span
        ref={setTargetElement}
        className="glossary-annotation"
        role="button"
        tabIndex={effectiveActiveIndex === annotationIndex ? 0 : -1}
        aria-describedby={tooltipVisible ? tooltipId : undefined}
        data-glossary-canonical-term={annotation.canonicalTerm}
        onMouseEnter={() => setTooltipVisible(true)}
        onMouseLeave={() => setTooltipVisible(false)}
        onFocus={() => {
          controller.setActiveIndex(annotationIndex);
          setTooltipVisible(true);
        }}
        onBlur={() => setTooltipVisible(false)}
        onClick={() => {
          controller.setActiveIndex(annotationIndex);
          controller.activate(annotation.canonicalTerm);
        }}
        onKeyDown={handleKeyDown}
      >
        {children}
      </span>
      {tooltip}
    </>
  );
}

export const GlossaryAnnotationSpan: NonNullable<Components["span"]> = ({ children, node, ...props }) => {
  const spanProps = props as Record<string, unknown>;
  const annotationIndexValue = spanProps[GLOSSARY_ANNOTATION_PROPERTY];
  if (typeof annotationIndexValue === "number" && Number.isInteger(annotationIndexValue)) {
    return (
      <GlossaryAnnotationElement annotationIndex={annotationIndexValue}>
        {children}
      </GlossaryAnnotationElement>
    );
  }
  return <span {...props}>{children}</span>;
};

export function useMessageGlossaryAnnotations(input: {
  matcher?: GlossaryAnnotationMatcher;
  scopeKey: string;
  text: string;
  onActivate?: (canonicalTerm: string) => void;
}): MessageGlossaryAnnotationProjection {
  const [activeIndex, setActiveIndex] = useState(0);
  const elementsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const renderScope = useMemo<GlossaryAnnotationRenderScope>(
    () => ({ annotations: [] }),
    [input.matcher, input.scopeKey, input.text],
  );
  const rehypePlugin = useMemo(
    () => input.matcher && input.onActivate ? createGlossaryAnnotationPlugin(input.matcher, renderScope) : null,
    [input.matcher, input.onActivate, renderScope],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [input.matcher?.revision, input.scopeKey, input.text]);

  useLayoutEffect(() => {
    const annotationCount = renderScope.annotations.length;
    elementsRef.current.length = annotationCount;
    if (activeIndex >= annotationCount && activeIndex !== 0) {
      setActiveIndex(0);
    }
  });

  const registerElement = useCallback((index: number, element: HTMLSpanElement | null) => {
    elementsRef.current[index] = element;
  }, []);
  const moveFocus = useCallback((
    currentIndex: number,
    command: "previous" | "next" | "first" | "last",
  ) => {
    const annotationCount = renderScope.annotations.length;
    if (annotationCount === 0) return;
    const nextIndex = command === "first"
      ? 0
      : command === "last"
        ? annotationCount - 1
        : command === "previous"
          ? (currentIndex - 1 + annotationCount) % annotationCount
          : (currentIndex + 1) % annotationCount;
    setActiveIndex(nextIndex);
    elementsRef.current[nextIndex]?.focus();
  }, [renderScope]);
  const activate = useCallback((canonicalTerm: string) => {
    input.onActivate?.(canonicalTerm);
  }, [input.onActivate]);
  const controller = useMemo<GlossaryAnnotationController | null>(
    () => rehypePlugin ? {
      renderScope,
      activeIndex,
      setActiveIndex,
      registerElement,
      moveFocus,
      activate,
    } : null,
    [activate, activeIndex, moveFocus, registerElement, rehypePlugin, renderScope],
  );

  return { controller, rehypePlugin };
}

export function MessageGlossaryAnnotationProvider({
  controller,
  children,
}: {
  controller: GlossaryAnnotationController | null;
  children: ReactNode;
}) {
  return (
    <GlossaryAnnotationContext.Provider value={controller}>
      {children}
    </GlossaryAnnotationContext.Provider>
  );
}
