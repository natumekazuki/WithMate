import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { OptionalContentConfig } from "pdfjs-dist/types/src/display/optional_content_config.js";
import type { PDFLinkService } from "pdfjs-dist/web/pdf_viewer.mjs";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import "./pdf-sidebar.css";

/** サイドバーが読む文書と現在ページ・レイヤー設定、および閲覧側へ返すナビゲーションと添付操作。 */
export type PdfSidebarProps = {
  document: PDFDocumentProxy;
  currentPage: number;
  pageLabels: string[] | null;
  rotation: number;
  optionalContentConfigPromise: Promise<OptionalContentConfig>;
  layerRevision: number;
  onGoToPage: (page: number) => void;
  onGoToDestination: (destination: string | unknown[]) => void;
  onSetOCGState: (
    action: Parameters<PDFLinkService["executeSetOCGState"]>[0],
  ) => void;
  onOpenLink: (url: string) => void;
  onOpenAttachment: (name: string, bytes: Uint8Array) => void;
  onLayersChanged: (config: OptionalContentConfig) => void;
};

/** サイドバーで切り替える、ページへの入口または文書の補足情報の種類。 */
type View = "Thumbnails" | "Outline" | "Layers" | "Attachments" | "Info";
/** PDF.js のしおり項目。文書が指定していればレイヤーの操作も持つ。 */
type OutlineNode = Awaited<
  ReturnType<PDFDocumentProxy["getOutline"]>
>[number] & {
  setOCGState?: Parameters<PDFLinkService["executeSetOCGState"]>[0];
};
/** サイドバーの個別取得について、待機中・値の取得・診断を含む失敗を区別する。 */
type ReadResult<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

