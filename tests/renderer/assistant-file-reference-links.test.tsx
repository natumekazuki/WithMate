import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageRichText } from "../../src/ui/markdown/MessageRichText.js";
import { createMessageRenderedSearchTextProjection, isMessageRenderedSearchTextNode } from "../../src/chat/conversation/message-rendered-search-text.js";
import { createRenderedTextSearchIndex } from "../../src/file-explorer/rendered-text-search.js";
import { projectMessageRenderedSearchText } from "../../src-shared/session/message-search.js";
import { resolveOpenPathTarget } from "../../src-electron/files/open-path.js";
import { buildMessageCollapseTargets } from "../../src/chat/conversation/session-message-collapse.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

// @test-value v2
// kind = "contract"
// claim = "同じCodex本文内のHTML/PDF visualizeは同じ外枠と形式別rendererへ分岐し、その他の参照は元targetのlinkを維持する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#assistant-file-references" }
// fault = "HTML用入口がPDFを奪う、形式間でheader操作が欠ける、未対応形式や通常linkを自動描画する、検索投影と表示labelがずれる"
// observable = "混在本文の形式別shell・title・Reload名・link target、通常anchor、DOM検索indexとSource原文"
// observation_boundary = "consumer"
// scope = "MessageRichTextの複数形式visualize分岐と共有外枠"
// lifecycle = "permanent"
// impact = "複数形式の成果物が同じ応答で閲覧できず、元fileへの操作や会話検索を誤る"
// distinction = "形式単体testとparser/型検査では、共通anchor入口による混在時の誤分岐と表示・検索の接続を確認できない。小さい静的DOMで保持コストを抑える"
// @end-test-value
test("mixed visualize formats share their frame without changing ordinary file links", () => {
  const htmlPath = "file:///C:/work/a%20chart.HTM";
  const pdfPath = "C:/work/日本語 report.PDF";
  const text = [
    `visualize${JSON.stringify({ path: htmlPath, title: "HTML Chart", mode: "wide" })}`,
    `visualize${JSON.stringify({ path: pdfPath, title: "PDF Report" })}`,
    'visualize{"path":"/work/book.xlsx"}',
    '[Ordinary HTML](/work/plain.html) [Ordinary PDF](/work/plain.pdf)',
    ':codex-file-citation{path="/work/cited.pdf"}',
  ].join("\n\n");
  const preview = new JSDOM(renderToStaticMarkup(<MessageRichText text={text} responseProvider="codex" markdownLinkFileContext={{ sessionId: "session" }} />));
  const source = new JSDOM(renderToStaticMarkup(<MessageRichText text={text} responseProvider="codex" displayMode="source" />));
  try {
    const frames = [...preview.window.document.querySelectorAll(".message-file-preview")];
    assert.deepEqual(frames.map((frame) => frame.getAttribute("data-format")), ["html", "pdf"]);
    assert.deepEqual(frames.map((frame) => frame.getAttribute("aria-label")), ["HTML Chart", "PDF Report"]);
    assert.deepEqual(frames.map((frame) => frame.querySelector("button")?.getAttribute("aria-label")), ["Reload HTML Preview", "Reload PDF Preview"]);
    const links = [...preview.window.document.querySelectorAll("a")];
    assert.deepEqual(links.map((link) => link.textContent), ["a chart.HTM", "日本語 report.PDF", "book.xlsx", "Ordinary HTML", "Ordinary PDF", "/work/cited.pdf"]);
    assert.deepEqual(links.map((link) => link.getAttribute("href")), [htmlPath, encodeURI(pdfPath), "/work/book.xlsx", "/work/plain.html", "/work/plain.pdf", "/work/cited.pdf"]);
    assert.deepEqual(links.slice(0, 2).map((link) => link.title), [htmlPath, pdfPath]);
    const index = createRenderedTextSearchIndex(preview.window.document.querySelector<HTMLElement>(".rich-text")!, isMessageRenderedSearchTextNode);
    assert.equal(index.normalizedText, projectMessageRenderedSearchText(text, "codex").toLocaleLowerCase());
    assert.equal(source.window.document.querySelector("pre")?.textContent, text);
  } finally {
    preview.window.close();
    source.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "assistantのfile citationはpathを表示し、明示clickでだけ既存path callbackへ正確な対象を渡す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#assistant-file-references" }
// fault = "記法をリンク化できない、または表示だけでopenする、あるいはJSON escapeや属性をpathへ混入する"
// observable = "anchorのtextContent・href、onOpenPathの呼出対象とMainで解決したlocal path"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのassistant file reference表示とclick"
// lifecycle = "permanent"
// impact = "生成成果物を開けない、誤ったfileへ移動する、明示操作なしで外部動作が起こる"
// distinction = "parser単体や型検査では通常Markdown link componentへの接続と操作タイミングを観測できない"
// @end-test-value
test("assistant citations use the existing explicit link action", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const globals = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const values = [dom.window, dom.window.document, dom.window.navigator, true];
  globals.forEach((name, index) => Object.defineProperty(globalThis, name, { configurable: true, value: values[index] }));
  const root = createRoot(dom.window.document.getElementById("root")!);
  const paths = ["C:\\work\\試作 _one_ [1]%20#?.html", "C:/work/Book%20 One#?.xlsx"];
  const text = `Before :codex-file-citation{path=${JSON.stringify(paths[0])}} after\n\n:codex-file-citation{path="${paths[1]}" artifact_kind="workbook" purpose="output" sheet="Main" range="C27"}`;
  const opened: string[] = [];
  try {
    await act(async () => root.render(<MessageRichText text={text} responseProvider="codex" onOpenPath={(path) => opened.push(path)} />));
    const links = [...dom.window.document.querySelectorAll("a")];
    assert.deepEqual(links.map((link) => link.textContent), paths);
    assert.deepEqual(links.map((link) => decodeURIComponent(link.getAttribute("href")!)), paths);
    assert.deepEqual(opened, []);
    await act(async () => links.forEach((link) => link.click()));
    assert.deepEqual(opened.map(decodeURIComponent), paths);
    assert.deepEqual(opened.map((target) => resolveOpenPathTarget(target)), paths.map((targetPath) => ({ type: "local-path", targetPath })));
  } finally {
    await act(async () => root.unmount());
    globals.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Codex固有参照のPreviewと検索は一致し、他provider・通常用途・Sourceは固有解析を適用しない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#assistant-file-references" }
// fault = "表示と検索が異なる構文を選ぶ、他providerやuserの本文をCodex構文として誤変換する、Sourceから元情報を失う"
// observable = "Preview DOM index・検索投影・collapse summary・SourceのtextContent・通常用途のanchor数"
// observation_boundary = "consumer"
// scope = "assistant file referenceの表示・検索・原文境界"
// lifecycle = "permanent"
// impact = "検索位置がずれたり他providerの本文の意味を変える。元応答を参照できなくなる"
// distinction = "型検査はprovider値による動的な解析選択を検証できない。短い入力で表示・検索・Sourceの公開consumerを比較するため継続負担が小さい"
// @end-test-value
test("assistant reference search matches preview while source and ordinary Markdown retain the notation", () => {
  const text = 'Start [visualize{"path":"/work/chart.html","title":"Hidden Title"}] end';
  const preview = new JSDOM(renderToStaticMarkup(<MessageRichText text={text} responseProvider="codex" />));
  const source = new JSDOM(renderToStaticMarkup(<MessageRichText text={text} responseProvider="codex" displayMode="source" />));
  const ordinary = new JSDOM(renderToStaticMarkup(<MessageRichText text={text} />));
  try {
    const projected = projectMessageRenderedSearchText(text, "codex");
    const index = createRenderedTextSearchIndex(preview.window.document.querySelector<HTMLElement>(".rich-text")!, isMessageRenderedSearchTextNode);
    assert.equal(projected, "Start [chart.html] end");
    assert.equal(index.normalizedText, projected.toLocaleLowerCase());
    assert.equal(source.window.document.querySelector("pre")?.textContent, text);
    assert.equal(source.window.document.querySelector("a"), null);
    assert.equal(ordinary.window.document.querySelector("a"), null);
    assert.equal(projectMessageRenderedSearchText(text), ordinary.window.document.querySelector(".rich-text")?.textContent);

    const project = createMessageRenderedSearchTextProjection("codex");
    assert.deepEqual(project([{ role: "assistant", text }, { role: "user", text }], ["a", "u"], "preview", true), [projected, projectMessageRenderedSearchText(text)]);
    assert.deepEqual(project([{ role: "assistant", text }, { role: "user", text }], ["a", "u"], "source", true), [text, text]);
    assert.deepEqual(project([{ role: "user", text }], ["a"], "preview", true), [projectMessageRenderedSearchText(text)]);
    const messages = [{ role: "assistant" as const, text }, { role: "user" as const, text }];
    const sources = [{ kind: "session" as const, messageIndex: 0 }, { kind: "auxiliary" as const, sessionId: "aux", messageIndex: 1, artifact: undefined }];
    let summaries = buildMessageCollapseTargets(messages, sources, ["a", "u"], [], "codex");
    assert.deepEqual(summaries.map((entry) => entry.preview), [projected, text]);
    for (const provider of ["claude", "copilot", "unknown", undefined]) {
      const html = new JSDOM(renderToStaticMarkup(<MessageRichText text={text} responseProvider={provider} />));
      try {
        assert.equal(html.window.document.querySelector("a"), null);
        assert.equal(html.window.document.querySelector(".rich-text")?.textContent, text);
        assert.equal(projectMessageRenderedSearchText(text, provider), text);
        assert.deepEqual(createMessageRenderedSearchTextProjection(provider)([{ role: "assistant", text }], ["a"], "preview", true), [text]);
        summaries = buildMessageCollapseTargets(messages, sources, ["a", "u"], summaries, provider);
        assert.deepEqual(summaries.map((entry) => entry.preview), [text, text]);
      } finally {
        html.window.close();
      }
    }
    assert.deepEqual(buildMessageCollapseTargets(messages, sources, ["a", "u"], summaries, "codex").map((entry) => entry.preview), [projected, text]);
  } finally {
    preview.window.close();
    source.window.close();
    ordinary.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Codex visualizeはHTMLを共通previewへ渡し、file名linkで元pathを開け、Reloadのbusyと失敗回復を持ち、stream追記で再読込しない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#assistant-file-references" }
// fault = "本文追記で読込をやり直す、失敗を通常linkとして隠す、またはtoolbar・errorが本文検索へ混入する"
// observable = "readSessionHtmlPreviewのrequest数と対象、file名labelと完全pathのtooltip・accessible name、Reloadのdisabled・busy・spinner、loading/error・共通preview、click結果と検索index"
// observation_boundary = "component-behavior"
// scope = "Codex HTML preview entryとsession readの接続・再試行"
// lifecycle = "permanent"
// impact = "HTML成果物が会話で利用できず、読込失敗時の回復やpath参照も失う"
// distinction = "parserや型検査はReact lifecycleとread request、表示・検索の一致を検証できない。短いcomponent testでIPC以降をmockする"
// @end-test-value
test("visualize preview preserves its session read across streaming and exposes failure recovery", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const globals = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT", "IntersectionObserver"] as const;
  const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const values = [dom.window, dom.window.document, dom.window.navigator, true, class {
    observe() {}
    disconnect() {}
  }];
  globals.forEach((name, index) => Object.defineProperty(globalThis, name, { configurable: true, value: values[index] }));
  const requests: unknown[] = [];
  let rejectRead: (error: Error) => void = () => {};
  let resolveRead: (result: { html: string; fileName: string }) => void = () => {};
  dom.window.withmate = {
    readSessionHtmlPreview: (request: unknown) => {
      requests.push(request);
      return new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });
    },
  } as unknown as WithMateWindowApi;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const text = 'Start visualize{"path":"/work/chart.html","title":"Chart","mode":"wide"} end';
  const context = { sessionId: "session" };
  const opened: string[] = [];
  const render = (body: string) => root.render(<MessageRichText text={body} responseProvider="codex" markdownLinkFileContext={context} onOpenPath={(path) => opened.push(path)} />);
  try {
    await act(async () => render(text));
    assert.deepEqual(requests, [{ sessionId: "session", target: "/work/chart.html" }]);
    assert.ok(dom.window.document.querySelector('[aria-label="Loading HTML preview"]'));
    const fileLink = dom.window.document.querySelector<HTMLAnchorElement>("a")!;
    assert.equal(fileLink.textContent, "chart.html");
    assert.equal(fileLink.title, "/work/chart.html");
    assert.equal(fileLink.getAttribute("aria-label"), "Open /work/chart.html");
    const reload = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Reload HTML Preview"]')!;
    assert.equal(reload.disabled, true);
    assert.equal(reload.title, "Reload HTML Preview");
    assert.equal(reload.getAttribute("aria-busy"), "true");
    const shell = dom.window.document.querySelector('.message-file-preview[data-format="html"]');
    await act(async () => render(`${text}\n\nMore text`));
    assert.equal(dom.window.document.querySelector('.message-file-preview[data-format="html"]'), shell);
    assert.equal(requests.length, 1);
    await act(async () => rejectRead(new Error("HTML access denied.")));
    assert.equal(dom.window.document.querySelector('[role="alert"]')?.textContent, "HTML access denied.");
    assert.equal(dom.window.document.querySelector("p div"), null);
    const index = createRenderedTextSearchIndex(dom.window.document.querySelector<HTMLElement>(".rich-text")!, isMessageRenderedSearchTextNode);
    assert.equal(index.normalizedText, projectMessageRenderedSearchText(`${text}\n\nMore text`, "codex").toLocaleLowerCase());
    await act(async () => dom.window.document.querySelector<HTMLAnchorElement>("a")!.click());
    assert.deepEqual(opened, ["/work/chart.html"]);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>("button")!.click());
    assert.equal(requests.length, 2);
    assert.equal(reload.disabled, true);
    assert.equal(reload.getAttribute("aria-busy"), "true");
    assert.ok(reload.querySelector(".button-content-spinner"));
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
    await act(async () => resolveRead({ html: "<!doctype html><h1>Chart content</h1>", fileName: "chart.html" }));
    assert.ok(dom.window.document.querySelector('.html-preview[aria-label="Chart"]'));
    assert.equal(reload.disabled, false);
    assert.equal(reload.getAttribute("aria-busy"), null);
    assert.equal(reload.querySelector(".button-content-spinner"), null);
    assert.equal(dom.window.document.querySelector("h1"), null);
    assert.equal(dom.window.document.querySelector('.message-file-preview[data-format="html"]'), shell);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>("button")!.click());
    assert.equal(requests.length, 3);
    await act(async () => render('visualize{"path":"/work/book.xlsx"}'));
    assert.equal(dom.window.document.querySelector("a")?.textContent, "book.xlsx");
    assert.equal(dom.window.document.querySelector("a")?.getAttribute("href"), "/work/book.xlsx");
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
    assert.equal(requests.length, 3);
    await act(async () => rejectRead(new Error("Stale read error.")));
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => root.unmount());
    globals.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
    dom.window.close();
  }
});
