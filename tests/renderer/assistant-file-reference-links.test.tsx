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

// @test-value v2
// kind = "contract"
// claim = "assistantの両file参照記法はpathを表示し、明示clickでだけ既存path callbackへ正確な対象を渡す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#assistant-file-references" }
// fault = "記法をリンク化できない、または表示だけでopenする、あるいはJSON escapeや属性をpathへ混入する"
// observable = "anchorのtextContent・href、onOpenPathの呼出対象とMainで解決したlocal path"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのassistant file reference表示とclick"
// lifecycle = "permanent"
// impact = "生成成果物を開けない、誤ったfileへ移動する、明示操作なしで外部動作が起こる"
// distinction = "parser単体や型検査では通常Markdown link componentへの接続と操作タイミングを観測できない"
// @end-test-value
test("assistant file references use the existing explicit link action", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const globals = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const values = [dom.window, dom.window.document, dom.window.navigator, true];
  globals.forEach((name, index) => Object.defineProperty(globalThis, name, { configurable: true, value: values[index] }));
  const root = createRoot(dom.window.document.getElementById("root")!);
  const paths = ["C:\\work\\試作 _one_ [1]%20#?.html", "C:/work/Book%20 One#?.xlsx"];
  const text = `Before visualize${JSON.stringify({ path: paths[0], mode: "wide", title: "Chart" })} after\n\n:codex-file-citation{path="${paths[1]}" artifact_kind="workbook" purpose="output" sheet="Main" range="C27"}`;
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
    assert.equal(projected, "Start [/work/chart.html] end");
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
