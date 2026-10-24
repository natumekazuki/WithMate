import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { SessionGraphRecord } from "../../src-shared/session-graph/session-graph-contract.js";
import { layoutSessionGraph } from "../../src/session-graph/graph-layout.js";
import { sessionGraphStatuses } from "../../src/session-graph/SessionGraphPreview.js";
import { SessionGraphPreview } from "../../src/session-graph/SessionGraphPreview.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { MessageRichText } from "../../src/ui/markdown/MessageRichText.js";

function record(id: string): SessionGraphRecord {
  return {
    id,
    topicId: "topic",
    title: id,
    kind: "decision",
    detail: "",
    scope: "",
    references: [],
    actor: { label: "User" },
    recordedBy: { sessionId: "main", sessionTitle: "Main", role: "main" },
    createdAt: "2026-10-24T00:00:00Z",
    updatedAt: "2026-10-24T00:00:00Z",
  };
}

// @test-value v2
// kind = "invariant"
// claim = "任意の循環・分離した記録も有限の重ならない可読位置へ配置される"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "循環で配置が停止するか分離記録を落とすかノードを同じ位置へ置く"
// observable = "全入力記録の位置、有限なcanvas寸法、ノード矩形の交差"
// observation_boundary = "consumer"
// scope = "session-graph-layout"
// lifecycle = "permanent"
// @end-test-value
test("graph layout retains cyclic and disconnected records at readable nonoverlapping positions", () => {
  const records = [
    record("alpha"),
    record("beta"),
    record("gamma"),
    record("isolated"),
  ];
  const layout = layoutSessionGraph(records, [
    { id: "ab", fromId: "alpha", toId: "beta", kind: "supports" },
    { id: "bc", fromId: "beta", toId: "gamma", kind: "depends_on" },
    { id: "ca", fromId: "gamma", toId: "alpha", kind: "related" },
    { id: "outside", fromId: "isolated", toId: "external", kind: "related" },
  ]);
  assert.equal(layout.positions.size, records.length);
  assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
  const positions = [...layout.positions.values()];
  for (let index = 0; index < positions.length; index += 1) {
    const point = positions[index];
    assert.ok(
      point.x >= 0 &&
        point.y >= 0 &&
        point.x + 240 <= layout.width &&
        point.y + 150 <= layout.height,
    );
    for (const other of positions.slice(index + 1))
      assert.ok(
        Math.abs(point.x - other.x) >= 240 ||
        Math.abs(point.y - other.y) >= 150,
      );
  }
});

// @test-value v2
// kind = "invariant"
// claim = "採用・作業・確認・論点・有効性は別の状態として保持される"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "置換済みの採用判断や完了作業に併存する失敗と未解決を単一状態へ潰す"
// observable = "詳細とノードに渡す状態label集合"
// observation_boundary = "consumer"
// scope = "session-graph-status"
// lifecycle = "permanent"
// @end-test-value
test("status presentation keeps acceptance and supersession as well as completion and unresolved results", () => {
  assert.deepEqual(
    sessionGraphStatuses({
      ...record("decision"),
      adoption: "accepted",
      validity: "superseded",
    }),
    ["accepted", "superseded"],
  );
  assert.deepEqual(
    sessionGraphStatuses({
      ...record("activity"),
      progress: "completed",
      result: "failed",
      resolution: "open",
    }),
    ["completed", "failed", "unresolved"],
  );
  assert.deepEqual(
    sessionGraphStatuses({ ...record("observation"), result: "not_run" }),
    ["not_run"],
  );
});

// @test-value v2
// kind = "invariant"
// claim = "Graph本文の画像とMermaidは自動取得せずテキストとして表示し、明示リンクは安全なrendererへ残る"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "Graph本文のMarkdown画像やMermaid画像の埋込が閲覧時に外部またはlocal資源を自動取得する"
// observable = "HTMLの画像埋込とMermaid surfaceの不在、画像代替文字、code本文、明示リンク"
// observation_boundary = "component-behavior"
// scope = "graph-markdown-media-policy"
// lifecycle = "permanent"
// impact = "信頼しない記録本文の閲覧だけで追跡URLやlocal画像が取得される"
// distinction = "型やschemaは有効な画像Markdownを許すため、rendererの自動取得境界はbuildでは検出できない。小さいSSR testで継続検査する"
// @end-test-value
test("graph detail markdown represents embedded media as text while keeping deliberate links", () => {
  const html = renderToStaticMarkup(
    <MessageRichText
      embeddedMedia="text"
      text={
        '![Private Image](https://example.invalid/private.png)\n\n```mermaid\nflowchart TD\nA@{ img: "https://example.invalid/track.png" }\n```\n\n[Open Evidence](https://example.invalid/evidence)'
      }
    />,
  );
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector("img"), null);
  assert.equal(document.querySelector(".mermaid-viewport"), null);
  assert.match(document.body.textContent ?? "", /\[Image: Private Image\]/);
  assert.match(
    document.querySelector("pre")?.textContent ?? "",
    /https:\/\/example.invalid\/track.png/,
  );
  assert.equal(
    document.querySelector("a")?.getAttribute("href"),
    "https://example.invalid/evidence",
  );
});

