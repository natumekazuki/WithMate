import type { Mermaid } from "mermaid";
import type { MarkdownImageResolver } from "./image-resource-loader.js";
import { resolveMarkdownImageTarget } from "./image-resource-source.js";

/** 画像ノードの再指定時にラベルを保つため、解析済み頂点から読む属性。 */
type ImageVertex = {
  id: string;
  img?: string;
  text?: string;
  labelType?: string;
};
/** フローチャートから頂点・サブグラフ見出し・辺ラベルを読み出すための任意API。 */
type FlowchartImageDatabase = {
  getVertices?: () => Map<string, ImageVertex>;
  getSubGraphs?: () => { id: string; title: string }[];
  getEdges?: () => { id?: string; start: string; end: string; text?: string }[];
};
/** 図全体を破棄せず、読み込めなかった画像の対象と原因を利用者へ返す。 */
export type MermaidImageError = {
  nodeId: string;
  target: string;
  message: string;
};
/** Mermaidのローカル画像にもMarkdown画像と同じ解決経路と中断通知を使う。 */
export type MermaidImageResolver = MarkdownImageResolver;

// Mermaid の解析・設定と描画は、別の図の処理と重ねてはいけない。
let renderQueue: Promise<unknown> = Promise.resolve();
/** 解析・描画を直列化し、各処理の失敗は呼び出し元に返して後続の図を止めない。 */
function runMermaidTask<T>(task: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(task);
  renderQueue = result.catch(() => undefined);
  return result;
}

/** 解決結果が画像計測に渡せるHTTP(S)・画像data・Blob URLかを判定する。 */
function isImageResource(source: string): boolean {
  return /^(?:https?:|data:image\/|blob:)/i.test(source);
}

/** ブラウザーが復号できた画像の正の自然寸法を取得し、失敗や中断ではrejectする。 */
function measureImage(
  source: string,
  signal: AbortSignal,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    /** 完了・失敗・中断のいずれでも画像とsignalのイベント登録を外す。 */
    const finish = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
    };
    /** 読込対象が切り替わった場合は元のsrcを外し、寸法待ちを中断する。 */
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

/** 描画後の差し戻しに使う寸法付きの一意なマーカーを作り、失敗画像には代替表示を入れる。 */
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

/** HTMLパーサーが解釈した属性を、Mermaidの二重引用符付きラベルへ戻せる形にエスケープする。 */
function serializeImageTag(image: HTMLImageElement): string {
  // Mermaid のラベルは二重引用符を使う。属性値は別の引用符で囲む。
  const attributes = [...image.attributes].map(
    ({ name, value }) =>
      `${name}='${value.replace(/&/g, "&amp;").replace(/'/g, "&apos;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}'`,
  );
  return `<img ${attributes.join(" ")}/>`;
}

/** 作者指定のCSS寸法は維持し、欠けた属性寸法を自然寸法の比率から補う。 */
function sizeHtmlImage(
  image: HTMLImageElement,
  size: { width: number; height: number },
) {
  // Mermaid がノードラベル内の画像をラベル幅まで広げる場合がある。
  if (!image.style.objectFit) image.style.objectFit = "contain";
  // サブグラフの見出しは画像の読み込み前に計測されるため、先に寸法を確保する。
  // 作成者が指定した CSS の寸法設定は Mermaid やブラウザーに任せる。
  if (image.style.width || image.style.height) return;
  const width = Number(image.getAttribute("width"));
  const height = Number(image.getAttribute("height"));
  if (!(width > 0))
    image.setAttribute(
      "width",
      String(height > 0 ? (height * size.width) / size.height : size.width),
    );
  if (!(height > 0))
    image.setAttribute(
      "height",
      String(width > 0 ? (width * size.height) / size.width : size.height),
    );
}

