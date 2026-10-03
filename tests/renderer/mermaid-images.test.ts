import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { JSDOM } from "jsdom";
import type { Mermaid } from "mermaid";
import { renderMermaidWithImages } from "../../src/ui/markdown/mermaid-images.js";

let mermaid: Mermaid;
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
const revoked: string[] = [];
const previousRevoke = URL.revokeObjectURL;

// Only the browser's resource loading and geometry are simulated. Mermaid's
// parser, native image renderer and strict sanitizer remain the installed ones.
class LoadedImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 320;
  naturalHeight = 180;
  private resource = "";
  set src(value: string) {
    this.resource = value;
    if (value.startsWith("data:image/svg+xml,")) {
      const svg = new dom.window.DOMParser().parseFromString(decodeURIComponent(value.split(",").slice(1).join(",")), "image/svg+xml");
      this.naturalWidth = Number(svg.documentElement.getAttribute("width"));
      this.naturalHeight = Number(svg.documentElement.getAttribute("height"));
    }
    queueMicrotask(() => value === "blob:bad-image" ? this.onerror?.() : this.onload?.());
  }
  get src() { return this.resource; }
  removeAttribute() { this.resource = ""; }
  async decode() { if (this.resource === "blob:bad-image") throw new Error("decode failed"); }
}

before(async () => {
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document,
    DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer,
    HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement,
    CSSStyleSheet: dom.window.CSSStyleSheet,
    Image: LoadedImage,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", {
    value: () => ({ x: 0, y: 0, width: 80, height: 20 }),
  });
  Object.defineProperty(dom.window.SVGElement.prototype, "getComputedTextLength", { value: () => 80 });
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base" });
});

after(() => {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  URL.revokeObjectURL = previousRevoke;
  dom.window.close();
});

function svgDocument(svg: string) {
  const document = new dom.window.DOMParser().parseFromString(svg, "image/svg+xml");
  assert.equal(document.querySelector("parsererror"), null);
  return document;
}