// @test-value v2
// kind = "contract"
// claim = "Graphの選択詳細と自由値を保持して通知更新でき、関係から別話題へ移動できる"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "通知で詳細選択と読む位置を失うかfalse値を落とすか跨話題の関係を開けない"
// observable = "選択された詳細本文、scrollTop、自由項目、参照open引数、遷移先話題と詳細"
// observation_boundary = "component-behavior"
// scope = "session-graph-preview-navigation"
// lifecycle = "permanent"
// @end-test-value
test("graph preview preserves selection on notifications and navigates cross-topic references", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "http://localhost",
  });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const previousAct = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let notify: (id: string) => void = () => {};
  let revision = 1;
  const opened: string[] = [];
  const relation = {
    id: "cross",
    fromId: "alpha",
    toId: "cross-topic",
    kind: "supports" as const,
    label: "Evidence",
  };
  const alpha = () => ({
    ...record("alpha"),
    title: "Shared Decision",
    detail: `Decision At Revision ${revision}`,
    adoption: "accepted" as const,
    fields: {
      zero: 0,
      disabled: false,
      nothing: null,
      empty: "",
      structure: { count: 3 },
    },
    references: [
      {
        role: "evidence" as const,
        label: "Open Evidence",
        href: "evidence.md",
      },
    ],
  });
  const other = {
    ...record("cross-topic"),
    topicId: "other",
    title: "Other Topic Observation",
    detail: "Cross Topic Detail",
  };
  const api: Pick<
    WithMateWindowApi,
    "readSessionGraph" | "subscribeSessionGraph"
  > = {
    readSessionGraph: (async (
      _sessionId: string,
      operation: string,
      request: { ids?: string[]; topicId?: string },
    ) => {
      if (operation === "list_topics")
        return {
          status: "ok",
          revision,
          items: [
            { id: "topic", title: "Decisions" },
            { id: "other", title: "Evidence" },
          ],
          total: 2,
          offset: 0,
          hasMore: false,
          incomplete: false,
        };
      const selected =
        operation === "get"
          ? request.ids?.[0]
          : request.topicId === "other"
            ? "cross-topic"
            : "alpha";
      return {
        status: "ok",
        revision,
        items: [selected === "cross-topic" ? other : alpha()],
        total: 1,
        offset: 0,
        hasMore: false,
        incomplete: false,
        relations: [relation],
        externalEndpoints: [other],
      };
    }) as WithMateWindowApi["readSessionGraph"],
    subscribeSessionGraph: (listener) => {
      notify = listener;
      return () => {
        notify = () => {};
      };
    },
  };
  const click = async (element: Element | null) => {
    assert.ok(element);
    await act(async () => {
      element.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
  };
  try {
    await act(async () => {
      root.render(
        <SessionGraphPreview
          api={api}
          sessionId="main"
          onClose={() => {}}
          onOpenPath={(target) => opened.push(target)}
        />,
      );
    });
    await click(dom.window.document.querySelector(".session-graph-node"));
    const details = dom.window.document.querySelector<HTMLElement>(
      ".session-graph-details",
    )!;
    assert.match(details.textContent ?? "", /Decision At Revision 1/);
    assert.deepEqual(
      Array.from(
        details.querySelectorAll(".session-graph-fields pre"),
        (element) => element.textContent,
      ),
      ["0", "false", "null", '""', '{\n  "count": 3\n}'],
    );
    details.scrollTop = 77;
    revision = 2;
    await act(async () => {
      notify("main");
    });
    assert.equal(
      dom.window.document.querySelector(".session-graph-details"),
      details,
    );
    assert.equal(details.scrollTop, 77);
    assert.match(details.textContent ?? "", /Decision At Revision 2/);
    await click(details.querySelector(".session-graph-references button"));
    assert.deepEqual(opened, ["evidence.md"]);
    await click(details.querySelector(".session-graph-related button"));
    assert.equal(
      dom.window.document.querySelector<HTMLSelectElement>(
        "select[aria-label='Graph Topic']",
      )?.value,
      "other",
    );
    assert.match(
      dom.window.document.querySelector(".session-graph-details")
        ?.textContent ?? "",
      /Cross Topic Detail/,
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of [
      ["window", previousWindow],
      ["document", previousDocument],
      ["IS_REACT_ACT_ENVIRONMENT", previousAct],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
