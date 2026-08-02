import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { MessageRichText } from "../MessageRichText.js";
import { SelectionCopySurface } from "../session-components.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";
import type {
  SessionFileDescriptor,
  SessionFileResourceRequest,
  SessionFileRoot,
  WorkspaceChangeScope,
} from "./file-explorer-contract.js";
import {
  decodeSessionFileBytes,
  findPreviewLineMatches,
  formatFileByteLength,
  PreviewByteAccumulator,
  shouldInitiallyFitSvg,
  resolveMarkdownImageTarget,
  resolveMarkdownLinkTarget,
  SESSION_FILE_LARGE_WARNING_BYTES,
  SESSION_FILE_READ_CHUNK_BYTES,
  splitPreviewLines,
  type SessionFileEncodingSelection,
} from "./file-preview-utils.js";
import { isLikelyBinarySessionFile } from "./file-content-detection.js";
import { SessionContentFindBar } from "../session-content-find-bar.js";
import {
  createRenderedTextSearchIndex,
  findRenderedTextMatchOffsets,
  resolveRenderedTextMatch,
  type RenderedTextMatch,
  type RenderedTextMatchOffsets,
  type RenderedTextSearchIndex,
} from "./rendered-text-search.js";
import { PreviewResourceQueue } from "./preview-resource-queue.js";

type FilePreviewApi = Pick<
  WithMateWindowApi,
  "listSessionFileRoots" | "inspectSessionFile" | "readSessionFileChunk" | "openSessionFile" | "openPath"
>;

type SessionFilePreviewProps = {
  api: FilePreviewApi | null;
  request: SessionFileResourceRequest;
  onClose: () => void;
  onCopyText: (text: string) => void;
  diffScopes?: WorkspaceChangeScope[];
  onOpenDiff?: (scope: WorkspaceChangeScope) => Promise<string | null>;
  diffLoadingScope?: WorkspaceChangeScope | null;
  diffAvailabilityMessage?: string;
  chatNotice?: string;
};

type LoadedFile = {
  descriptor: SessionFileDescriptor;
  bytes: Uint8Array;
};

type FileLoadState =
  | { status: "inspecting" }
  | { status: "large-warning"; descriptor: SessionFileDescriptor }
  | { status: "loading"; descriptor: SessionFileDescriptor; loadedBytes: number }
  | { status: "ready"; loaded: LoadedFile | null; descriptor: SessionFileDescriptor }
  | { status: "error"; message: string };

const MARKDOWN_LOCAL_IMAGE_CONCURRENCY = 4;

const ENCODING_OPTIONS: Array<{ value: SessionFileEncodingSelection; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "utf-8", label: "UTF-8" },
  { value: "shift_jis", label: "Shift_JIS (Windows-31J)" },
  { value: "utf-16le", label: "UTF-16 LE" },
  { value: "utf-16be", label: "UTF-16 BE" },
];

