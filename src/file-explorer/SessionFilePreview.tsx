import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { MessageRichText } from "../MessageRichText.js";
import { BackNavigationButton } from "../back-navigation-button.js";
import { SelectionTextActionSurface } from "../session-components.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";
import type {
  SessionFileDescriptor,
  SessionFileResourceRequest,
  SessionFileRoot,
  FileRootGitChangeScope,
} from "./file-explorer-contract.js";
import {
  getSessionFileResourceDisplayPath,
  isSessionFileAbsoluteResource,
  isSessionFileRootResource,
} from "./file-explorer-contract.js";
import {
  calculateImageFitZoom,
  decodeSessionFileBytes,
  findPreviewTextMatches,
  formatFileByteLength,
  PreviewByteAccumulator,
  resolveMarkdownImageTarget,
  SESSION_FILE_LARGE_WARNING_BYTES,
  SESSION_FILE_READ_CHUNK_BYTES,
  splitPreviewLines,
  type SessionFileEncodingSelection,
  type PreviewTextMatch,
} from "./file-preview-utils.js";
import { isLikelyBinarySessionFile } from "./file-content-detection.js";
import { SessionContentFindBar } from "../session-content-find-bar.js";
import {
  applyRenderedTextHighlights,
  clearRenderedTextHighlights,
  createRenderedTextSearchIndex,
  findRenderedTextMatchOffsets,
  resolveRenderedTextMatch,
  resolveRenderedTextMatches,
  scrollRenderedTextMatchIntoView,
  type RenderedTextMatch,
  type RenderedTextMatchOffsets,
  type RenderedTextSearchIndex,
} from "./rendered-text-search.js";
import { PreviewResourceQueue } from "./preview-resource-queue.js";
import { clampFindMatchIndex } from "../find-text-matches.js";
import {
  parseUnifiedDiff,
  type UnifiedDiffContentRow,
  type UnifiedDiffDisplayRow,
} from "./unified-diff.js";
import {
  canProjectStructuredText,
  highlightRawStructuredText,
  projectStructuredText,
  resolveStructuredTextFormat,
  STRUCTURED_TEXT_PREVIEW_MAX_BYTES,
  type PreviewSyntaxToken,
  type StructuredTextFormat,
  type StructuredTextProjection,
} from "./structured-text-preview.js";

type FilePreviewApi = Pick<
  WithMateWindowApi,
  | "listSessionFileRoots"
  | "inspectSessionFile"
  | "readSessionFileChunk"
  | "openSessionFile"
  | "openSessionFilePreviewWindow"
  | "openPath"
  | "copySessionFilePreviewImage"
  | "showSessionFilePreviewImageContextMenu"
>;

type SessionFilePreviewProps = {
  api: FilePreviewApi | null;
  request: SessionFileResourceRequest;
  backNavigation?: {
    label: string;
    onBack: () => void;
  };
  onCopyText: (text: string) => void;
  onQuoteText?: (text: string) => void;
  diffScopes?: FileRootGitChangeScope[];
  onOpenDiff?: (scope: FileRootGitChangeScope) => Promise<string | null>;
  diffLoadingScope?: FileRootGitChangeScope | null;
  diffAvailabilityMessage?: string;
  chatNotice?: string;
};

type LoadedFile = {
  descriptor: SessionFileDescriptor;
  bytes: Uint8Array;
};

type ImagePanSession = {
  pointerId: number;
  clientX: number;
  clientY: number;
  scrollLeft: number;
  scrollTop: number;
};

type FileLoadState =
  | { status: "inspecting" }
  | { status: "large-warning"; descriptor: SessionFileDescriptor }
  | { status: "loading"; descriptor: SessionFileDescriptor; loadedBytes: number }
  | { status: "ready"; loaded: LoadedFile | null; descriptor: SessionFileDescriptor }
  | { status: "error"; message: string };

type StructuredTextProjectionState =
  | { status: "idle" | "loading" }
  | {
    status: "ready";
    sourceText: string;
    format: StructuredTextFormat;
    projection: StructuredTextProjection;
  }
  | {
    status: "error";
    sourceText: string;
    format: StructuredTextFormat;
    message: string;
    rawTokens: PreviewSyntaxToken[][] | null;
  };

const MARKDOWN_LOCAL_IMAGE_CONCURRENCY = 4;
const IMAGE_ZOOM_MIN = 10;
const IMAGE_ZOOM_MAX = 800;
const IMAGE_ZOOM_STEP = 10;

