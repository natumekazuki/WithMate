import type { Mermaid } from "mermaid";
import type { MarkdownImageResolver } from "./image-resource-loader.js";
import { resolveMarkdownImageTarget } from "./image-resource-source.js";

type ImageVertex = { id: string; img?: string; text?: string; labelType?: string };
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
    let preparedSource = source;
    if (source.includes("@{")) {
      // Mermaid exposes parsed flowchart vertices only through mermaidAPI.
      // Read them without mutation; final rendering still uses the strict public renderer.
      const diagram = await runMermaidTask(() => {
        signal.throwIfAborted();
        return mermaid.mermaidAPI.getDiagramFromText(source);
      });
      const db = diagram.db as { getVertices?: () => Map<string, ImageVertex> };
      const vertices = [...(db.getVertices?.().values() ?? [])].filter(
        (vertex) => vertex.img,
      );
      const overrides = await Promise.all(
        vertices.map(async (vertex, index) => {
          signal.throwIfAborted();
          const target = String(vertex.img);
          let resolved: string | null = null;
          let size = { width: 160, height: 90 };
          let failed = false;
          try {
            const imageTarget = resolveMarkdownImageTarget(target);
            resolved = resolveImageSource
              ? await resolveImageSource(target, signal)
              : imageTarget.kind === "external" ? imageTarget.source : null;
            if (
              resolved &&
              resolved !== target &&
              resolved.startsWith("blob:")
            ) {
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
            imageErrors.push({
              nodeId: vertex.id,
              target,
              message:
                error instanceof Error
                  ? error.message
                  : "Image could not be loaded.",
            });
          }
          const placeholder = imagePlaceholder(
            size.width,
            size.height,
            `${id}-${index}`,
            failed,
          );
          images.set(placeholder, {
            source: failed ? placeholder : resolved!,
            label: `${vertex.text || vertex.id}${failed ? " (image unavailable)" : ""}`,
          });
          // Repeating img without label clears an explicit label equal to the node ID.
          const label = vertex.text
            ? `, label: ${JSON.stringify(vertex.text)}, labelType: ${JSON.stringify(vertex.labelType ?? "string")}`
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
    for (const image of svgElement.querySelectorAll("image")) {
      const resource = images.get(image.getAttribute("href") ?? "");
      if (!resource) continue;
      image.setAttribute("href", resource.source);
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
