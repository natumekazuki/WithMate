import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

import {
  isPdfReaderFrameMessage,
  PDF_READER_CHANNEL,
  PDF_READER_ORIGIN,
  PDF_READER_THEME_TOKENS,
  PDF_READER_URL,
  type PdfReaderHostMessage,
  type PdfReaderThemeTokens,
} from "../../src-shared/file-explorer/pdf-reader-contract.js";
import { usePreviewWheelZoomStep } from "../settings/preview-zoom-settings-context.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";

/** プレビュー外部の検索操作を埋め込みPDFリーダーへ転送するハンドル。 */
export type PdfFilePreviewHandle = { find: () => void };

/** PDFのバイト列と、選択テキストや確認済みリンクを処理するホスト側の入口。 */
type PdfFilePreviewProps = {
  ref?: Ref<PdfFilePreviewHandle>;
  bytes: Uint8Array;
  name: string;
  actionsContainer: HTMLElement | null;
  onCopyText: (text: string) => void;
  onQuoteText?: (text: string) => void;
  onOpenLink: (target: string) => void;
};

/** 埋め込みリーダーへ渡すCSSテーマ変数をホストの計算済みスタイルから読み取る。 */
function readThemeTokens(element: HTMLElement): PdfReaderThemeTokens {
  const style = window.getComputedStyle(element);
  return Object.fromEntries(
    PDF_READER_THEME_TOKENS.map((token) => [
      token,
      style.getPropertyValue(token).trim(),
    ]),
  );
}