const ENCODING_OPTIONS: Array<{ value: SessionFileEncodingSelection; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "utf-8", label: "UTF-8" },
  { value: "shift_jis", label: "Shift_JIS (Windows-31J)" },
  { value: "utf-16le", label: "UTF-16 LE" },
  { value: "utf-16be", label: "UTF-16 BE" },
];

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function resolveVisibleImageCopyPoint(
  image: HTMLImageElement,
  scrollport: HTMLElement,
): { x: number; y: number } | null {
  const rect = image.getBoundingClientRect();
  const scrollportRect = scrollport.getBoundingClientRect();
  const left = Math.max(0, rect.left, scrollportRect.left);
  const top = Math.max(0, rect.top, scrollportRect.top);
  const right = Math.min(window.innerWidth, rect.right, scrollportRect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom, scrollportRect.bottom);
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

async function readWholeResource(
  api: Pick<FilePreviewApi, "readSessionFileChunk">,
  descriptor: SessionFileDescriptor,
  isCurrent: () => boolean,
  accumulator: PreviewByteAccumulator,
  onProgress?: (loadedBytes: number) => void,
): Promise<Uint8Array> {
  let offset = 0;
  const resource = isSessionFileAbsoluteResource(descriptor)
    ? { sessionId: descriptor.sessionId, absolutePath: descriptor.absolutePath }
    : {
        sessionId: descriptor.sessionId,
        rootId: descriptor.rootId,
        relativePath: descriptor.relativePath,
      };
  while (offset < descriptor.byteLength) {
    const result = await api.readSessionFileChunk({
      ...resource,
      offset,
      length: Math.min(SESSION_FILE_READ_CHUNK_BYTES, descriptor.byteLength - offset),
      expectedRevision: descriptor.revision,
    });
    if (!isCurrent()) {
      throw new Error("File load was replaced.");
    }
    if (result.offset !== offset || result.totalBytes !== descriptor.byteLength) {
      throw new Error("File contents changed while they were being read.");
    }
    accumulator.append(new Uint8Array(result.data));
    offset = result.nextOffset;
    onProgress?.(offset);
    if (result.done) {
      break;
    }
  }
  return accumulator.finish(descriptor.byteLength);
}

type VirtualizedTextContentProps = {
  text: string;
  copyText: (text: string) => void;
  quoteText?: (text: string) => void;
  matches: PreviewTextMatch[];
  currentMatchIndex: number;
  variant?: "text" | "diff";
  syntaxTokens?: PreviewSyntaxToken[][] | null;
};

type IndexedPreviewTextMatch = PreviewTextMatch & { matchIndex: number };

function renderHighlightedLine(
  line: string,
  matches: IndexedPreviewTextMatch[],
  currentMatchIndex: number,
): ReactNode {
  if (matches.length === 0) {
    return line || " ";
  }
  const content: ReactNode[] = [];
  let offset = 0;
  for (const match of matches) {
    if (match.startOffset > offset) {
      content.push(line.slice(offset, match.startOffset));
    }
    content.push(
      <mark
        key={`${match.startOffset}-${match.endOffset}`}
        className={match.matchIndex === currentMatchIndex ? "is-current" : undefined}
      >
        {line.slice(match.startOffset, match.endOffset)}
      </mark>,
    );
    offset = match.endOffset;
  }
  if (offset < line.length) {
    content.push(line.slice(offset));
  }
  return content;
}

function syntaxTokenStyle(token: PreviewSyntaxToken, includeColor: boolean): CSSProperties {
  return {
    ...(includeColor && token.color ? { color: token.color } : {}),
    ...(token.fontStyle && (token.fontStyle & 1) !== 0 ? { fontStyle: "italic" } : {}),
    ...(token.fontStyle && (token.fontStyle & 2) !== 0 ? { fontWeight: 700 } : {}),
    ...(token.fontStyle && (token.fontStyle & 4) !== 0 ? { textDecoration: "underline" } : {}),
  };
}

function renderSyntaxHighlightedLine(
  line: string,
  tokens: PreviewSyntaxToken[],
  matches: IndexedPreviewTextMatch[],
  currentMatchIndex: number,
): ReactNode {
  if (tokens.map((token) => token.content).join("") !== line) {
    return renderHighlightedLine(line, matches, currentMatchIndex);
  }
  const content: ReactNode[] = [];
  let lineOffset = 0;
  let key = 0;
  for (const token of tokens) {
    const tokenStart = lineOffset;
    const tokenEnd = tokenStart + token.content.length;
    const boundaries = new Set([tokenStart, tokenEnd]);
    for (const match of matches) {
      if (match.endOffset > tokenStart && match.startOffset < tokenEnd) {
        boundaries.add(Math.max(tokenStart, match.startOffset));
        boundaries.add(Math.min(tokenEnd, match.endOffset));
      }
    }
    const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
      const start = sortedBoundaries[index] ?? tokenStart;
      const end = sortedBoundaries[index + 1] ?? tokenEnd;
      if (end <= start) {
        continue;
      }
      const text = token.content.slice(start - tokenStart, end - tokenStart);
      const match = matches.find((candidate) => candidate.startOffset <= start && candidate.endOffset >= end);
      if (match) {
        content.push(
          <mark
            key={key}
            className={match.matchIndex === currentMatchIndex ? "is-current" : undefined}
            style={syntaxTokenStyle(token, false)}
          >
            {text}
          </mark>,
        );
      } else {
        content.push(<span key={key} style={syntaxTokenStyle(token, true)}>{text}</span>);
      }
      key += 1;
    }
    lineOffset = tokenEnd;
  }
  return content.length > 0 ? content : " ";
}