/** Error からはメッセージを取り出し、それ以外の失敗理由も文字列で表示できるようにする。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 文書や表示条件が変わるたびに取得し直し、以前の取得結果で現在の表示を上書きしない。 */
function useDocumentData<T>(
  load: () => Promise<T>,
  dependencies: readonly unknown[],
) {
  const [result, setResult] = useState<ReadResult<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setResult({ status: "loading" });
    void load().then(
      (value) => {
        if (active) setResult({ status: "ready", value });
      },
      (error: unknown) => {
        if (active)
          setResult({ status: "error", message: errorMessage(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [...dependencies, attempt]);
  return {
    result,
    /** 同じ条件の取得を新しく試行する。 */
    retry: () => setAttempt((value) => value + 1),
  };
}

/** 取得中は対象名付きの進捗、失敗時は診断と再試行を表示し、成功時の内容は呼び出し元に任せる。 */
function ReadFeedback({
  result,
  retry,
  label,
}: {
  result: ReadResult<unknown>;
  retry: () => void;
  label: string;
}) {
  if (result.status === "loading") return <LoadingIndicator label={label} />;
  if (result.status !== "error") return null;
  return (
    <div className="pdf-sidebar-error">
      <p role="alert">{result.message}</p>
      <button type="button" onClick={retry}>
        Retry
      </button>
    </div>
  );
}

/** 現在の回転とレイヤー設定で一ページを縮小描画し、表示対象が変わったら以前の描画を取り消す。 */
function Thumbnail({
  document,
  pageNumber,
  label,
  rotation,
  selected,
  onGoToPage,
  optionalContentConfigPromise,
  layerRevision,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  label: string;
  rotation: number;
  selected: boolean;
  onGoToPage: (page: number) => void;
  optionalContentConfigPromise: Promise<OptionalContentConfig>;
  layerRevision: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<ReadResult<null>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let active = true;
    let task: RenderTask | undefined;
    setStatus({ status: "loading" });
    void (async () => {
      const page = await document.getPage(pageNumber);
      if (!active) return;
      const angle = (page.rotate + rotation) % 360;
      const original = page.getViewport({ scale: 1, rotation: angle });
      const viewport = page.getViewport({
        scale: Math.min(140 / original.width, 156 / original.height),
        rotation: angle,
      });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      task = page.render({
        canvas,
        viewport,
        annotationMode: 0,
        optionalContentConfigPromise,
      });
      await task.promise;
      if (active) setStatus({ status: "ready", value: null });
    })().catch((error: unknown) => {
      if (active) setStatus({ status: "error", message: errorMessage(error) });
    });
    return () => {
      active = false;
      task?.cancel();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [
    document,
    pageNumber,
    rotation,
    optionalContentConfigPromise,
    layerRevision,
    attempt,
  ]);
  return (
    <div className="pdf-thumbnail-item">
      <button
        type="button"
        className="pdf-thumbnail"
        aria-label={`Go to page ${label}`}
        aria-current={selected ? "page" : undefined}
        onClick={() => onGoToPage(pageNumber)}
      >
        <span className="pdf-thumbnail-image">
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            hidden={status.status !== "ready"}
          />
          {status.status === "loading" && (
            <LoadingIndicator label={`Loading page ${label} thumbnail`} />
          )}
          {status.status === "error" && <span>Preview Unavailable</span>}
        </span>
        <span className="pdf-thumbnail-label">{label}</span>
      </button>
      {status.status === "error" && (
        <button
          type="button"
          className="pdf-thumbnail-retry"
          title={status.message}
          onClick={() => setAttempt((value) => value + 1)}
          aria-label={`Retry page ${label} thumbnail`}
        >
          Retry
        </button>
      )}
    </div>
  );
}

/** 表示範囲に近いサムネイルだけを描画し、現在ページを一覧内で見える位置に保つ。 */
function Thumbnails(props: PdfSidebarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: props.document.numPages,
    /** サムネイル一覧だけを仮想化のスクロール元にする。 */
    getScrollElement: () => scrollRef.current,
    /** サムネイルとラベルを含む各スロットの高さを見積もる。 */
    estimateSize: () => 206,
    overscan: 2,
  });
  useEffect(() => {
    virtualizer.scrollToIndex(props.currentPage - 1, { align: "auto" });
  }, [props.currentPage, virtualizer]);
  return (
    <div
      ref={scrollRef}
      className="pdf-thumbnail-scroll"
      tabIndex={0}
      aria-label="Page Thumbnails"
    >
      <div
        className="pdf-thumbnail-list"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            className="pdf-thumbnail-slot"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <Thumbnail
              document={props.document}
              pageNumber={item.index + 1}
              label={props.pageLabels?.[item.index] || String(item.index + 1)}
              rotation={props.rotation}
              selected={props.currentPage === item.index + 1}
              onGoToPage={props.onGoToPage}
              optionalContentConfigPromise={props.optionalContentConfigPromise}
              layerRevision={props.layerRevision}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** しおりの階層と開閉状態を描画し、項目に指定されたリンク・文書内移動・レイヤー操作を取り次ぐ。 */
function OutlineItems({
  items,
  onGoToDestination,
  onOpenLink,
  onSetOCGState,
}: { items: OutlineNode[] } & Pick<
  PdfSidebarProps,
  "onGoToDestination" | "onOpenLink" | "onSetOCGState"
>) {
  return (
    <ul className="pdf-outline-list">
      {items.map((item, index) => {
        const title = (
          <span
            style={{
              fontWeight: item.bold ? 700 : undefined,
              fontStyle: item.italic ? "italic" : undefined,
            }}
          >
            {item.title}
          </span>
        );
        const url = item.url || item.unsafeUrl;
        const content =
          url || item.dest || item.setOCGState ? (
            <button
              type="button"
              className="pdf-outline-link"
              onClick={() => {
                if (url) onOpenLink(url);
                else if (item.dest) onGoToDestination(item.dest);
                else if (item.setOCGState) onSetOCGState(item.setOCGState);
              }}
            >
              {title}
            </button>
          ) : (
            title
          );
        return (
          <li key={index}>
            {item.items?.length ? (
              <details open={!(item.count !== undefined && item.count < 0)}>
                <summary>{content}</summary>
                <OutlineItems
                  items={item.items}
                  onGoToDestination={onGoToDestination}
                  onOpenLink={onOpenLink}
                  onSetOCGState={onSetOCGState}
                />
              </details>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 現在の文書のしおりを取得し、取得状態と内容を分けて表示する。 */
function Outline(props: PdfSidebarProps) {
  const { result, retry } = useDocumentData(
    () => props.document.getOutline(),
    [props.document],
  );
  return (
    <>
      <ReadFeedback result={result} retry={retry} label="Loading outline" />
      {result.status === "ready" && result.value && (
        <OutlineItems
          items={result.value}
          onGoToDestination={props.onGoToDestination}
          onOpenLink={props.onOpenLink}
          onSetOCGState={props.onSetOCGState}
        />
      )}
    </>
  );
}

/** レイヤーの表示順を構成する個別 ID と、入れ子にできるグループ。 */
type LayerOrder = (string | { name: string | null; order: LayerOrder })[];

/** 文書内の順序でレイヤーを並べ、存在するレイヤーの表示設定を変更して閲覧側へ通知する。 */
function LayerItems({
  order,
  config,
  onChange,
}: {
  order: LayerOrder;
  config: OptionalContentConfig;
  onChange: () => void;
}) {
  return (
    <ul className="pdf-layer-list">
      {order.map((entry, index) => {
        if (typeof entry !== "string")
          return (
            <li key={index}>
              {entry.name && (
                <span className="pdf-layer-heading">{entry.name}</span>
              )}
              <LayerItems
                order={entry.order}
                config={config}
                onChange={onChange}
              />
            </li>
          );
        const group = config.getGroup(entry) as {
          name: string;
          visible: boolean;
        } | null;
        if (!group) return null;
        return (
          <li key={entry}>
            <label>
              <input
                type="checkbox"
                checked={group.visible}
                onChange={(event) => {
                  config.setVisibility(entry, event.target.checked);
                  onChange();
                }}
              />
              <span>{group.name}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** 文書の添付を列挙し、選んだ添付の読み取りが済むまで他の添付を開く操作を無効にする。 */
function Attachments(props: PdfSidebarProps) {
  const { result, retry } = useDocumentData(
    () => props.document.getAttachments(),
    [props.document],
  );
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  useEffect(() => {
    requestGeneration.current += 1;
    setOpening(null);
    setError(null);
    return () => {
      requestGeneration.current += 1;
    };
  }, [props.document]);
  /** ID に対応する添付内容を取得し、同じ文書を表示している間だけ閲覧要求や失敗を反映する。 */
  async function open(id: string, filename: string) {
    const generation = requestGeneration.current;
    setOpening(id);
    setError(null);
    try {
      const bytes = await props.document.getAttachmentContent(id);
      if (requestGeneration.current !== generation) return;
      if (!bytes) throw new Error("This attachment has no readable content.");
      props.onOpenAttachment(filename, bytes);
    } catch (reason) {
      if (requestGeneration.current === generation)
        setError(errorMessage(reason));
    } finally {
      if (requestGeneration.current === generation) setOpening(null);
    }
  }
  return (
    <>
      <ReadFeedback result={result} retry={retry} label="Loading attachments" />
      {error && (
        <p className="pdf-sidebar-error" role="alert">
          {error}
        </p>
      )}
      {result.status === "ready" && result.value && (
        <ul className="pdf-attachment-list">
          {Array.from(result.value, ([id, attachment]) => (
            <li key={id}>
              <button
                type="button"
                disabled={opening !== null}
                aria-label={`Open ${attachment.filename}`}
                aria-busy={opening === id}
                onClick={() => void open(id, attachment.filename)}
              >
                <span
                  className={
                    opening === id
                      ? "pdf-attachment-name pdf-attachment-name-busy"
                      : "pdf-attachment-name"
                  }
                >
                  {attachment.filename}
                </span>
                {opening === id && (
                  <LoadingIndicator label={`Opening ${attachment.filename}`} />
                )}
              </button>
              {attachment.description && <p>{attachment.description}</p>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** 文書のメタデータと総ページ数、回転後の現在ページの寸法を表示する。 */
function Info(props: PdfSidebarProps) {
  const metadata = useDocumentData(
    () => props.document.getMetadata(),
    [props.document],
  );
  const page = useDocumentData(async () => {
    const value = await props.document.getPage(props.currentPage);
    const viewport = value.getViewport({
      scale: 1,
      rotation: (value.rotate + props.rotation) % 360,
    });
    return `${((viewport.width / 72) * 25.4).toLocaleString("en-US", { maximumFractionDigits: 1 })} × ${((viewport.height / 72) * 25.4).toLocaleString("en-US", { maximumFractionDigits: 1 })} mm`;
  }, [props.document, props.currentPage, props.rotation]);
  const info =
    metadata.result.status === "ready"
      ? (metadata.result.value.info as Record<string, unknown>)
      : {};
  return (
    <>
      <ReadFeedback
        result={metadata.result}
        retry={metadata.retry}
        label="Loading document information"
      />
      <dl className="pdf-document-info">
        {[
          ["Title", info.Title],
          ["Author", info.Author],
          ["Subject", info.Subject],
          ["PDF Version", info.PDFFormatVersion],
        ].map(([label, value]) =>
          typeof value === "string" && value.trim() ? (
            <div key={String(label)}>
              <dt>{String(label)}</dt>
              <dd>{value}</dd>
            </div>
          ) : null,
        )}
        <div>
          <dt>Pages</dt>
          <dd>{props.document.numPages.toLocaleString("en-US")}</dd>
        </div>
        <div>
          <dt>Current Page Size</dt>
          <dd>
            {page.result.status === "ready" ? (
              page.result.value
            ) : (
              <ReadFeedback
                result={page.result}
                retry={page.retry}
                label="Loading page size"
              />
            )}
          </dd>
        </div>
      </dl>
    </>
  );
}

/** サムネイルを初期表示とし、文書内を移動する表示と補足情報の表示を切り替える。 */
export function PdfSidebar(props: PdfSidebarProps) {
  const [view, setView] = useState<View>("Thumbnails");
  const layers = useDocumentData(
    () => props.optionalContentConfigPromise,
    [props.optionalContentConfigPromise],
  );
  const config = layers.result.status === "ready" ? layers.result.value : null;
  return (
    <aside className="pdf-sidebar" aria-label="PDF Sidebar">
      <div className="pdf-sidebar-header">
        <select
          aria-label="Sidebar View"
          value={view}
          onChange={(event) => setView(event.target.value as View)}
        >
          {(
            ["Thumbnails", "Outline", "Layers", "Attachments", "Info"] as const
          ).map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </div>
      {view === "Thumbnails" ? (
        <Thumbnails {...props} />
      ) : (
        <div className="pdf-sidebar-content">
          {view === "Outline" && <Outline {...props} />}
          {view === "Layers" && (
            <>
              <ReadFeedback
                result={layers.result}
                retry={layers.retry}
                label="Loading layers"
              />
              {config && (
                <LayerItems
                  order={(config.getOrder() || []) as LayerOrder}
                  config={config}
                  onChange={() => props.onLayersChanged(config)}
                />
              )}
            </>
          )}
          {view === "Attachments" && <Attachments {...props} />}
          {view === "Info" && <Info {...props} />}
        </div>
      )}
    </aside>
  );
}