function selectRenderedTextMatch(match: RenderedTextMatch | undefined): void {
  if (!match || !match.startNode.isConnected || !match.endNode.isConnected) {
    return;
  }
  const range = document.createRange();
  range.setStart(match.startNode, match.startOffset);
  range.setEnd(match.endNode, match.endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  match.startNode.parentElement?.scrollIntoView({ block: "center" });
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function readWholeResource(
  api: Pick<FilePreviewApi, "readSessionFileChunk">,
  descriptor: SessionFileDescriptor,
  isCurrent: () => boolean,
  accumulator: PreviewByteAccumulator,
  onProgress?: (loadedBytes: number) => void,
): Promise<Uint8Array> {
  let offset = 0;
  while (offset < descriptor.byteLength) {
    const result = await api.readSessionFileChunk({
      sessionId: descriptor.sessionId,
      rootId: descriptor.rootId,
      relativePath: descriptor.relativePath,
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
  targetLine: number | null;
  variant?: "text" | "diff";
};

function VirtualizedTextContent({
  text,
  copyText,
  targetLine,
  variant = "text",
}: VirtualizedTextContentProps) {
  const lines = useMemo(() => splitPreviewLines(text), [text]);
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
    <SelectionCopySurface
      className="session-file-text-scroll"
      onCopyText={copyText}
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
              data-current-match={targetLine === virtualLine.index ? "true" : undefined}
              data-index={virtualLine.index}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${virtualLine.start}px)` }}
            >
              <span className="session-file-line-number" aria-hidden="true">{virtualLine.index + 1}</span>
              <code>{line || " "}</code>
            </div>
          );
        })}
      </div>
    </SelectionCopySurface>
  );
}

export function SessionFilePreview({
  api,
  request,
  onClose,
  onCopyText,
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
  const [imageZoom, setImageZoom] = useState<"fit" | number>(100);
  const [imageObjectUrl, setImageObjectUrl] = useState("");
  const [roots, setRoots] = useState<SessionFileRoot[]>([]);
  const [feedback, setFeedback] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);
  const [reloadRevision, setReloadRevision] = useState(0);
  const markdownSurfaceRef = useRef<HTMLDivElement | null>(null);
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
    request.relativePath,
    request.rootId,
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
    setImageZoom(100);
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
  const textLines = useMemo(() => splitPreviewLines(decodedText), [decodedText]);
  const findMatches = useMemo(
    () => findPreviewLineMatches(textLines, findQuery),
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
    selectRenderedTextMatch(index ? resolveRenderedTextMatch(index, matches, 0) ?? undefined : undefined);
  }, [findQuery, renderedMarkdownIndexRevision]);

  useEffect(() => {
    if (!loaded || (loaded.descriptor.kind !== "image" && loaded.descriptor.kind !== "svg")) {
      setImageObjectUrl("");
      return;
    }
    setImageZoom(loaded.descriptor.kind === "svg" && shouldInitiallyFitSvg(loaded.bytes) ? "fit" : 100);
    const objectUrl = URL.createObjectURL(new Blob([copyBytesToArrayBuffer(loaded.bytes)], { type: loaded.descriptor.mimeType }));
    setImageObjectUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [loaded]);

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
        } else {
          event.preventDefault();
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [findOpen, onClose, previewKind]);

  const navigateMatch = useCallback((direction: 1 | -1) => {
    if (previewKind === "markdown" && markdownMode === "preview") {
      const matches = renderedMarkdownMatchesRef.current;
      const index = renderedMarkdownIndexRef.current;
      if (!index || matches.offsets.length === 0) {
        return;
      }
      setCurrentMatch((current) => {
        const next = (current + direction + matches.offsets.length) % matches.offsets.length;
        selectRenderedTextMatch(resolveRenderedTextMatch(index, matches, next) ?? undefined);
        return next;
      });
      return;
    }
    if (findMatches.length === 0) {
      return;
    }
    setCurrentMatch((current) => (current + direction + findMatches.length) % findMatches.length);
  }, [findMatches.length, markdownMode, previewKind]);

  const currentTargetLine = findMatches.length > 0 ? findMatches[currentMatch] ?? findMatches[0] : null;
  const activeFindMatchCount = previewKind === "markdown" && markdownMode === "preview"
    ? renderedMarkdownMatchCount
    : findMatches.length;
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

  const handleOpenMarkdownPath = useCallback((target: string) => {
    if (!api) {
      return;
    }
    const resolved = resolveMarkdownLinkTarget(roots, request.rootId, request.relativePath, target);
    if (resolved.kind === "fragment") {
      return;
    }
    if (resolved.kind === "unsupported") {
      setFeedback("The link is outside the authorized root or uses an unsupported URL scheme.");
      return;
    }
    const revision = loadRevisionRef.current;
    const openPromise = resolved.kind === "local"
      ? api.openSessionFile({ sessionId: request.sessionId, ...resolved.resource })
      : api.openPath(resolved.target);
    void openPromise
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
  }, [api, request, roots]);

  const resolveMarkdownImageSource = useCallback(async (target: string): Promise<string | null> => {
    if (!api) {
      return null;
    }
    const imageTarget = resolveMarkdownImageTarget(
      roots,
      request.rootId,
      request.relativePath,
      target,
    );
    if (imageTarget.kind === "external") {
      return imageTarget.source;
    }
    if (imageTarget.kind === "unsupported") {
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

  const openDiff = useCallback(async (scope: WorkspaceChangeScope) => {
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

  return (
    <section className="session-file-preview" aria-label="File preview">
      <header className="session-file-preview-header">
        <button className="session-file-back-to-chat" type="button" onClick={onClose}>
          Back to Chat{chatNotice ? <span>{chatNotice}</span> : null}
        </button>
        <div className="session-file-preview-title">
          <strong>{descriptor?.name ?? request.relativePath.split("/").at(-1)}</strong>
          <span title={request.relativePath}>{request.relativePath}</span>
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
          {descriptor && (previewKind === "image" || previewKind === "svg") ? (
            <div className="session-file-preview-segmented" role="group" aria-label="Image zoom">
              <button type="button" onClick={() => setImageZoom((current) => Math.max(10, (typeof current === "number" ? current : 100) - 10))}>−</button>
              <button type="button" onClick={() => setImageZoom(100)}>{typeof imageZoom === "number" ? `${imageZoom}%` : "100%"}</button>
              <button type="button" onClick={() => setImageZoom((current) => Math.min(800, (typeof current === "number" ? current : 100) + 10))}>＋</button>
              <button type="button" className={imageZoom === "fit" ? "is-active" : ""} onClick={() => setImageZoom("fit")}>Fit</button>
            </div>
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
          currentMatch={currentMatch}
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
        <VirtualizedTextContent text={decodedText} copyText={onCopyText} targetLine={currentTargetLine} />
      ) : null}
      {loadState.status === "ready" && loaded && previewKind === "markdown" ? (
        markdownMode === "preview" ? (
          <SelectionCopySurface
            className="session-file-markdown-scroll"
            onCopyText={onCopyText}
            surfaceRef={markdownSurfaceRef}
          >
            <MessageRichText
              text={decodedText}
              className="session-file-markdown"
              onOpenPath={handleOpenMarkdownPath}
              resolveImageSource={resolveMarkdownImageSource}
            />
          </SelectionCopySurface>
        ) : (
          <VirtualizedTextContent text={decodedText} copyText={onCopyText} targetLine={currentTargetLine} />
        )
      ) : null}
      {loadState.status === "ready" && loaded && descriptor && (previewKind === "image" || previewKind === "svg") ? (
        <div className="session-file-image-scroll">
          {imageObjectUrl ? (
            <img
              className={`session-file-image${imageZoom === "fit" ? " is-fit" : ""}`}
              src={imageObjectUrl}
              alt={descriptor.name}
              style={imageZoom === "fit" ? undefined : { zoom: imageZoom / 100 }}
            />
          ) : null}
        </div>
      ) : null}
      {feedback || diffAvailabilityMessage ? (
        <p className="session-file-preview-feedback" role="alert">
          {feedback}
          {feedback && diffAvailabilityMessage ? <br /> : null}
          {diffAvailabilityMessage}
        </p>
      ) : null}
    </section>
  );
}

export type SessionDiffPreviewProps = {
  title: string;
  previewRevision: number;
  patch: string;
  onClose: () => void;
  onCopyText: (text: string) => void;
  onReload?: () => Promise<string | null>;
  reloadPending?: boolean;
  chatNotice?: string;
};

export function SessionDiffPreview({
  title,
  previewRevision,
  patch,
  onClose,
  onCopyText,
  onReload,
  reloadPending = false,
  chatNotice = "",
}: SessionDiffPreviewProps) {
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
  const matches = useMemo(() => findPreviewLineMatches(lines, query), [lines, query]);

  useEffect(() => {
    setCurrentMatch(0);
  }, [query]);

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
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [findOpen, onClose]);

  const navigate = (direction: 1 | -1) => {
    if (matches.length > 0) {
      setCurrentMatch((current) => (current + direction + matches.length) % matches.length);
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
        <button className="session-file-back-to-chat" type="button" onClick={onClose}>
          Back to Chat{chatNotice ? <span>{chatNotice}</span> : null}
        </button>
        <div className="session-file-preview-title"><strong>{title}</strong><span>Git Diff</span></div>
        <div className="session-file-preview-actions">
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
        currentMatch={currentMatch}
        matchCount={matches.length}
        onQueryChange={setQuery}
        onPrevious={() => navigate(-1)}
        onNext={() => navigate(1)}
        onClose={() => setFindOpen(false)}
      />
      <VirtualizedTextContent
        text={patch}
        copyText={onCopyText}
        targetLine={matches.length > 0 ? matches[currentMatch] ?? matches[0] : null}
        variant="diff"
      />
      {feedback ? <p className="session-file-preview-feedback" role="alert">{feedback}</p> : null}
    </section>
  );
}