function VirtualizedTextContent({
  text,
  copyText,
  quoteText,
  matches,
  currentMatchIndex,
  variant = "text",
  syntaxTokens = null,
}: VirtualizedTextContentProps) {
  const lines = useMemo(() => splitPreviewLines(text), [text]);
  const matchesByLine = useMemo(() => {
    const grouped = new Map<number, IndexedPreviewTextMatch[]>();
    matches.forEach((match, matchIndex) => {
      const lineMatches = grouped.get(match.lineIndex) ?? [];
      lineMatches.push({ ...match, matchIndex });
      grouped.set(match.lineIndex, lineMatches);
    });
    return grouped;
  }, [matches]);
  const targetLine = matches[currentMatchIndex]?.lineIndex ?? null;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 23,
    overscan: 24,
    useFlushSync: false,
  });

  useEffect(() => {
    if (targetLine !== null) {
      virtualizer.scrollToIndex(targetLine, { align: "center" });
    }
  }, [targetLine, virtualizer]);

  return (
    <SelectionTextActionSurface
      className="session-file-text-scroll"
      onCopyText={copyText}
      onQuoteText={quoteText}
      selectAllText={text}
      surfaceRef={scrollRef}
    >
      <div className="session-file-text-lines" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualLine) => {
          const line = lines[virtualLine.index] ?? "";
          const diffKind = variant === "diff"
            ? line.startsWith("+") && !line.startsWith("+++")
              ? " added"
              : line.startsWith("-") && !line.startsWith("---")
                ? " removed"
                : line.startsWith("@@")
                  ? " hunk"
                  : ""
            : "";
          return (
            <div
              key={virtualLine.key}
              className={`session-file-text-line${diffKind}`}
              data-index={virtualLine.index}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${virtualLine.start}px)` }}
            >
              <span className="session-file-line-number" aria-hidden="true">{virtualLine.index + 1}</span>
              <code>
                {syntaxTokens?.[virtualLine.index]
                  ? renderSyntaxHighlightedLine(
                    line,
                    syntaxTokens[virtualLine.index] ?? [],
                    matchesByLine.get(virtualLine.index) ?? [],
                    currentMatchIndex,
                  )
                  : renderHighlightedLine(line, matchesByLine.get(virtualLine.index) ?? [], currentMatchIndex)}
              </code>
            </div>
          );
        })}
      </div>
    </SelectionTextActionSurface>
  );
}

type VirtualizedSplitDiffContentProps = {
  patch: string;
  copyText: (text: string) => void;
  quoteText?: (text: string) => void;
  matches: PreviewTextMatch[];
  currentMatchIndex: number;
};

function rowContainsPatchLine(row: UnifiedDiffDisplayRow, patchLineIndex: number): boolean {
  if (row.kind === "metadata" || row.kind === "hunk" || row.kind === "note") {
    return row.patchLineIndex === patchLineIndex;
  }
  return row.leftPatchLineIndex === patchLineIndex || row.rightPatchLineIndex === patchLineIndex;
}

function VirtualizedSplitDiffContent({
  patch,
  copyText,
  quoteText,
  matches,
  currentMatchIndex,
}: VirtualizedSplitDiffContentProps) {
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const matchesByLine = useMemo(() => {
    const grouped = new Map<number, IndexedPreviewTextMatch[]>();
    matches.forEach((match, matchIndex) => {
      const lineMatches = grouped.get(match.lineIndex) ?? [];
      lineMatches.push({ ...match, matchIndex });
      grouped.set(match.lineIndex, lineMatches);
    });
    return grouped;
  }, [matches]);
  const activePatchLineIndex = matches[currentMatchIndex]?.lineIndex ?? null;
  const activeRowIndex = useMemo(() => (
    activePatchLineIndex === null
      ? null
      : parsed.rows.findIndex((row) => rowContainsPatchLine(row, activePatchLineIndex))
  ), [activePatchLineIndex, parsed.rows]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: parsed.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 25,
    overscan: 24,
    useFlushSync: false,
  });

  useEffect(() => {
    if (activeRowIndex !== null && activeRowIndex >= 0) {
      virtualizer.scrollToIndex(activeRowIndex, { align: "center" });
    }
  }, [activeRowIndex, virtualizer]);

  const renderContentCell = (
    row: UnifiedDiffContentRow,
    side: "left" | "right",
  ) => {
    const patchLineIndex = side === "left" ? row.leftPatchLineIndex : row.rightPatchLineIndex;
    const text = side === "left" ? row.leftText : row.rightText;
    return (
      <>
        <span className="session-live-diff-line-number" aria-hidden="true">
          {side === "left" ? row.leftNumber ?? "" : row.rightNumber ?? ""}
        </span>
        <code className={`session-live-diff-code ${side}`}>
          {renderHighlightedLine(
            text ?? "",
            patchLineIndex === undefined ? [] : matchesByLine.get(patchLineIndex) ?? [],
            currentMatchIndex,
          )}
        </code>
      </>
    );
  };

  return (
    <div className="session-live-diff-split">
      <div className="session-live-diff-split-header" aria-hidden="true">
        <span />
        <strong>Before</strong>
        <span />
        <strong>After</strong>
      </div>
      <SelectionTextActionSurface
        className="session-live-diff-split-scroll"
        onCopyText={copyText}
        onQuoteText={quoteText}
        selectAllText={patch}
        surfaceRef={scrollRef}
      >
        <div className="session-live-diff-split-rows" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = parsed.rows[virtualRow.index];
            if (!row) {
              return null;
            }
            const isActive = activeRowIndex === virtualRow.index;
            if (row.kind === "metadata" || row.kind === "hunk" || row.kind === "note") {
              return (
                <div
                  key={virtualRow.key}
                  className={`session-live-diff-split-row ${row.kind}${isActive ? " is-current" : ""}`}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <code>
                    {renderHighlightedLine(
                      row.text,
                      matchesByLine.get(row.patchLineIndex) ?? [],
                      currentMatchIndex,
                    )}
                  </code>
                </div>
              );
            }
            return (
              <div
                key={virtualRow.key}
                className={`session-live-diff-split-row change ${row.kind}${isActive ? " is-current" : ""}`}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderContentCell(row, "left")}
                {renderContentCell(row, "right")}
              </div>
            );
          })}
        </div>
      </SelectionTextActionSurface>
    </div>
  );
}

export function SessionFilePreview({
  api,
  request,
  backNavigation,
  onCopyText,
  onQuoteText,
  diffScopes = [],
  onOpenDiff,
  diffLoadingScope = null,
  diffAvailabilityMessage = "",
  chatNotice = "",
}: SessionFilePreviewProps) {
  const loadRevisionRef = useRef(0);
  const activePreviewAccumulatorRef = useRef<PreviewByteAccumulator | null>(null);
  const markdownImageAccumulatorsRef = useRef(new Set<PreviewByteAccumulator>());
  const markdownImageQueue = useMemo(
    () => new PreviewResourceQueue(MARKDOWN_LOCAL_IMAGE_CONCURRENCY),
    [],
  );
  const [loadState, setLoadState] = useState<FileLoadState>({ status: "inspecting" });
  const [encoding, setEncoding] = useState<SessionFileEncodingSelection>("auto");
  const [markdownMode, setMarkdownMode] = useState<"preview" | "source">("preview");
  const [structuredTextMode, setStructuredTextMode] = useState<"formatted" | "raw">("formatted");
  const [structuredTextProjection, setStructuredTextProjection] = useState<StructuredTextProjectionState>({
    status: "idle",
  });
  const [imageZoom, setImageZoom] = useState<"fit" | number>("fit");
  const [imageFitZoom, setImageFitZoom] = useState(100);
  const [imageObjectUrl, setImageObjectUrl] = useState("");
  const [roots, setRoots] = useState<SessionFileRoot[]>([]);
  const [feedback, setFeedback] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);
  const [reloadRevision, setReloadRevision] = useState(0);
  const markdownSurfaceRef = useRef<HTMLDivElement | null>(null);
  const imagePanSessionRef = useRef<ImagePanSession | null>(null);
  const [isImagePanning, setIsImagePanning] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const imageScrollRef = useRef<HTMLDivElement | null>(null);
  const imageCanvasRef = useRef<HTMLDivElement | null>(null);
  const renderedMarkdownIndexRef = useRef<RenderedTextSearchIndex | null>(null);
  const renderedMarkdownMatchesRef = useRef<RenderedTextMatchOffsets>({
    offsets: new Uint32Array(0),
    normalizedQueryLength: 0,
  });
  const [renderedMarkdownIndexRevision, setRenderedMarkdownIndexRevision] = useState(0);
  const [renderedMarkdownMatchCount, setRenderedMarkdownMatchCount] = useState(0);

  useLayoutEffect(() => {
    for (const accumulator of markdownImageAccumulatorsRef.current) {
      accumulator.release();
    }
    markdownImageAccumulatorsRef.current.clear();
    markdownImageQueue.invalidate();
    return () => {
      for (const accumulator of markdownImageAccumulatorsRef.current) {
        accumulator.release();
      }
      markdownImageAccumulatorsRef.current.clear();
      markdownImageQueue.invalidate();
    };
  }, [
    encoding,
    markdownImageQueue,
    markdownMode,
    reloadRevision,
    getSessionFileResourceDisplayPath(request),
    request.sessionId,
    roots,
  ]);

  const loadDescriptor = useCallback(async (descriptor: SessionFileDescriptor, revision: number) => {
    if (!api) {
      setLoadState({ status: "error", message: "File API is unavailable." });
      return;
    }
    if (descriptor.kind === "binary") {
      setLoadState({ status: "ready", descriptor, loaded: null });
      return;
    }

    activePreviewAccumulatorRef.current?.release();
    const accumulator = new PreviewByteAccumulator();
    activePreviewAccumulatorRef.current = accumulator;
    setLoadState({ status: "loading", descriptor, loadedBytes: 0 });
    try {
      const bytes = await readWholeResource(
        api,
        descriptor,
        () => loadRevisionRef.current === revision,
        accumulator,
        (loadedBytes) => {
          if (loadRevisionRef.current === revision) {
            setLoadState({ status: "loading", descriptor, loadedBytes });
          }
        },
      );
      if (loadRevisionRef.current === revision) {
        setLoadState({ status: "ready", descriptor, loaded: { descriptor, bytes } });
      }
    } catch (error) {
      if (loadRevisionRef.current === revision) {
        setLoadState({ status: "error", message: error instanceof Error ? error.message : "File could not be loaded." });
      }
    } finally {
      accumulator.release();
      if (activePreviewAccumulatorRef.current === accumulator) {
        activePreviewAccumulatorRef.current = null;
      }
    }
  }, [api]);

  useEffect(() => {
    const revision = loadRevisionRef.current + 1;
    loadRevisionRef.current = revision;
    activePreviewAccumulatorRef.current?.release();
    activePreviewAccumulatorRef.current = null;
    setLoadState({ status: "inspecting" });
    setEncoding("auto");
    setMarkdownMode("preview");
    setStructuredTextMode("formatted");
    setStructuredTextProjection({ status: "idle" });
    setImageZoom("fit");
    imagePanSessionRef.current = null;
    setIsImagePanning(false);
    setImageObjectUrl("");
    setFeedback("");
    setFindOpen(false);
    setFindQuery("");
    setCurrentMatch(0);

    if (!api) {
      setLoadState({ status: "error", message: "File API is unavailable." });
      return () => {
        loadRevisionRef.current += 1;
      };
    }

    void Promise.all([
      api.inspectSessionFile(request),
      api.listSessionFileRoots(request.sessionId),
    ]).then(([descriptor, nextRoots]) => {
      if (loadRevisionRef.current !== revision) {
        return;
      }
      setRoots(nextRoots);
      if (descriptor.kind !== "binary" && descriptor.byteLength >= SESSION_FILE_LARGE_WARNING_BYTES) {
        setLoadState({ status: "large-warning", descriptor });
      } else {
        void loadDescriptor(descriptor, revision);
      }
    }).catch((error) => {
      if (loadRevisionRef.current === revision) {
        setLoadState({ status: "error", message: error instanceof Error ? error.message : "File could not be inspected." });
      }
    });

    return () => {
      loadRevisionRef.current += 1;
      activePreviewAccumulatorRef.current?.release();
      activePreviewAccumulatorRef.current = null;
    };
  }, [api, loadDescriptor, reloadRevision, request]);

  const descriptor = loadState.status === "inspecting" || loadState.status === "error"
    ? null
    : loadState.descriptor;
  const loaded = loadState.status === "ready" ? loadState.loaded : null;
  const loadedTextIsBinary = Boolean(
    loaded &&
    (loaded.descriptor.kind === "text" || loaded.descriptor.kind === "markdown") &&
    isLikelyBinarySessionFile(loaded.bytes),
  );
  const previewKind = loadedTextIsBinary ? "binary" : descriptor?.kind;
  const decodedText = useMemo(() => {
    if (!loaded || (loaded.descriptor.kind !== "text" && loaded.descriptor.kind !== "markdown")) {
      return "";
    }
    return decodeSessionFileBytes(loaded.bytes, encoding, loaded.descriptor.suggestedEncoding);
  }, [encoding, loaded]);
  const structuredTextFormat = previewKind === "text" && descriptor
    ? resolveStructuredTextFormat(descriptor.name)
    : null;
  const structuredTextEligible = Boolean(
    loaded &&
    structuredTextFormat &&
    canProjectStructuredText(loaded.bytes.byteLength),
  );

  useEffect(() => {
    if (!structuredTextFormat || !structuredTextEligible) {
      setStructuredTextProjection({ status: "idle" });
      return;
    }
    let current = true;
    setStructuredTextMode("formatted");
    setStructuredTextProjection({ status: "loading" });
    void projectStructuredText(decodedText, structuredTextFormat).then((projection) => {
      if (current) {
        setStructuredTextProjection({
          status: "ready",
          sourceText: decodedText,
          format: structuredTextFormat,
          projection,
        });
      }
    }).catch(async (error) => {
      const message = error instanceof Error
        ? error.message.split(/\r?\n/, 1)[0] ?? "Structured text could not be formatted."
        : "Structured text could not be formatted.";
      let rawTokens: PreviewSyntaxToken[][] | null = null;
      try {
        rawTokens = await highlightRawStructuredText(decodedText, structuredTextFormat);
      } catch {
        rawTokens = null;
      }
      if (current) {
        setStructuredTextMode("raw");
        setStructuredTextProjection({
          status: "error",
          sourceText: decodedText,
          format: structuredTextFormat,
          message,
          rawTokens,
        });
      }
    });
    return () => {
      current = false;
    };
  }, [decodedText, structuredTextEligible, structuredTextFormat]);

  const currentStructuredTextProjection = structuredTextProjection.status === "ready" &&
    structuredTextProjection.sourceText === decodedText &&
    structuredTextProjection.format === structuredTextFormat
    ? structuredTextProjection.projection
    : null;
  const currentStructuredTextError = structuredTextProjection.status === "error" &&
    structuredTextProjection.sourceText === decodedText &&
    structuredTextProjection.format === structuredTextFormat
    ? structuredTextProjection
    : null;
  const displayedText = currentStructuredTextProjection && structuredTextMode === "formatted"
    ? currentStructuredTextProjection.formattedText
    : decodedText;
  const displayedSyntaxTokens = currentStructuredTextProjection
    ? structuredTextMode === "formatted"
      ? currentStructuredTextProjection.formattedTokens
      : currentStructuredTextProjection.rawTokens
    : currentStructuredTextError
      ? currentStructuredTextError.rawTokens
      : null;
  const textLines = useMemo(() => splitPreviewLines(displayedText), [displayedText]);
  const findMatches = useMemo(
    () => findPreviewTextMatches(textLines, findQuery),
    [findQuery, textLines],
  );

  useEffect(() => {
    setCurrentMatch(0);
  }, [findQuery, request]);

  useEffect(() => {
    const container = markdownSurfaceRef.current?.querySelector<HTMLElement>(".session-file-markdown") ?? null;
    if (!container || markdownMode !== "preview" || previewKind !== "markdown") {
      renderedMarkdownIndexRef.current = null;
      renderedMarkdownMatchesRef.current = { offsets: new Uint32Array(0), normalizedQueryLength: 0 };
      setRenderedMarkdownMatchCount(0);
      return;
    }
    const rebuildIndex = () => {
      renderedMarkdownIndexRef.current = createRenderedTextSearchIndex(container);
      setRenderedMarkdownIndexRevision((current) => current + 1);
    };
    rebuildIndex();
    const observer = new MutationObserver(rebuildIndex);
    observer.observe(container, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [decodedText, markdownMode, previewKind]);

  useEffect(() => {
    const index = renderedMarkdownIndexRef.current;
    const matches = index
      ? findRenderedTextMatchOffsets(index, findQuery)
      : { offsets: new Uint32Array(0), normalizedQueryLength: 0 };
    renderedMarkdownMatchesRef.current = matches;
    setRenderedMarkdownMatchCount(matches.offsets.length);
    setCurrentMatch(0);
  }, [findQuery, renderedMarkdownIndexRevision]);

  const activeFindMatchCount = previewKind === "markdown" && markdownMode === "preview"
    ? renderedMarkdownMatchCount
    : findMatches.length;
  const activeCurrentMatch = clampFindMatchIndex(currentMatch, activeFindMatchCount);

  useEffect(() => {
    setCurrentMatch((current) => clampFindMatchIndex(current, activeFindMatchCount));
  }, [activeFindMatchCount]);

  useLayoutEffect(() => {
    if (!findOpen || markdownMode !== "preview" || previewKind !== "markdown") {
      return;
    }
    const index = renderedMarkdownIndexRef.current;
    const matches = renderedMarkdownMatchesRef.current;
    if (!index) {
      return;
    }
    const resolvedMatches = resolveRenderedTextMatches(index, matches);
    const resolvedCurrentMatch = resolveRenderedTextMatch(index, matches, activeCurrentMatch);
    applyRenderedTextHighlights(document, resolvedMatches, resolvedCurrentMatch);
    scrollRenderedTextMatchIntoView(resolvedCurrentMatch);
    return () => clearRenderedTextHighlights(document);
  }, [activeCurrentMatch, findOpen, markdownMode, previewKind, renderedMarkdownIndexRevision]);

  useEffect(() => {
    if (!loaded || (loaded.descriptor.kind !== "image" && loaded.descriptor.kind !== "svg")) {
      setImageObjectUrl("");
      return;
    }
    setImageZoom("fit");
    setImageFitZoom(100);
    const objectUrl = URL.createObjectURL(new Blob([copyBytesToArrayBuffer(loaded.bytes)], { type: loaded.descriptor.mimeType }));
    setImageObjectUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [loaded]);

  const startImagePan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth &&
        event.currentTarget.scrollHeight <= event.currentTarget.clientHeight)
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    imagePanSessionRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
    };
    setIsImagePanning(true);
  }, []);

  const moveImagePan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = imagePanSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = session.scrollLeft - (event.clientX - session.clientX);
    event.currentTarget.scrollTop = session.scrollTop - (event.clientY - session.clientY);
  }, []);

  const stopImagePan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (imagePanSessionRef.current?.pointerId !== event.pointerId) {
      return;
    }
    imagePanSessionRef.current = null;
    setIsImagePanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleImagePanCaptureLoss = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (imagePanSessionRef.current?.pointerId === event.pointerId) {
      imagePanSessionRef.current = null;
      setIsImagePanning(false);
    }
  }, []);

  const updateImageFitZoom = useCallback(() => {
    const viewport = imageScrollRef.current;
    const canvas = imageCanvasRef.current;
    const image = imageRef.current;
    if (!viewport || !canvas || !image) {
      return;
    }
    const styles = window.getComputedStyle(canvas);
    const horizontalPadding = (Number.parseFloat(styles.paddingLeft) || 0)
      + (Number.parseFloat(styles.paddingRight) || 0);
    const verticalPadding = (Number.parseFloat(styles.paddingTop) || 0)
      + (Number.parseFloat(styles.paddingBottom) || 0);
    setImageFitZoom(calculateImageFitZoom(
      viewport.clientWidth - horizontalPadding,
      viewport.clientHeight - verticalPadding,
      image.naturalWidth,
      image.naturalHeight,
    ));
  }, []);

  useLayoutEffect(() => {
    if (!imageObjectUrl) {
      return;
    }
    updateImageFitZoom();
    if (typeof ResizeObserver === "undefined" || !imageScrollRef.current) {
      return;
    }
    const observer = new ResizeObserver(updateImageFitZoom);
    observer.observe(imageScrollRef.current);
    return () => observer.disconnect();
  }, [imageObjectUrl, updateImageFitZoom]);

  const effectiveImageZoom = typeof imageZoom === "number" ? imageZoom : imageFitZoom;
  const imageZoomLabel = `${effectiveImageZoom}%`;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        if (previewKind === "text" || previewKind === "markdown") {
          setFindOpen(true);
          setFeedback("");
        } else {
          setFeedback("Find is available for text, Markdown, and Git diff previews.");
        }
      } else if (event.key === "Escape") {
        if (findOpen) {
          event.preventDefault();
          setFindOpen(false);
        } else if (backNavigation) {
          event.preventDefault();
          backNavigation.onBack();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [backNavigation, findOpen, previewKind]);

  const navigateMatch = useCallback((direction: 1 | -1) => {
    if (previewKind === "markdown" && markdownMode === "preview") {
      const matches = renderedMarkdownMatchesRef.current;
      const index = renderedMarkdownIndexRef.current;
      if (!index || matches.offsets.length === 0) {
        return;
      }
      setCurrentMatch((current) => {
        const next = (
          clampFindMatchIndex(current, matches.offsets.length)
          + direction
          + matches.offsets.length
        ) % matches.offsets.length;
        return next;
      });
      return;
    }
    if (findMatches.length === 0) {
      return;
    }
    setCurrentMatch((current) => (
      clampFindMatchIndex(current, findMatches.length)
      + direction
      + findMatches.length
    ) % findMatches.length);
  }, [findMatches.length, markdownMode, previewKind]);
  const openCurrentFile = useCallback(async () => {
    if (!api) {
      return;
    }
    const revision = loadRevisionRef.current;
    try {
      const result = await api.openSessionFile(request);
      if (loadRevisionRef.current === revision) {
        setFeedback(result.status === "opened" ? "" : result.message);
      }
    } catch (error) {
      if (loadRevisionRef.current === revision) {
        setFeedback(error instanceof Error ? error.message : "The file could not be opened.");
      }
    }
  }, [api, request]);

  const revealCurrentFile = useCallback(async () => {
    if (!api) {
      return;
    }
    const revision = loadRevisionRef.current;
    try {
      const result = await api.openSessionFile({ ...request, reveal: true });
      if (loadRevisionRef.current === revision) {
        setFeedback(result.status === "revealed" || result.status === "opened" ? "" : result.message);
      }
    } catch (error) {
      if (loadRevisionRef.current === revision) {
        setFeedback(error instanceof Error ? error.message : "The file could not be revealed.");
      }
    }
  }, [api, request]);

  const copyPreviewImage = useCallback(async () => {
    if (!api || !imageRef.current || !imageScrollRef.current) {
      return;
    }
    const point = resolveVisibleImageCopyPoint(imageRef.current, imageScrollRef.current);
    if (!point) {
      setFeedback("The image is not currently visible.");
      return;
    }
    const revision = loadRevisionRef.current;
    try {
      const result = await api.copySessionFilePreviewImage({
        sessionId: request.sessionId,
        point,
      });
      if (loadRevisionRef.current === revision) {
        setFeedback(result.status === "copied" ? "Image copied." : result.message);
      }
    } catch {
      if (loadRevisionRef.current === revision) {
        setFeedback("Image could not be copied.");
      }
    }
  }, [api, request.sessionId]);

  const showPreviewImageContextMenu = useCallback(async (
    event: ReactMouseEvent<HTMLImageElement>,
  ) => {
    event.preventDefault();
    if (!api) {
      return;
    }
    const revision = loadRevisionRef.current;
    try {
      const result = await api.showSessionFilePreviewImageContextMenu({
        sessionId: request.sessionId,
        point: {
          x: Math.max(0, Math.round(event.clientX)),
          y: Math.max(0, Math.round(event.clientY)),
        },
      });
      if (loadRevisionRef.current === revision && result.status !== "dismissed") {
        setFeedback(result.status === "copied" ? "Image copied." : result.message);
      }
    } catch {
      if (loadRevisionRef.current === revision) {
        setFeedback("Image context menu could not be opened.");
      }
    }
  }, [api, request.sessionId]);

  const handleOpenMarkdownPath = useCallback((target: string) => {
    if (!api) {
      return;
    }
    const trimmedTarget = target.trim();
    if (!trimmedTarget || trimmedTarget.startsWith("#")) {
      return;
    }
    const revision = loadRevisionRef.current;
    void api.openSessionFilePreviewWindow({
      kind: "link",
      sessionId: request.sessionId,
      target: trimmedTarget,
      baseResource: request,
    })
      .then((result) => {
        if (loadRevisionRef.current === revision) {
          setFeedback(result.status === "opened" ? "" : result.message);
        }
      })
      .catch((error) => {
        if (loadRevisionRef.current === revision) {
          setFeedback(error instanceof Error ? error.message : "The link could not be opened.");
        }
      });
  }, [api, request]);

  const resolveMarkdownImageSource = useCallback(async (target: string): Promise<string | null> => {
    if (!api) {
      return null;
    }
    const imageTarget = resolveMarkdownImageTarget(
      roots,
      isSessionFileRootResource(request) ? request.rootId : "absolute-preview",
      isSessionFileRootResource(request) ? request.relativePath : "",
      target,
    );
    if (imageTarget.kind === "external") {
      return imageTarget.source;
    }
    if (imageTarget.kind === "unsupported") {
      return null;
    }
    if (imageTarget.resource.rootId === "absolute-preview") {
      return null;
    }
    const revision = loadRevisionRef.current;
    return markdownImageQueue.run(async (isQueueCurrent) => {
      const isCurrent = () => isQueueCurrent() && loadRevisionRef.current === revision;
      if (!isCurrent()) {
        return null;
      }
      const resourceDescriptor = await api.inspectSessionFile({
        sessionId: request.sessionId,
        ...imageTarget.resource,
      });
      if (!isCurrent() || (resourceDescriptor.kind !== "image" && resourceDescriptor.kind !== "svg")) {
        return null;
      }
      let bytes: Uint8Array;
      const accumulator = new PreviewByteAccumulator();
      markdownImageAccumulatorsRef.current.add(accumulator);
      try {
        bytes = await readWholeResource(api, resourceDescriptor, isCurrent, accumulator);
      } catch (error) {
        if (!isCurrent()) {
          return null;
        }
        throw error;
      } finally {
        markdownImageAccumulatorsRef.current.delete(accumulator);
        accumulator.release();
      }
      if (!isCurrent()) {
        return null;
      }
      const objectUrl = URL.createObjectURL(new Blob(
        [copyBytesToArrayBuffer(bytes)],
        { type: resourceDescriptor.mimeType },
      ));
      if (!isCurrent()) {
        URL.revokeObjectURL(objectUrl);
        return null;
      }
      return objectUrl;
    });
  }, [api, encoding, markdownImageQueue, request, roots]);

  const openDiff = useCallback(async (scope: FileRootGitChangeScope) => {
    if (!onOpenDiff) {
      return;
    }
    const revision = loadRevisionRef.current;
    try {
      const message = await onOpenDiff(scope);
      if (loadRevisionRef.current === revision) {
        setFeedback(message ?? "");
      }
    } catch (error) {
      if (loadRevisionRef.current === revision) {
        setFeedback(error instanceof Error ? error.message : "Git diff failed.");
      }
    }
  }, [onOpenDiff]);

  const structuredTextFeedback = currentStructuredTextError
    ? `Formatted preview is unavailable: ${currentStructuredTextError.message} Showing raw content.`
    : loaded && structuredTextFormat && loaded.bytes.byteLength > STRUCTURED_TEXT_PREVIEW_MAX_BYTES
      ? `Formatted preview is skipped for files larger than ${formatFileByteLength(STRUCTURED_TEXT_PREVIEW_MAX_BYTES)}.`
      : "";
  const previewFeedback = [feedback, diffAvailabilityMessage, structuredTextFeedback].filter(Boolean);

  return (
    <section className="session-file-preview" aria-label="File preview">
      <header className="session-file-preview-header">
        {backNavigation ? (
          <BackNavigationButton
            label={backNavigation.label}
            notice={chatNotice || undefined}
            onBack={backNavigation.onBack}
          />
        ) : null}
        <div className="session-file-preview-title">
          <strong>{descriptor?.name ?? getSessionFileResourceDisplayPath(request).split(/[\\/]/).at(-1)}</strong>
        </div>
        <div className="session-file-preview-actions">
          {descriptor && (previewKind === "text" || previewKind === "markdown") ? (
            <select
              aria-label="Text encoding"
              value={encoding}
              onChange={(event) => setEncoding(event.currentTarget.value as SessionFileEncodingSelection)}
            >
              {ENCODING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          ) : null}
          {previewKind === "markdown" ? (
            <div className="session-file-preview-segmented" role="group" aria-label="Markdown display mode">
              <button type="button" className={markdownMode === "preview" ? "is-active" : ""} onClick={() => setMarkdownMode("preview")}>Preview</button>
              <button type="button" className={markdownMode === "source" ? "is-active" : ""} onClick={() => setMarkdownMode("source")}>Source</button>
            </div>
          ) : null}
          {structuredTextFormat && structuredTextEligible ? (
            <div className="session-file-preview-segmented" role="group" aria-label="Structured text display mode">
              <button
                type="button"
                className={structuredTextMode === "formatted" ? "is-active" : ""}
                disabled={!currentStructuredTextProjection}
                onClick={() => setStructuredTextMode("formatted")}
              >Formatted</button>
              <button
                type="button"
                className={structuredTextMode === "raw" ? "is-active" : ""}
                onClick={() => setStructuredTextMode("raw")}
              >Raw</button>
            </div>
          ) : null}
          {descriptor && (previewKind === "image" || previewKind === "svg") ? (
            <>
              <button type="button" disabled={!imageObjectUrl} onClick={() => void copyPreviewImage()}>Copy Image</button>
              <div className="session-file-preview-segmented" role="group" aria-label="Image zoom">
                <button
                  type="button"
                  aria-label="Zoom image out"
                  disabled={effectiveImageZoom <= IMAGE_ZOOM_MIN}
                  onClick={() => setImageZoom(Math.max(IMAGE_ZOOM_MIN, effectiveImageZoom - IMAGE_ZOOM_STEP))}
                >−</button>
                <button type="button" aria-label="Reset image zoom to 100%" onClick={() => setImageZoom(100)}>{imageZoomLabel}</button>
                <button
                  type="button"
                  aria-label="Zoom image in"
                  disabled={effectiveImageZoom >= IMAGE_ZOOM_MAX}
                  onClick={() => setImageZoom(Math.min(IMAGE_ZOOM_MAX, effectiveImageZoom + IMAGE_ZOOM_STEP))}
                >＋</button>
                <button type="button" aria-label="Fit image to preview" className={imageZoom === "fit" ? "is-active" : ""} onClick={() => setImageZoom("fit")}>Fit</button>
              </div>
            </>
          ) : null}
          {onOpenDiff && diffScopes.length > 0 ? diffScopes.map((scope) => (
            <button
              key={scope}
              type="button"
              disabled={diffLoadingScope !== null}
              onClick={() => void openDiff(scope)}
            >
              {diffLoadingScope === scope
                ? "Loading Diff…"
                : diffScopes.length === 1
                ? "Open Diff"
                : scope === "staged"
                  ? "Staged Diff"
                  : "Working Tree Diff"}
            </button>
          )) : null}
          {previewKind === "text" || previewKind === "markdown" ? (
            <button type="button" onClick={() => setFindOpen(true)}>Find</button>
          ) : null}
          <button type="button" onClick={() => setReloadRevision((current) => current + 1)}>Reload</button>
          <button type="button" onClick={() => void openCurrentFile()}>Open</button>
          <button type="button" onClick={() => void revealCurrentFile()}>Show in Explorer</button>
        </div>
      </header>

      {findOpen && descriptor && (previewKind === "text" || previewKind === "markdown") ? (
        <SessionContentFindBar
          open
          query={findQuery}
          currentMatch={activeCurrentMatch}
          matchCount={activeFindMatchCount}
          onQueryChange={setFindQuery}
          onPrevious={() => navigateMatch(-1)}
          onNext={() => navigateMatch(1)}
          onClose={() => setFindOpen(false)}
        />
      ) : null}

      {loadState.status === "inspecting" ? <div className="session-file-preview-status">Inspecting file…</div> : null}
      {loadState.status === "loading" ? (
        <div className="session-file-preview-status">
          <progress max={loadState.descriptor.byteLength || 1} value={loadState.loadedBytes} />
          <span>{formatFileByteLength(loadState.loadedBytes)} / {formatFileByteLength(loadState.descriptor.byteLength)}</span>
        </div>
      ) : null}
      {loadState.status === "large-warning" ? (
        <div className="session-file-preview-large-warning">
          <strong>Large file: {formatFileByteLength(loadState.descriptor.byteLength)}</strong>
          <p>The file can still be opened. It is read in chunks and replaces the previous preview.</p>
          <button type="button" onClick={() => void loadDescriptor(loadState.descriptor, loadRevisionRef.current)}>Load anyway</button>
        </div>
      ) : null}
      {loadState.status === "error" ? <div className="session-file-preview-error" role="alert">{loadState.message}</div> : null}

      {loadState.status === "ready" && descriptor && previewKind === "binary" ? (
        <div className="session-file-preview-metadata">
          <strong>Preview is not available for this binary file.</strong>
          <dl>
            <div><dt>Type</dt><dd>{descriptor.mimeType}</dd></div>
            <div><dt>Size</dt><dd>{formatFileByteLength(descriptor.byteLength)}</dd></div>
            <div><dt>Modified</dt><dd>{descriptor.modifiedAt}</dd></div>
          </dl>
          <button type="button" onClick={() => void openCurrentFile()}>Open in default app</button>
          <button type="button" onClick={() => void revealCurrentFile()}>Show in Explorer</button>
        </div>
      ) : null}

      {loadState.status === "ready" && loaded && previewKind === "text" ? (
        <VirtualizedTextContent
          text={displayedText}
          copyText={onCopyText}
          quoteText={onQuoteText}
          matches={findMatches}
          currentMatchIndex={activeCurrentMatch}
          syntaxTokens={displayedSyntaxTokens}
        />
      ) : null}
      {loadState.status === "ready" && loaded && previewKind === "markdown" ? (
        markdownMode === "preview" ? (
          <SelectionTextActionSurface
            className="session-file-markdown-scroll"
            onCopyText={onCopyText}
            onQuoteText={onQuoteText}
            surfaceRef={markdownSurfaceRef}
          >
            <MessageRichText
              text={decodedText}
              className="session-file-markdown"
              onOpenPath={handleOpenMarkdownPath}
              resolveImageSource={resolveMarkdownImageSource}
            />
          </SelectionTextActionSurface>
        ) : (
          <VirtualizedTextContent
            text={decodedText}
            copyText={onCopyText}
            quoteText={onQuoteText}
            matches={findMatches}
            currentMatchIndex={activeCurrentMatch}
          />
        )
      ) : null}
      {loadState.status === "ready" && loaded && descriptor && (previewKind === "image" || previewKind === "svg") ? (
        <div
          ref={imageScrollRef}
          className={`session-file-image-scroll${isImagePanning ? " is-panning" : ""}`}
          onPointerDown={startImagePan}
          onPointerMove={moveImagePan}
          onPointerUp={stopImagePan}
          onPointerCancel={stopImagePan}
          onLostPointerCapture={handleImagePanCaptureLoss}
        >
          <div
            ref={imageCanvasRef}
            className={`session-file-image-canvas${imageZoom === "fit" ? " is-fit" : ""}`}
          >
            {imageObjectUrl ? (
              <img
                ref={imageRef}
                className={`session-file-image${imageZoom === "fit" ? " is-fit" : ""}`}
                src={imageObjectUrl}
                alt={descriptor.name}
                draggable={false}
                onContextMenu={(event) => void showPreviewImageContextMenu(event)}
                onLoad={updateImageFitZoom}
                style={imageZoom === "fit" ? undefined : { zoom: imageZoom / 100 }}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {previewFeedback.length > 0 ? (
        <p className="session-file-preview-feedback" role="alert">
          {previewFeedback.map((message, index) => (
            <span key={message}>
              {index > 0 ? <br /> : null}
              {message}
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}

export type SessionDiffPreviewProps = {
  title: string;
  previewRevision: number;
  patch: string;
  backNavigation?: {
    label: string;
    onBack: () => void;
  };
  onCopyText: (text: string) => void;
  onQuoteText?: (text: string) => void;
  onReload?: () => Promise<string | null>;
  reloadPending?: boolean;
  chatNotice?: string;
};

export function SessionDiffPreview({
  title,
  previewRevision,
  patch,
  backNavigation,
  onCopyText,
  onQuoteText,
  onReload,
  reloadPending = false,
  chatNotice = "",
}: SessionDiffPreviewProps) {
  const [viewMode, setViewMode] = useState<"split" | "inline">("split");
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);
  const [feedback, setFeedback] = useState("");
  const previewIdentity = `${title}\0${previewRevision}`;
  const previewIdentityRef = useRef(previewIdentity);
  const reloadRevisionRef = useRef(0);
  if (previewIdentityRef.current !== previewIdentity) {
    previewIdentityRef.current = previewIdentity;
    reloadRevisionRef.current += 1;
  }
  const lines = useMemo(() => splitPreviewLines(patch), [patch]);
  const matches = useMemo(() => findPreviewTextMatches(lines, query), [lines, query]);
  const activeCurrentMatch = clampFindMatchIndex(currentMatch, matches.length);

  useEffect(() => {
    setCurrentMatch(0);
  }, [query]);

  useEffect(() => {
    setCurrentMatch((current) => clampFindMatchIndex(current, matches.length));
  }, [matches.length]);

  useEffect(() => {
    setFeedback("");
  }, [previewIdentity]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (findOpen) {
          setFindOpen(false);
        } else if (backNavigation) {
          backNavigation.onBack();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [backNavigation, findOpen]);

  const navigate = (direction: 1 | -1) => {
    if (matches.length > 0) {
      setCurrentMatch((current) => (
        clampFindMatchIndex(current, matches.length)
        + direction
        + matches.length
      ) % matches.length);
    }
  };

  const reload = async () => {
    if (!onReload) {
      return;
    }
    const revision = ++reloadRevisionRef.current;
    try {
      const message = await onReload();
      if (revision === reloadRevisionRef.current && previewIdentityRef.current === previewIdentity) {
        setFeedback(message ?? "");
      }
    } catch (error) {
      if (revision === reloadRevisionRef.current && previewIdentityRef.current === previewIdentity) {
        setFeedback(error instanceof Error ? error.message : "Git diff failed.");
      }
    }
  };

  return (
    <section className="session-file-preview session-diff-preview" aria-label="Git diff preview">
      <header className="session-file-preview-header">
        {backNavigation ? (
          <BackNavigationButton
            label={backNavigation.label}
            notice={chatNotice || undefined}
            onBack={backNavigation.onBack}
          />
        ) : null}
        <div className="session-file-preview-title"><strong>{title}</strong><span>Git Diff</span></div>
        <div className="session-file-preview-actions">
          <div className="session-file-preview-segmented" role="group" aria-label="Git diff display mode">
            <button
              type="button"
              className={viewMode === "split" ? "is-active" : ""}
              onClick={() => setViewMode("split")}
            >
              Split
            </button>
            <button
              type="button"
              className={viewMode === "inline" ? "is-active" : ""}
              onClick={() => setViewMode("inline")}
            >
              Inline
            </button>
          </div>
          <button type="button" onClick={() => setFindOpen(true)}>Find</button>
          {onReload ? (
            <button
              type="button"
              disabled={reloadPending}
              onClick={() => void reload()}
            >
              {reloadPending ? "Reloading…" : "Reload"}
            </button>
          ) : null}
        </div>
      </header>
      <SessionContentFindBar
        open={findOpen}
        query={query}
        currentMatch={activeCurrentMatch}
        matchCount={matches.length}
        onQueryChange={setQuery}
        onPrevious={() => navigate(-1)}
        onNext={() => navigate(1)}
        onClose={() => setFindOpen(false)}
      />
      {viewMode === "split" ? (
        <VirtualizedSplitDiffContent
          patch={patch}
          copyText={onCopyText}
          quoteText={onQuoteText}
          matches={matches}
          currentMatchIndex={activeCurrentMatch}
        />
      ) : (
        <VirtualizedTextContent
          text={patch}
          copyText={onCopyText}
          quoteText={onQuoteText}
          matches={matches}
          currentMatchIndex={activeCurrentMatch}
          variant="diff"
        />
      )}
      {feedback ? <p className="session-file-preview-feedback" role="alert">{feedback}</p> : null}
    </section>
  );
}
