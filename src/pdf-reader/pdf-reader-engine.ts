import {
  AnnotationEditorType,
  AnnotationMode,
  getDocument,
  PasswordResponses,
  PDFWorker,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import {
  DownloadManager,
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export {
  FindState,
  ScrollMode,
  SpreadMode,
} from "pdfjs-dist/web/pdf_viewer.mjs";

/** 閲覧位置の復元に必要なページ、スクロール位置、倍率、回転角。 */
export type PdfPosition = {
  page: number;
  left: number;
  top: number;
  scale: number;
  rotation: number;
};
/** PDF.js 側の移動、失敗、パスワード要求、添付操作をプレビューの所有元へ返す通知先。 */
type ReaderCallbacks = {
  openLink: (target: string) => void;
  beforeNavigate: () => void;
  back: () => void;
  forward: () => void;
  error: (message: string) => void;
  password: (submit: (password: string) => void, incorrect: boolean) => void;
  attachment: (name: string, bytes: Uint8Array) => void;
};

/** PDF.js のエラー理由を表示に使い、Error でなければプレビュー失敗の共通文を返す。 */
function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The PDF could not be displayed.";
}

/** 文書内の移動をプレビュー履歴へつなぎ、外部リンクはブラウザーによる直接遷移ではなく所有元へ渡す。 */
export class ReaderLinkService extends PDFLinkService {
  /** PDF.js のイベントバスと、閲覧画面側の移動・エラーの通知先を保持する。 */
  constructor(
    eventBus: EventBus,
    private readonly callbacks: ReaderCallbacks,
  ) {
    super({ eventBus });
  }
  /** リンクの既定遷移を止め、選ばれた宛先を所有元のリンク処理に委ねる。 */
  override addLinkAttributes(link: HTMLAnchorElement, url: string): void {
    link.href = "#";
    link.title = url;
    link.onclick = (event) => {
      event.preventDefault();
      this.callbacks.openLink(url);
      return false;
    };
  }
  /** 文書内リンクへ移動する前に現在位置を通知し、PDF.js の移動失敗を表示側へ返す。 */
  override async goToDestination(
    destination: string | unknown[],
  ): Promise<void> {
    this.callbacks.beforeNavigate();
    try {
      await super.goToDestination(destination);
    } catch (error) {
      this.callbacks.error(messageOf(error));
    }
  }
  /** ページ番号やラベルで移動する前に、履歴へ記録するため画面側へ通知する。 */
  override goToPage(value: number | string): void {
    this.callbacks.beforeNavigate();
    super.goToPage(value);
  }
  /** 移動履歴とページ移動に対応する名前付き操作だけを受け付ける。 */
  override executeNamedAction(action: string): void {
    if (action === "GoBack") this.callbacks.back();
    else if (action === "GoForward") this.callbacks.forward();
    else if (
      ["NextPage", "PrevPage", "FirstPage", "LastPage"].includes(action)
    ) {
      this.callbacks.beforeNavigate();
      super.executeNamedAction(action);
    }
  }
  /** 文書内のレイヤー表示を PDF.js で切り替え、処理に失敗した場合は画面へ通知する。 */
  override async executeSetOCGState(
    action: Parameters<PDFLinkService["executeSetOCGState"]>[0],
  ): Promise<void> {
    try {
      await super.executeSetOCGState(action);
    } catch (error) {
      this.callbacks.error(messageOf(error));
    }
  }
}

/** 添付の閲覧要求は画面へ渡すが、この Reader から PDF や添付を保存する操作は提供しない。 */
class ReadOnlyAttachments extends DownloadManager {
  /** 添付の表示や非対応操作の通知に使うコールバックを保持する。 */
  constructor(private readonly callbacks: ReaderCallbacks) {
    super();
  }
  /** 添付の名前とバイト列を画面へ渡し、PDF.js には処理済みを返す。 */
  override openOrDownloadData(bytes: Uint8Array, name: string): boolean {
    this.callbacks.attachment(name, bytes);
    return true;
  }
  /** 添付データの保存を実行せず、非対応の操作として画面へ通知する。 */
  override downloadData(): void {
    this.callbacks.error("Saving attachments is not available in this reader.");
  }
  /** PDF 文書の保存を実行せず、非対応の操作として画面へ通知する。 */
  override download(): void {
    this.callbacks.error("Saving PDFs is not available in this reader.");
  }
}

/** 一つのプレビューに対する PDF.js の閲覧環境を組み立て、専用 Worker とイベント購読を所有する。 */
export function createPdfReader(
  container: HTMLDivElement,
  pageContainer: HTMLDivElement,
  callbacks: ReaderCallbacks,
) {
  const abort = new AbortController();
  const eventBus = new EventBus();
  const linkService = new ReaderLinkService(eventBus, callbacks);
  const findController = new PDFFindController({ eventBus, linkService });
  // 実体のある Worker ポートを渡す。Worker の読み込みに失敗しても、UI スレッドでの解析に切り替えてはいけない。
  const port = new Worker(workerUrl, { type: "module" });
  const worker = PDFWorker.create({ port });
  const options = {
    container,
    viewer: pageContainer,
    eventBus,
    linkService,
    findController,
    downloadManager: new ReadOnlyAttachments(callbacks),
    annotationMode: AnnotationMode.ENABLE,
    annotationEditorMode: AnnotationEditorType.DISABLE,
    enablePermissions: true,
    enableAutoLinking: false,
    imageResourcesPath: new URL("./images/", location.href).href,
    abortSignal: abort.signal,
  };
  let viewer: PDFViewer;
  try {
    viewer = new PDFViewer(options);
  } catch (error) {
    worker.destroy();
    port.terminate();
    throw error;
  }
  linkService.setViewer(viewer);
  let task: ReturnType<typeof getDocument> | null = null;
  let active = true;
  port.addEventListener(
    "error",
    () => {
      if (active)
        callbacks.error(
          "The PDF worker could not be started. Reload the preview to try again.",
        );
      void task?.destroy().catch(() => undefined);
    },
    { signal: abort.signal },
  );

  // 標準の注釈レイヤーでは既存の外観とコメントを表示するが、フォーム入力やスクリプト実行は行わない。
  // ネットワークの基準 URL が指定されていない場合、この処理がなければ PDF.js は相対ファイルリンクを省く。
  eventBus.on(
    "annotationlayerrendered",
    async ({ pageNumber, error }: { pageNumber: number; error?: unknown }) => {
      if (error) {
        callbacks.error(messageOf(error));
        return;
      }
      const pdf = viewer.pdfDocument;
      if (!pdf) return;
      try {
        const annotations = await (
          await pdf.getPage(pageNumber)
        ).getAnnotations({ intent: "display" });
        if (!active || viewer.pdfDocument !== pdf) return;
        const page = viewer.getPageView(pageNumber - 1)?.div as
          HTMLElement | undefined;
        if (!page) return;
        for (const annotation of annotations) {
          if (
            typeof annotation.unsafeUrl !== "string" ||
            annotation.url ||
            !annotation.unsafeUrl.trim()
          )
            continue;
          const section = Array.from(
            page.querySelectorAll<HTMLElement>("[data-annotation-id]"),
          ).find((element) => element.dataset.annotationId === annotation.id);
          if (!section) continue;
          const link =
            section.querySelector("a") ?? document.createElement("a");
          linkService.addLinkAttributes(link, annotation.unsafeUrl);
          if (!link.parentElement) section.append(link);
        }
      } catch (error) {
        if (active) callbacks.error(messageOf(error));
      }
    },
  );

  return {
    viewer,
    eventBus,
    linkService,
    findController,
    /** Worker でバイト列を読み、XFA を含まない文書をプレビューが有効な間だけ表示へ接続する。 */
    async load(bytes: Uint8Array): Promise<PDFDocumentProxy> {
      task = getDocument({
        data: bytes,
        worker,
        cMapUrl: new URL("./cmaps/", location.href).href,
        cMapPacked: true,
        standardFontDataUrl: new URL("./standard_fonts/", location.href).href,
        wasmUrl: new URL("./wasm/", location.href).href,
        iccUrl: new URL("./iccs/", location.href).href,
        enableXfa: false,
        stopAtErrors: true,
      });
      task.onPassword = (
        submit: (password: string) => void,
        reason: number,
      ) => {
        if (active)
          callbacks.password(
            submit,
            reason === PasswordResponses.INCORRECT_PASSWORD,
          );
      };
      const pdf = await task.promise;
      const metadata = await pdf.getMetadata();
      if ((metadata.info as { IsXFAPresent?: boolean }).IsXFAPresent) {
        throw new Error(
          "This PDF uses XFA forms, which this reader cannot display completely. Use Open to view it in a compatible application.",
        );
      }
      if (active) {
        linkService.setDocument(pdf);
        viewer.setDocument(pdf);
      }
      return pdf;
    },
    /** 表示文書、イベント購読、読み取り処理、Worker を解放し、二度目以降は何もしない。 */
    destroy() {
      if (!active) return;
      active = false;
      viewer.setDocument(null);
      linkService.setDocument(null);
      abort.abort();
      void task?.destroy().catch(() => undefined);
      worker.destroy();
      port.terminate();
    },
  };
}

/** PDF プレビューが所有する閲覧器・検索器・文書の読込と終了操作。 */
export type PdfReaderEngine = ReturnType<typeof createPdfReader>;
