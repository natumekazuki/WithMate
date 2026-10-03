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
  // JSDOM does not load HTML label images; their browser lifecycle is checked
  // by the visual fixture. Keep Mermaid's own label/layout code running here.
  Object.defineProperty(dom.window.HTMLImageElement.prototype, "complete", { get: () => true });
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
  // The preview consumes Mermaid's SVG with HTML foreignObject labels as HTML.
  const document = new dom.window.DOMParser().parseFromString(svg, "text/html");
  assert.equal(document.body.firstElementChild?.localName, "svg");
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
// claim = "画像nodeを含む図でもsubgraph・HTML改行label・相対click linkを保ったSVGを返す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#Mermaid Images; docs/design/message-rich-text.md#Link Handling" }
// fault = "Mermaidが出力するHTML改行をXMLとして拒否し、画像と通常label・linkを含む図全体が表示不能になる"
// observable = "生成SVGの画像URI・subgraph・改行要素・label文字列・相対link URIと名前空間"
// observation_boundary = "public-boundary"
// scope = "renderMermaidWithImagesと実Mermaid strict rendererのHTML label出力"
// lifecycle = "permanent"
// impact = "画像付きの説明図で一般的な複数行labelとfile linkを併用できなくなる"
// distinction = "既存の画像testは単一行labelと画像のみ、link viewport testは生成済みSVGが入力。実render一件で画像とHTML label・linkの共存を検証する"
// @end-test-value
test("image diagrams preserve subgraphs, HTML line breaks and relative links", async () => {
  const controller = new AbortController();
  try {
    const result = await renderMermaidWithImages(mermaid, "images-html-label", [
      "flowchart TB",
      'subgraph GROUP[" "]',
      'A@{ img: "./icon.png", label: "入力画像", h: 64, constraint: "on" }',
      'B["仕様<br/>確認 &amp; 実装&nbsp;完了"]',
      "A --> B",
      "end",
      'click B "./details.md" "詳細"',
    ].join("\n"), async () => "blob:html-label-image", controller.signal);
    assert.deepEqual(result.imageErrors, []);
    const document = svgDocument(result.svg);
    assert.equal(document.querySelector("svg")?.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(document.querySelectorAll(".cluster").length, 1);
    assert.equal(document.querySelector("image")?.getAttribute("href"), "blob:html-label-image");
    assert.equal(document.querySelector("image")?.getAttribute("aria-label"), "入力画像");
    assert.equal(document.querySelector("foreignObject br")?.namespaceURI, "http://www.w3.org/1999/xhtml");
    assert.match(document.documentElement.textContent ?? "", /仕様確認 & 実装\u00a0完了/);
    const anchor = document.querySelector("a");
    assert.equal(anchor?.getAttribute("href") ?? anchor?.getAttribute("xlink:href"), "./details.md");
    assert.equal(document.querySelectorAll("path.flowchart-link").length, 1);
  } finally {
    controller.abort();
  }
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
// claim = "flowchartのnode・edge・subgraph内HTML画像を共通resolverで解決し寸法・alt・図の関係を保つ"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#Mermaid Images" }
// fault = "strictでlocal srcが失われるか、HTML属性の引用符とentityを誤解釈し図や画像寸法を壊す"
// observable = "resolver対象path、imgのsrc・寸法・accessible name、subgraph・edgeと標準画像の存在"
// observation_boundary = "public-boundary"
// scope = "renderMermaidWithImagesと実Mermaid strict parser/renderer"
// lifecycle = "permanent"
// impact = "枠見出しやnode内の画像を使った図を読めなくなる"
// distinction = "標準image node testはHTMLの属性とsubgraph titleを通らない。混在一図で三種のlabelと標準nodeの共存を確認する"
// @end-test-value
test("HTML label images share resolution and retain dimensions and graph relationships", async () => {
  const controller = new AbortController();
  const targets: string[] = [];
  try {
    const result = await renderMermaidWithImages(mermaid, "html-images", [
      "flowchart TB",
      `subgraph GROUP["<div style='width:200px;height:64px'><img src='file:///C:/図 素材/a&amp;b.png' width='64' alt='枠画像'/></div>"]`,
      `A["<img src="C:/図 素材/node.png" height="45" alt="node画像">説明<br/>続き"]`,
      'B@{ img: "./native.png", label: "標準画像" }',
      `A -->|"<img src='./edge.png' alt='接続画像'>"| B`,
      "end",
      `%% <img src='comment.png'>`,
    ].join("\n"), async (target) => { targets.push(target); return `blob:html-${targets.length}`; }, controller.signal);
    assert.deepEqual(targets.slice().sort(), ["file:///C:/図 素材/a&b.png", "C:/図 素材/node.png", "./edge.png", "./native.png"].sort());
    assert.deepEqual(result.imageErrors, []);
    const document = svgDocument(result.svg);
    const images = [...document.querySelectorAll("img")];
    assert.equal(images.length, 3);
    const byAlt = (alt: string) => images.find((image) => image.getAttribute("alt") === alt)!;
    assert.deepEqual([byAlt("枠画像").getAttribute("width"), byAlt("枠画像").getAttribute("height")], ["64", "36"]);
    assert.deepEqual([byAlt("node画像").getAttribute("width"), byAlt("node画像").getAttribute("height")], ["80", "45"]);
    assert.deepEqual([byAlt("接続画像").getAttribute("width"), byAlt("接続画像").getAttribute("height")], ["320", "180"]);
    for (const image of images) {
      assert.match(image.getAttribute("src") ?? "", /^blob:html-/);
      assert.equal(image.getAttribute("aria-label"), image.getAttribute("alt"));
      assert.equal(image.style.objectFit, "contain");
    }
    assert.match(document.querySelector("image")?.getAttribute("href") ?? "", /^blob:html-/);
    assert.equal(document.querySelectorAll(".cluster").length, 1);
    assert.equal(document.querySelectorAll("path.flowchart-link").length, 1);
    assert.match(document.documentElement.textContent ?? "", /説明続き/);
  } finally {
    controller.abort();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "HTML画像失敗は所有labelと対象を示して図を保ち、strictのscript・event除去とsrc専用の読込境界を維持する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#Mermaid Images; docs/design/message-rich-text.md#Safety" }
// fault = "HTML画像の復元でunsafe属性やsrcsetを戻す、または一画像の失敗で図を破棄する"
// observable = "失敗のowner/target、placeholder・正常画像src、script/event/srcsetの不在とedge"
// observation_boundary = "public-boundary"
// scope = "HTML img前処理・共通resolver・strict SVG後処理"
// lifecycle = "permanent"
// risk_tags = ["security"]
// impact = "図から任意コード実行や共通画像制限の迂回が可能になるか、残りの内容まで表示不能になる"
// distinction = "標準nodeの安全性testはHTML imgのsrcをstrict後に復元しない。二画像一図で成功・失敗と安全境界を観測する"
// @end-test-value
test("HTML image failures retain the graph without restoring unsafe attributes", async () => {
  const controller = new AbortController();
  try {
    const result = await renderMermaidWithImages(mermaid, "html-images-hostile", [
      '%%{init: {"securityLevel": "loose"}}%%', "flowchart LR",
      `A["<img src='javascript:alert(1)' onerror='alert(1)' srcset='file:///secret.png 2x' alt='失敗'>"]`,
      `B["<img src='./good.png' onload='alert(1)' alt='正常'><img srcset='https://example.invalid/alternate.png 2x' alt='srcなし'><script>alert(1)</script>"]`,
      "A --> B", 'click B "javascript:alert(1)"',
    ].join("\n"), async (target) => target === "./good.png" ? "blob:html-good" : null, controller.signal);
    assert.deepEqual(result.imageErrors.map(({ nodeId, target }) => [nodeId, target]), [["A", "javascript:alert(1)"]]);
    const document = svgDocument(result.svg);
    assert.equal(document.querySelectorAll("script, [onerror], [onload], [srcset]").length, 0);
    assert.match(document.querySelector('img[alt="失敗"]')?.getAttribute("src") ?? "", /^data:image\/svg\+xml,/);
    assert.equal(document.querySelector('img[alt="失敗"]')?.getAttribute("aria-label"), "失敗 (image unavailable)");
    assert.equal(document.querySelector('img[alt="正常"]')?.getAttribute("src"), "blob:html-good");
    assert.equal(document.querySelectorAll("path.flowchart-link").length, 1);
    for (const element of document.querySelectorAll("[href], [xlink\\:href]")) {
      assert.doesNotMatch(element.getAttribute("href") ?? element.getAttribute("xlink:href") ?? "", /^javascript:/i);
    }
  } finally {
    controller.abort();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "HTML画像の遅延resolver結果はcancel後に解放されstaleな図を返さない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#Image Handling" }
// fault = "HTML画像の独立した前処理がabortを無視して旧画像を表示するかblobを保持する"
// observable = "AbortErrorとlate blob URLの解放回数"
// observation_boundary = "public-boundary"
// scope = "renderMermaidWithImagesのHTML画像pending cancel"
// lifecycle = "permanent"
// impact = "Source切替やclose後も旧画像の読込と保持が継続する"
// distinction = "標準nodeのcancel testとは別のHTML前処理経路を遅延promise一件で確認する"
// @end-test-value
test("HTML image cancellation disposes a late resource without returning a stale diagram", async () => {
  const controller = new AbortController();
  let complete!: (value: string) => void;
  let started!: () => void;
  const resolving = new Promise<void>((resolve) => { started = resolve; });
  const result = renderMermaidWithImages(mermaid, "html-images-stale", `flowchart TD\nA["<img src='late.png'>"]`, () => {
    started();
    return new Promise<string>((resolve) => { complete = resolve; });
  }, controller.signal);
  await resolving;
  controller.abort();
  complete("blob:html-late-result");
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(revoked.filter((url) => url === "blob:html-late-result").length, 1);
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