/** strict描画後の対応するマーカーに解決済み画像を戻し、画像単位の失敗と図のSVGを返す。 */
export async function renderMermaidWithImages(
  mermaid: Mermaid,
  id: string,
  source: string,
  resolveImageSource: MermaidImageResolver | undefined,
  signal: AbortSignal,
): Promise<{ svg: string; imageErrors: MermaidImageError[] }> {
  signal.throwIfAborted();
  const ownedUrls = new Set<string>();
  /** 今回の解決で生成されたBlob URLだけを、中断または描画失敗時に解放する。 */
  const release = () => {
    ownedUrls.forEach((url) => URL.revokeObjectURL(url));
    ownedUrls.clear();
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    const images = new Map<string, { source: string; label: string }>();
    const imageErrors: MermaidImageError[] = [];
    /** 画像を解決して描画用の寸法を測り、個別の失敗を記録して代替画像でレイアウトを維持する。 */
    const prepareImage = async (
      target: string,
      label: string,
      nodeId: string,
      key: string,
    ) => {
      signal.throwIfAborted();
      let resolved: string | null = null;
      let size = { width: 160, height: 90 };
      let failed = false;
      try {
        const imageTarget = resolveMarkdownImageTarget(target);
        resolved = resolveImageSource
          ? await resolveImageSource(target, signal)
          : imageTarget.kind === "external"
            ? imageTarget.source
            : null;
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
        imageErrors.push({
          nodeId,
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
        key,
        failed,
      );
      images.set(placeholder, {
        source: failed ? placeholder : resolved!,
        label: `${label}${failed ? " (image unavailable)" : ""}`,
      });
      return { placeholder, size };
    };
    const htmlImages = new Map<
      string,
      { image: HTMLImageElement; markup: string; target: string; key: string }
    >();
    const resolvedHtmlMarkers = new Map<string, string>();
    // タグとして書かれた箇所だけを探し、属性と実体参照の解釈は HTML パーサーに任せる。
    // これはリソースの準備であり、HTML のサニタイズではない。
    let preparedSource = source.replace(
      /<img\b(?:[^'"<>]|"[^"]*"|'[^']*')*>/gi,
      (markup) => {
        const template = document.createElement("template");
        template.innerHTML = markup;
        const image = template.content
          .firstElementChild as HTMLImageElement | null;
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
      },
    );
    if (source.includes("@{") || htmlImages.size) {
      // Mermaid で解析済みフローチャートの頂点を取得できるのは mermaidAPI だけ。
      // 頂点は変更せずに読み取り、最終描画には引き続き strict の公開レンダラーを使う。
      const diagram = await runMermaidTask(() => {
        signal.throwIfAborted();
        return mermaid.mermaidAPI.getDiagramFromText(preparedSource);
      });
      const db = diagram.db as FlowchartImageDatabase;
      const labels = [
        ...[...(db.getVertices?.().values() ?? [])].map((vertex) => ({
          id: vertex.id,
          text: vertex.text,
        })),
        ...(db.getSubGraphs?.() ?? []).map((group) => ({
          id: group.id,
          text: group.title,
        })),
        ...(db.getEdges?.() ?? []).map((edge) => ({
          id: edge.id ?? `${edge.start} → ${edge.end}`,
          text: edge.text,
        })),
      ];
      // 解析済みラベルにある img 要素だけを解決し、コメントやエスケープ済みの HTML 例は対象にしない。
      // サニタイズされた任意の属性を復元してはいけない。
      const htmlOwners = new Map<string, string>();
      for (const label of labels) {
        const template = document.createElement("template");
        template.innerHTML = label.text ?? "";
        for (const image of template.content.querySelectorAll("img[src]")) {
          const marker = image.getAttribute("src")!;
          if (htmlImages.has(marker)) htmlOwners.set(marker, label.id);
        }
      }
      await Promise.all(
        [...htmlOwners].map(async ([marker, owner]) => {
          const entry = htmlImages.get(marker)!;
          const resource = await prepareImage(
            entry.target,
            entry.image.alt || owner,
            owner,
            `${entry.key}-resolved`,
          );
          resolvedHtmlMarkers.set(marker, resource.placeholder);
          entry.image.setAttribute("src", resource.placeholder);
          sizeHtmlImage(entry.image, resource.size);
          preparedSource = preparedSource.replaceAll(
            entry.markup,
            serializeImageTag(entry.image),
          );
        }),
      );
      if (!db.getVertices) preparedSource = source;
      const vertices = [...(db.getVertices?.().values() ?? [])].filter(
        (vertex) => vertex.img,
      );
      const overrides = await Promise.all(
        vertices.map(async (vertex, index) => {
          const target = String(vertex.img);
          const { placeholder } = await prepareImage(
            target,
            vertex.text || vertex.id,
            vertex.id,
            `${id}-native-${index}`,
          );
          // ラベルを指定せずに img を再指定すると、ノード ID と同じ値の明示ラベルは消去される。
          let text = vertex.text;
          for (const [marker, placeholder] of resolvedHtmlMarkers)
            text = text?.replaceAll(marker, placeholder);
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

    // strict では SVG の href から blob: が除かれる。サニタイズは維持したまま、
    // 事前検証済みの受動的な画像リソースだけを、生成した対応先のプレースホルダーに取り付ける。
    // 元の画像バイト列は Mermaid のソースに入らず、maxTextSize の上限にも算入されない。
    // Mermaid は foreignObject 内のラベルを XML ではなく HTML（<br> など）としてシリアライズする。
    // HTML ホストと同様に、不活性な template 要素でサニタイズ済みの出力を解析する。
    const template = document.createElement("template");
    template.innerHTML = svg;
    const svgElement = template.content.firstElementChild;
    if (
      svgElement?.localName !== "svg" ||
      svgElement.namespaceURI !== "http://www.w3.org/2000/svg"
    ) {
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