/** PDFを隔離したフレームで表示し、選択内容の利用とリンク遷移はホストの操作を通して扱う。 */
export function PdfFilePreview({
  ref,
  bytes,
  name,
  actionsContainer,
  onCopyText,
  onQuoteText,
  onOpenLink,
}: PdfFilePreviewProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const openLinkButtonRef = useRef<HTMLButtonElement>(null);
  const [instanceId] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [hasSelection, setHasSelection] = useState(false);
  const pendingSelectionAction = useRef<{
    requestId: string;
    action: "copy" | "quote";
  } | null>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  useEffect(() => {
    if (pendingLink !== null) openLinkButtonRef.current?.focus();
  }, [pendingLink]);
  /** 保留中のリンク遷移を取り消し、PDFフレームへフォーカスを戻す。 */
  const cancelLink = () => {
    setPendingLink(null);
    frameRef.current?.focus();
  };
  const zoomWheelStep = usePreviewWheelZoomStep();
  const zoomWheelStepRef = useRef(zoomWheelStep);
  zoomWheelStepRef.current = zoomWheelStep;
  const initializedRef = useRef(false);
  useImperativeHandle(
    ref,
    () => ({
      /** 初期化済みのPDFリーダーに検索UIを開くよう依頼する。 */
      find() {
        if (!initializedRef.current) return;
        frameRef.current?.contentWindow?.postMessage(
          {
            channel: PDF_READER_CHANNEL,
            instanceId,
            type: "find",
          } satisfies PdfReaderHostMessage,
          PDF_READER_ORIGIN,
        );
      },
    }),
    [instanceId],
  );

  useEffect(() => {
    if (!initializedRef.current) return;
    frameRef.current?.contentWindow?.postMessage(
      {
        channel: PDF_READER_CHANNEL,
        instanceId,
        type: "settings",
        zoomWheelStep,
      } satisfies PdfReaderHostMessage,
      PDF_READER_ORIGIN,
    );
  }, [instanceId, zoomWheelStep]);
  const callbacksRef = useRef({ onCopyText, onQuoteText, onOpenLink });
  callbacksRef.current = { onCopyText, onQuoteText, onOpenLink };
  /** コピー・引用の明示操作時に選択範囲を要求し、応答と照合するIDを保持する。 */
  const actOnSelection = (action: "copy" | "quote") => {
    if (!initializedRef.current || !hasSelection) return;
    const requestId = crypto.randomUUID();
    pendingSelectionAction.current = { requestId, action };
    // 有効状態は目安にすぎない。このホスト側の操作を受けて、その時点の選択範囲を読み取る。
    frameRef.current?.contentWindow?.postMessage(
      {
        channel: PDF_READER_CHANNEL,
        instanceId,
        type: "get-selection",
        requestId,
      } satisfies PdfReaderHostMessage,
      PDF_READER_ORIGIN,
    );
  };

  useEffect(() => {
    let active = true;
    let sent = false;
    let failed = false;
    /** 現行フレームを一度だけ失敗状態へ移し、選択操作と起動待ちを無効にする。 */
    const fail = (message: string) => {
      if (!active || failed) return;
      failed = true;
      initializedRef.current = false;
      pendingSelectionAction.current = null;
      setHasSelection(false);
      clearTimeout(startupTimer);
      setError(message);
      setState("error");
    };
    const startupTimer = setTimeout(
      () =>
        fail(
          "The PDF viewer did not respond within 15 seconds. Reload the preview to try again.",
        ),
      15_000,
    );
    /** PDFリーダーのオリジンを送信先に固定して、現在のフレームだけへ通知する。 */
    const send = (
      message: PdfReaderHostMessage,
      transfer: Transferable[] = [],
    ) => {
      frameRef.current?.contentWindow?.postMessage(
        message,
        PDF_READER_ORIGIN,
        transfer,
      );
    };
    /** 送信元・オリジン・インスタンスを検証し、読み込み、選択応答、リンク提案をホスト状態へ反映する。 */
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (
        !active ||
        failed ||
        event.source !== frameRef.current?.contentWindow ||
        event.origin !== PDF_READER_ORIGIN ||
        !isPdfReaderFrameMessage(event.data, instanceId)
      )
        return;
      const message = event.data;
      if (message.type === "ready") {
        if (sent || !hostRef.current) return;
        clearTimeout(startupTimer);
        sent = true;
        initializedRef.current = true;
        const copy = bytes.slice().buffer;
        send(
          {
            channel: PDF_READER_CHANNEL,
            instanceId,
            type: "load",
            bytes: copy,
            name,
            canQuote: Boolean(callbacksRef.current.onQuoteText),
            zoomWheelStep: zoomWheelStepRef.current,
            themeTokens: readThemeTokens(hostRef.current),
          },
          [copy],
        );
        setState("ready");
      } else if (message.type === "loaded") {
        if (sent) setState("ready");
      } else if (message.type === "error") {
        fail(message.message || "The PDF could not be displayed.");
      } else if (message.type === "selection") {
        if (!sent) return;
        if (message.requestId !== undefined) {
          const pending = pendingSelectionAction.current;
          if (!pending || pending.requestId !== message.requestId) return;
          pendingSelectionAction.current = null;
          setHasSelection(Boolean(message.text.trim()));
          if (message.text.trim()) {
            if (pending.action === "copy")
              callbacksRef.current.onCopyText(message.text);
            else callbacksRef.current.onQuoteText?.(message.text);
          }
          return;
        }
        setHasSelection(Boolean(message.text.trim()));
        if (!message.text.trim()) pendingSelectionAction.current = null;
      } else if (message.type === "open-link") {
        // 文書からのメッセージで遷移先は提案できるが、ホスト API は呼び出せない。
        setPendingLink((current) => current ?? message.target);
      }
    };
    window.addEventListener("message", handleMessage);
    const observer = new MutationObserver(() => {
      if (sent && hostRef.current)
        send({
          channel: PDF_READER_CHANNEL,
          instanceId,
          type: "theme",
          themeTokens: readThemeTokens(hostRef.current),
        });
    });
    for (
      let element: HTMLElement | null = hostRef.current;
      element;
      element = element.parentElement
    ) {
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    }
    return () => {
      active = false;
      clearTimeout(startupTimer);
      initializedRef.current = false;
      pendingSelectionAction.current = null;
      observer.disconnect();
      window.removeEventListener("message", handleMessage);
    };
  }, [bytes, instanceId, name]);

  return (
    <span
      ref={hostRef}
      className="session-pdf-preview"
      aria-label="PDF Reader"
      aria-busy={state === "loading" || undefined}
    >
      {actionsContainer
        ? createPortal(
            <>
              <button
                type="button"
                disabled={!hasSelection || state !== "ready"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => actOnSelection("copy")}
              >
                Copy Text
              </button>
              {onQuoteText ? (
                <button
                  type="button"
                  disabled={!hasSelection || state !== "ready"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => actOnSelection("quote")}
                >
                  Quote
                </button>
              ) : null}
            </>,
            actionsContainer,
          )
        : null}
      {pendingLink !== null ? (
        <span
          className="session-pdf-link-confirmation"
          role="region"
          aria-label="Open PDF Link"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              cancelLink();
            }
          }}
        >
          <span>Open Link</span>
          <bdi className="session-pdf-link-target">{pendingLink}</bdi>
          <button
            ref={openLinkButtonRef}
            type="button"
            onClick={() => {
              const target = pendingLink;
              cancelLink();
              callbacksRef.current.onOpenLink(target);
            }}
          >
            Open
          </button>
          <button type="button" onClick={cancelLink}>
            Cancel
          </button>
        </span>
      ) : null}
      {state === "loading" ? (
        <span className="session-pdf-loading">
          <LoadingIndicator label="Loading PDF" />
        </span>
      ) : null}
      {state === "error" ? (
        <span className="session-file-preview-error" role="alert">
          {error}
        </span>
      ) : null}
      <iframe
        ref={frameRef}
        className="session-pdf-frame"
        title={`PDF Reader: ${name}`}
        src={`${PDF_READER_URL}#${new URLSearchParams({ instanceId, hostOrigin: window.location.protocol === "file:" ? "null" : window.location.origin })}`}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        hidden={state === "error"}
      />
    </span>
  );
}