// @test-value v2
// kind = "invariant"
// claim = "標準image nodeの空白・日本語pathをresolverへ渡し、native metadataを保った図のimageに解決済みURIを描画する"
// oracle = { type = "contract", ref = "Issue #777; docs/design/message-rich-text.md#mermaid-images" }
// fault = "pathを分割または独自構文へ変換し、nodeのlabelやedgeを失うか解決済みimageをstrict SVGへ挿入しない"
// observable = "resolver対象、生成SVGのimage hrefと読み上げlabel・edge、render sourceを実parserで読んだnative metadata"
// observation_boundary = "public-boundary"
// scope = "renderMermaidWithImagesと実Mermaid parser/renderer"
// lifecycle = "permanent"
// impact = "標準Mermaid図に添付されたローカル画像と図の関係を利用者が読めなくなる"
// distinction = "既存Markdown img testはMermaidの標準node構文とstrict sanitizerを通らない。実rendererを使う小規模な図でCI負担を限定する"
// @end-test-value
test("standard image nodes resolve Japanese paths with spaces and retain graph metadata", async () => {
  const targets: string[] = [];
  const controller = new AbortController();
  let renderSource = "";
  const observedMermaid: Mermaid = {
    ...mermaid,
    render: async (id, source, container) => {
      renderSource = source;
      return mermaid.render(id, source, container);
    },
  };
  const result = await renderMermaidWithImages(observedMermaid, "images-standard", [
    "flowchart LR",
    'A@{ img: "./図 素材/一枚.png", label: "A", w: 120, h: 70, pos: "t", constraint: "on" }',
    'B@{ img: "./図 素材/二枚.png", label: "二枚", w: 90, h: 50, pos: "b", constraint: "off" }',
    "A --> B",
  ].join("\n"), async (target) => {
    targets.push(target);
    return `blob:resolved-${targets.length}`;
  }, controller.signal);
  assert.deepEqual(targets, ["./図 素材/一枚.png", "./図 素材/二枚.png"]);
  assert.deepEqual(result.imageErrors, []);
  const document = svgDocument(result.svg);
  assert.deepEqual([...document.querySelectorAll("image")].map((image) => [image.getAttribute("href"), image.getAttribute("aria-label"), image.getAttribute("role")]), [
    ["blob:resolved-1", "A", "img"], ["blob:resolved-2", "二枚", "img"],
  ]);
  assert.equal(document.querySelector(".nodeLabel")?.textContent, "A");
  assert.match(document.documentElement.textContent ?? "", /二枚/);
  assert.equal(document.querySelectorAll("path.flowchart-link").length, 1);
  const parsed = await mermaid.mermaidAPI.getDiagramFromText(renderSource);
  const vertices = (parsed.db as { getVertices: () => Map<string, { assetWidth: number; assetHeight: number; pos: string; constraint: string }> }).getVertices();
  assert.deepEqual(["A", "B"].map((id) => {
    const vertex = vertices.get(id)!;
    return [vertex.assetWidth, vertex.assetHeight, vertex.pos, vertex.constraint];
  }), [[120, 70, "t", "on"], [90, 50, "b", "off"]]);
  assert.equal(revoked.includes("blob:resolved-1"), false);
  controller.abort();
  assert.equal(revoked.filter((url) => url === "blob:resolved-1").length, 1);
  assert.equal(revoked.filter((url) => url === "blob:resolved-2").length, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "resolver拒否・例外・画像decode失敗では対象別errorを返し図のnodeとedgeを保持する"
// oracle = { type = "contract", ref = "Issue #777; docs/design/message-rich-text.md#Image Handling" }
// fault = "一画像の失敗で図全体をrejectするか対象pathを失う"
// observable = "imageErrorsのnodeId/target/messageとSVGのedge・失敗image label"
// observation_boundary = "public-boundary"
// scope = "renderMermaidWithImagesのresource失敗と実Mermaid render"
// lifecycle = "permanent"
// impact = "認可されない画像や壊れた画像一件で利用者が残りの図まで読めなくなる"
// distinction = "Markdown resource testはMermaidの複数image nodeを含む図の継続描画を観測しない。三失敗を一図にまとめる"
// @end-test-value
test("resolution and decode failures identify each target without discarding the graph", async () => {
  const controller = new AbortController();
  const result = await renderMermaidWithImages(mermaid, "images-failed", [
    "flowchart LR", 'A@{ img: "missing.png", label: "Missing" }',
    'B@{ img: "denied.png", label: "Denied" }', 'C@{ img: "broken.png", label: "Broken" }',
    "A --> B --> C",
  ].join("\n"), async (target) => {
    if (target === "missing.png") return null;
    if (target === "denied.png") throw new Error("Root denied");
    return "blob:bad-image";
  }, controller.signal);
  assert.deepEqual(result.imageErrors.map(({ nodeId, target }) => [nodeId, target]).sort(), [
    ["A", "missing.png"], ["B", "denied.png"], ["C", "broken.png"],
  ]);
  assert.match(result.imageErrors.find(({ nodeId }) => nodeId === "B")!.message, /Root denied/);
  assert.match(result.imageErrors.find(({ nodeId }) => nodeId === "C")!.message, /decoded|loaded/);
  const document = svgDocument(result.svg);
  assert.equal(document.querySelectorAll("path.flowchart-link").length, 2);
  assert.deepEqual([...document.querySelectorAll("image")].map((image) => image.getAttribute("aria-label")), [
    "Missing (image unavailable)", "Denied (image unavailable)", "Broken (image unavailable)",
  ]);
  controller.abort();
});

// @test-value v2
// kind = "invariant"
// claim = "世代cancel後にresolverが返すowned blob URLは破棄されstale SVGを返さない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#Image Handling" }
// fault = "遅延resolver結果をcancel後もrenderしblob URLを解放しない"
// observable = "AbortErrorとrevokeObjectURLの対象・回数"
// observation_boundary = "public-boundary"
// scope = "renderMermaidWithImagesのpending resolver cancel"
// lifecycle = "permanent"
// impact = "切替前の画像を再表示し、長時間previewでblob resourceを保持する"
// distinction = "Markdown img lifecycle testはMermaid非同期render queueとresolver結果を通らない。遅延promise一件だけを使う"
// @end-test-value
test("cancellation disposes a late resolved blob and rejects stale rendering", async () => {
  const controller = new AbortController();
  let complete!: (value: string) => void;
  let started!: () => void;
  const resolving = new Promise<void>((resolve) => { started = resolve; });
  const result = renderMermaidWithImages(mermaid, "images-stale", 'flowchart TD\nA@{ img: "late.png" }', () => {
    started();
    return new Promise<string>((resolve) => { complete = resolve; });
  }, controller.signal);
  await resolving;
  controller.abort();
  complete("blob:late-result");
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(revoked.filter((url) => url === "blob:late-result").length, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "画像nodeを含む悪意あるMermaid sourceもstrict rendererのlink・HTML sanitizationを維持する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#Safety; docs/design/message-rich-text.md#Link Handling" }
// fault = "image rewriteのためsecurityLevelを緩和しscript・event handler・javascript linkが生成SVGへ残る"
// observable = "strict SVGのscript/event属性/unsafe href不在と解決image href"
// observation_boundary = "public-boundary"
// scope = "image rewriteを通る実Mermaid strict sanitizer"
// lifecycle = "permanent"
// risk_tags = ["security"]
// impact = "ユーザー提供diagramからrendererで任意コードを実行できる"
// distinction = "他のMarkdown testはMermaidのdirectiveとclick構文を評価しない。実strict render一回で安全境界を観測する"
// @end-test-value
test("image rendering retains strict sanitization of hostile source", async () => {
  const controller = new AbortController();
  const result = await renderMermaidWithImages(mermaid, "images-hostile", [
    '%%{init: {"securityLevel": "loose"}}%%', "flowchart TD",
    'A@{ img: "safe.png", label: "<span onclick=alert(1)>Image</span>" }',
    'B["<script>alert(1)</script>"]', "A --> B", 'click B "javascript:alert(1)"',
  ].join("\n"), async () => "blob:safe-image", controller.signal);
  const document = svgDocument(result.svg);
  assert.equal(document.querySelectorAll("script, [onerror], [onclick], [onload]").length, 0);
  for (const element of document.querySelectorAll("[href], [xlink\\:href]")) {
    assert.doesNotMatch(element.getAttribute("href") ?? element.getAttribute("xlink:href") ?? "", /^javascript:/i);
  }
  assert.equal(document.querySelector("image")?.getAttribute("href"), "blob:safe-image");
  controller.abort();
});
