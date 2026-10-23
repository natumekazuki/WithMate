import {
  AnnotationEditorType, AnnotationMode, getDocument, PasswordResponses, PDFWorker,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import { DownloadManager, EventBus, PDFFindController, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export { FindState, ScrollMode, SpreadMode } from "pdfjs-dist/web/pdf_viewer.mjs";

export type PdfPosition = { page: number; left: number; top: number; scale: number; rotation: number };
type ReaderCallbacks = {
  openLink: (target: string) => void;
  beforeNavigate: () => void;
  back: () => void;
  forward: () => void;
  error: (message: string) => void;
  password: (submit: (password: string) => void, incorrect: boolean) => void;
  attachment: (name: string, bytes: Uint8Array) => void;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The PDF could not be displayed.";
}

export class ReaderLinkService extends PDFLinkService {
  constructor(eventBus: EventBus, private readonly callbacks: ReaderCallbacks) {
    super({ eventBus });
  }
  override addLinkAttributes(link: HTMLAnchorElement, url: string): void {
    link.href = "#";
    link.title = url;
    link.onclick = (event) => {
      event.preventDefault();
      this.callbacks.openLink(url);
      return false;
    };
  }
  override async goToDestination(destination: string | unknown[]): Promise<void> {
    this.callbacks.beforeNavigate();
    try { await super.goToDestination(destination); }
    catch (error) { this.callbacks.error(messageOf(error)); }
  }
  override goToPage(value: number | string): void {
    this.callbacks.beforeNavigate();
    super.goToPage(value);
  }
  override executeNamedAction(action: string): void {
    if (action === "GoBack") this.callbacks.back();
    else if (action === "GoForward") this.callbacks.forward();
    else if (["NextPage", "PrevPage", "FirstPage", "LastPage"].includes(action)) {
      this.callbacks.beforeNavigate();
      super.executeNamedAction(action);
    }
  }
  override async executeSetOCGState(action: Parameters<PDFLinkService["executeSetOCGState"]>[0]): Promise<void> {
    try { await super.executeSetOCGState(action); }
    catch (error) { this.callbacks.error(messageOf(error)); }
  }
}

class ReadOnlyAttachments extends DownloadManager {
  constructor(private readonly callbacks: ReaderCallbacks) { super(); }
  override openOrDownloadData(bytes: Uint8Array, name: string): boolean {
    this.callbacks.attachment(name, bytes);
    return true;
  }
  override downloadData(): void { this.callbacks.error("Saving attachments is not available in this reader."); }
  override download(): void { this.callbacks.error("Saving PDFs is not available in this reader."); }
}

export function createPdfReader(container: HTMLDivElement, pageContainer: HTMLDivElement, callbacks: ReaderCallbacks) {
  const abort = new AbortController();
  const eventBus = new EventBus();
  const linkService = new ReaderLinkService(eventBus, callbacks);
  const findController = new PDFFindController({ eventBus, linkService });
  // Supply a real Worker port: a worker load failure must not fall back to parsing on the UI thread.
  const port = new Worker(workerUrl, { type: "module" });
  const worker = PDFWorker.create({ port });
  const options = {
    container, viewer: pageContainer, eventBus, linkService, findController,
    downloadManager: new ReadOnlyAttachments(callbacks),
    annotationMode: AnnotationMode.ENABLE,
    annotationEditorMode: AnnotationEditorType.DISABLE,
    enablePermissions: true,
    enableAutoLinking: false,
    imageResourcesPath: new URL("./images/", location.href).href,
    abortSignal: abort.signal,
  };
  let viewer: PDFViewer;
  try { viewer = new PDFViewer(options); }
  catch (error) { worker.destroy(); port.terminate(); throw error; }
  linkService.setViewer(viewer);
  let task: ReturnType<typeof getDocument> | null = null;
  let active = true;
  port.addEventListener("error", () => {
    if (active) callbacks.error("The PDF worker could not be started. Reload the preview to try again.");
    void task?.destroy().catch(() => undefined);
  }, { signal: abort.signal });

  // The standard annotation layer displays existing appearances and comments, without form inputs or scripting.
  // Relative file links are otherwise omitted by PDF.js when no network base URL is supplied.
  eventBus.on("annotationlayerrendered", async ({ pageNumber, error }: { pageNumber: number; error?: unknown }) => {
    if (error) { callbacks.error(messageOf(error)); return; }
    const pdf = viewer.pdfDocument;
    if (!pdf) return;
    try {
      const annotations = await (await pdf.getPage(pageNumber)).getAnnotations({ intent: "display" });
      if (!active || viewer.pdfDocument !== pdf) return;
      const page = viewer.getPageView(pageNumber - 1)?.div as HTMLElement | undefined;
      if (!page) return;
      for (const annotation of annotations) {
        if (typeof annotation.unsafeUrl !== "string" || annotation.url || !annotation.unsafeUrl.trim()) continue;
        const section = Array.from(page.querySelectorAll<HTMLElement>("[data-annotation-id]"))
          .find((element) => element.dataset.annotationId === annotation.id);
        if (!section) continue;
        const link = section.querySelector("a") ?? document.createElement("a");
        linkService.addLinkAttributes(link, annotation.unsafeUrl);
        if (!link.parentElement) section.append(link);
      }
    } catch (error) { if (active) callbacks.error(messageOf(error)); }
  });

  return {
    viewer, eventBus, linkService, findController,
    async load(bytes: Uint8Array): Promise<PDFDocumentProxy> {
      task = getDocument({ data: bytes, worker,
        cMapUrl: new URL("./cmaps/", location.href).href, cMapPacked: true,
        standardFontDataUrl: new URL("./standard_fonts/", location.href).href,
        wasmUrl: new URL("./wasm/", location.href).href,
        iccUrl: new URL("./iccs/", location.href).href,
        enableXfa: false, stopAtErrors: true,
      });
      task.onPassword = (submit: (password: string) => void, reason: number) => {
        if (active) callbacks.password(submit, reason === PasswordResponses.INCORRECT_PASSWORD);
      };
      const pdf = await task.promise;
      const metadata = await pdf.getMetadata();
      if ((metadata.info as { IsXFAPresent?: boolean }).IsXFAPresent) {
        throw new Error("This PDF uses XFA forms, which this reader cannot display completely. Use Open to view it in a compatible application.");
      }
      if (active) {
        linkService.setDocument(pdf);
        viewer.setDocument(pdf);
      }
      return pdf;
    },
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

export type PdfReaderEngine = ReturnType<typeof createPdfReader>;
