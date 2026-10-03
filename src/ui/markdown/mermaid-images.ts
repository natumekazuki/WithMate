import type { Mermaid } from "mermaid";
import type { MarkdownImageResolver } from "./image-resource-loader.js";
import { resolveMarkdownImageTarget } from "./image-resource-source.js";

type ImageVertex = { id: string; img?: string; text?: string; labelType?: string };
type FlowchartImageDatabase = {
  getVertices?: () => Map<string, ImageVertex>;
  getSubGraphs?: () => { id: string; title: string }[];
  getEdges?: () => { id?: string; start: string; end: string; text?: string }[];
};
export type MermaidImageError = {
  nodeId: string;
  target: string;
  message: string;
};
export type MermaidImageResolver = MarkdownImageResolver;

// Mermaid's parser/config and render must not overlap with another diagram.
let renderQueue: Promise<unknown> = Promise.resolve();
function runMermaidTask<T>(task: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(task);
  renderQueue = result.catch(() => undefined);
  return result;
}

function isImageResource(source: string): boolean {
  return /^(?:https?:|data:image\/|blob:)/i.test(source);
}

function measureImage(
  source: string,
  signal: AbortSignal,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      image.removeAttribute("src");
      reject(new DOMException("Image load was replaced.", "AbortError"));
    };
    image.onload = () => {
      finish();
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      } else {
        reject(new Error("Image has no displayable dimensions."));
      }
    };
    image.onerror = () => {
      finish();
      reject(new Error("Image could not be decoded or loaded."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else image.src = source;
  });
}

function imagePlaceholder(
  width: number,
  height: number,
  key: string,
  failed: boolean,
): string {
  const content = failed
    ? '<rect width="100%" height="100%" fill="#f8eeee"/><path d="M64 24l32 32m0-32L64 56" stroke="#9b1c1c" stroke-width="4"/><text x="80" y="78" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#9b1c1c">Image unavailable</text>'
    : "";
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><!--${key}-->${content}</svg>`)}`;
}

function serializeImageTag(image: HTMLImageElement): string {
  // Mermaid labels use double quotes. Keep attribute quotes independent of them.
  const attributes = [...image.attributes].map(({ name, value }) =>
    `${name}='${value.replace(/&/g, "&amp;").replace(/'/g, "&apos;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}'`,
  );
  return `<img ${attributes.join(" ")}/>`;
}

function sizeHtmlImage(image: HTMLImageElement, size: { width: number; height: number }) {
  // Mermaid may expand a node label image to the label's width.
  if (!image.style.objectFit) image.style.objectFit = "contain";
  // Subgraph titles are measured before their images load. Reserve dimensions
  // up front, while leaving author-provided CSS sizing to Mermaid/the browser.
  if (image.style.width || image.style.height) return;
  const width = Number(image.getAttribute("width"));
  const height = Number(image.getAttribute("height"));
  if (!(width > 0)) image.setAttribute("width", String(height > 0 ? height * size.width / size.height : size.width));
  if (!(height > 0)) image.setAttribute("height", String(width > 0 ? width * size.height / size.width : size.height));
}

export async function renderMermaidWithImages(
  mermaid: Mermaid,
  id: string,
  source: string,
  resolveImageSource: MermaidImageResolver | undefined,
  signal: AbortSignal,
): Promise<{ svg: string; imageErrors: MermaidImageError[] }> {
  signal.throwIfAborted();
  const ownedUrls = new Set<string>();
  const release = () => {
    ownedUrls.forEach((url) => URL.revokeObjectURL(url));
    ownedUrls.clear();
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    const images = new Map<string, { source: string; label: string }>();
    const imageErrors: MermaidImageError[] = [];
    const prepareImage = async (target: string, label: string, nodeId: string, key: string) => {
      signal.throwIfAborted();
      let resolved: string | null = null;
      let size = { width: 160, height: 90 };
      let failed = false;
      try {
        const imageTarget = resolveMarkdownImageTarget(target);
        resolved = resolveImageSource
          ? await resolveImageSource(target, signal)
          : imageTarget.kind === "external" ? imageTarget.source : null;
        if (resolved && resolved !== target && resolved.startsWith("blob:")) {
          if (signal.aborted) URL.revokeObjectURL(resolved);
          else ownedUrls.add(resolved);
        }
        signal.throwIfAborted();
        if (!resolved || !isImageResource(resolved)) {
          throw new Error(
            resolveImageSource
              ? "Image source is unsupported or could not be loaded."
              : "Local images require an authorized file preview.",
          );
        }
        size = await measureImage(resolved, signal);
      } catch (error) {
        signal.throwIfAborted();
        failed = true;
        imageErrors.push({ nodeId, target, message: error instanceof Error ? error.message : "Image could not be loaded." });
      }
      const placeholder = imagePlaceholder(size.width, size.height, key, failed);
      images.set(placeholder, {
        source: failed ? placeholder : resolved!,
        label: `${label}${failed ? " (image unavailable)" : ""}`,
      });
      return { placeholder, size };
    };
    const htmlImages = new Map<string, { image: HTMLImageElement; markup: string; target: string; key: string }>();
    const resolvedHtmlMarkers = new Map<string, string>();
    // Locate literal tags only, then let the HTML parser handle attributes and
    // entities. This is resource preparation, not an HTML sanitizer.
    let preparedSource = source.replace(/<img\b(?:[^'"<>]|"[^"]*"|'[^']*')*>/gi, (markup) => {
      const template = document.createElement("template");
      template.innerHTML = markup;
      const image = template.content.firstElementChild as HTMLImageElement | null;
      if (image?.localName !== "img") return markup;
      image.removeAttribute("srcset");
      if (!image.hasAttribute("src")) return serializeImageTag(image);
      const target = image.getAttribute("src")!;
      const key = `${id}-html-${htmlImages.size}`;
      const marker = imagePlaceholder(1, 1, key, false);
      image.setAttribute("src", marker);
      const preparedMarkup = serializeImageTag(image);
      htmlImages.set(marker, { image, markup: preparedMarkup, target, key });
      return preparedMarkup;
    });
    if (source.includes("@{") || htmlImages.size) {
      // Mermaid exposes parsed flowchart vertices only through mermaidAPI.
      // Read them without mutation; final rendering still uses the strict public renderer.
      const diagram = await runMermaidTask(() => {
        signal.throwIfAborted();
        return mermaid.mermaidAPI.getDiagramFromText(preparedSource);
      });
      const db = diagram.db as FlowchartImageDatabase;
      const labels = [
        ...[...(db.getVertices?.().values() ?? [])].map((vertex) => ({ id: vertex.id, text: vertex.text })),
        ...(db.getSubGraphs?.() ?? []).map((group) => ({ id: group.id, text: group.title })),
        ...(db.getEdges?.() ?? []).map((edge) => ({ id: edge.id ?? `${edge.start} → ${edge.end}`, text: edge.text })),
      ];
      // Only resolve img elements present in parsed labels, not comments or
      // escaped HTML examples. Never restore arbitrary sanitized attributes.
      const htmlOwners = new Map<string, string>();
      for (const label of labels) {
        const template = document.createElement("template");
        template.innerHTML = label.text ?? "";
        for (const image of template.content.querySelectorAll("img[src]")) {
          const marker = image.getAttribute("src")!;
          if (htmlImages.has(marker)) htmlOwners.set(marker, label.id);
        }
      }
      await Promise.all([...htmlOwners].map(async ([marker, owner]) => {
        const entry = htmlImages.get(marker)!;
        const resource = await prepareImage(entry.target, entry.image.alt || owner, owner, `${entry.key}-resolved`);
        resolvedHtmlMarkers.set(marker, resource.placeholder);
        entry.image.setAttribute("src", resource.placeholder);
        sizeHtmlImage(entry.image, resource.size);
        preparedSource = preparedSource.replaceAll(entry.markup, serializeImageTag(entry.image));
      }));
      if (!db.getVertices) preparedSource = source;
      const vertices = [...(db.getVertices?.().values() ?? [])].filter(
        (vertex) => vertex.img,
      );
      const overrides = await Promise.all(
        vertices.map(async (vertex, index) => {
          const target = String(vertex.img);
          const { placeholder } = await prepareImage(target, vertex.text || vertex.id, vertex.id, `${id}-native-${index}`);
          // Repeating img without label clears an explicit label equal to the node ID.
          let text = vertex.text;
          for (const [marker, placeholder] of resolvedHtmlMarkers) text = text?.replaceAll(marker, placeholder);
          const label = text
            ? `, label: ${JSON.stringify(text)}, labelType: ${JSON.stringify(vertex.labelType ?? "string")}`
            : "";
          return `${vertex.id}@{ img: ${JSON.stringify(placeholder)}${label} }`;
        }),
      );
      if (overrides.length) preparedSource += `\n${overrides.join("\n")}\n`;
    }
    signal.throwIfAborted();
    const { svg } = await runMermaidTask(() => {
      signal.throwIfAborted();
      return mermaid.render(id, preparedSource);
    });
    signal.throwIfAborted();
    if (!images.size) return { svg, imageErrors };

    // Strict strips blob: from SVG href. Keep sanitization intact, then attach only
    // prevalidated passive image resources to our exact generated placeholders.
    // Original image bytes never enter Mermaid source or its maxTextSize budget.
    // Mermaid serializes foreignObject labels as HTML (for example <br>), not
    // XML. Parse the sanitized output in an inert template like the HTML host.
    const template = document.createElement("template");
    template.innerHTML = svg;
    const svgElement = template.content.firstElementChild;
    if (svgElement?.localName !== "svg" || svgElement.namespaceURI !== "http://www.w3.org/2000/svg") {
      throw new Error("Mermaid did not produce a valid SVG diagram.");
    }
    for (const image of svgElement.querySelectorAll("image, img")) {
      const attribute = image.localName === "img" ? "src" : "href";
      const resource = images.get(image.getAttribute(attribute) ?? "");
      if (!resource) continue;
      image.setAttribute(attribute, resource.source);
      image.setAttribute("role", "img");
      image.setAttribute("aria-label", resource.label);
    }
    return {
      svg: svgElement.outerHTML,
      imageErrors,
    };
  } catch (error) {
    release();
    signal.removeEventListener("abort", release);
    throw error;
  }
}
