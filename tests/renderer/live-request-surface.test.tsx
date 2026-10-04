import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { LiveApprovalRequest, LiveElicitationRequest } from "../../src-shared/session/runtime-state.js";
import { LiveRequestSurface } from "../../src/chat/runtime/live-request-surface.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mountElicitation(request: LiveElicitationRequest) {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { pretendToBeVisual: true });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousEvent = globalThis.Event;
  const previousMouseEvent = globalThis.MouseEvent;
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  const container = dom.window.document.getElementById("root")!;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  const responses: unknown[] = [];
  const render = async (nextRequest: LiveElicitationRequest) => {
    await act(async () => root.render(React.createElement(LiveRequestSurface, {
      liveApprovalRequest: null,
      approvalActionRequestId: null,
      liveElicitationRequest: nextRequest,
      elicitationActionRequestId: null,
      onResolveLiveApproval() {},
      onResolveLiveElicitation(_request, response) { responses.push(response); },
    })));
  };
  await render(request);
  return {
    container, dom, responses, render,
    async cleanup() {
      await act(async () => root.unmount());
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.HTMLElement = previousHTMLElement;
      globalThis.Node = previousNode;
      globalThis.Event = previousEvent;
      globalThis.MouseEvent = previousMouseEvent;
      dom.window.close();
    },
  };
}

async function enterText(dom: JSDOM, input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

async function submit(container: HTMLElement) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === "Submit");
  assert.ok(button);
  await act(async () => button.click());
}

const approvalRequest: LiveApprovalRequest = {
  requestId: "approval-1",
  provider: "codex",
  kind: "shell",
  title: "Run a command",
  summary: "npm test",
  details: "The command will inspect the workspace.",
  warning: "This command can change workspace state.",
  decisionMode: "direct-decision",
};

// @test-value v2
// kind = "contract"
// claim = "secret指定の入力質問は長文でもpassword inputにし、回答内容を既存formで送信する。nonblocking質問を必須待ちと表示しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Provider入力質問のsecret textとpassword input" }
// fault = "secretをtextareaや平文inputで表示する、回答payloadを変える、またはnonblocking質問をInput Requiredと表示する"
// observable = "password inputのtype、質問badge、Submit後の回答payload"
// observation_boundary = "component-behavior"
// scope = "live-elicitation-secret-text"
// lifecycle = "permanent"
// impact = "画面上に秘匿回答が露出し、実行が止まっていない質問を必須待ちと誤認する"
// distinction = "schemaと型はDOM入力typeと長文分岐のマスクや実Submit payloadを保証できない"
// @end-test-value
test("LiveRequestSurfaceはsecret回答をmaskしnonblocking質問を区別する", async () => {
  const mounted = await mountElicitation({
    requestId: "secret-question", provider: "codex", mode: "form", blocking: false, message: "Enter private answer",
    fields: [{ type: "text", name: "answer", title: "Private answer", required: true, secret: true, maxLength: 500 }],
  });
  try {
    const input = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Private answer"]');
    assert.ok(input);
    assert.equal(input.type, "password");
    assert.match(mounted.container.textContent ?? "", /Input Requested/);
    await enterText(mounted.dom, input, "private-answer");
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { answer: "private-answer" } }]);
  } finally { await mounted.cleanup(); }
});

const elicitationRequest: LiveElicitationRequest = {
  requestId: "input-1",
  provider: "codex",
  mode: "form",
  message: "Choose a branch",
  fields: [{
    name: "branch",
    title: "Branch",
    type: "text",
    required: true,
  }],
};

// @test-value v2
// kind = "contract"
// claim = "Live approvalとinput requestは解決中に対象領域のbusy stateと既存spinnerを示し、要求内容と操作識別を維持する"
// oracle = { type = "contract", ref = "src/chat/runtime/live-request-surface.tsx" }
// fault = "解決中のrequestがdisabled操作だけになり、処理中であることを支援技術へ伝えられないか、request本文・操作labelを失う"
// observable = "request領域のaria-busy、settings-action-spinnerのstatus、request本文、warning/details、approval/input操作label"
// observation_boundary = "component-behavior"
// scope = "live-request-resolution-feedback"
// lifecycle = "permanent"
// impact = "承認・入力回答の送信中に再操作や待機状態を誤認し、安全判断に必要な要求内容を見失う"
// distinction = "disabled属性の有無だけでなく、busy announcementが一つだけ存在し、要求内容と操作識別が同時に残ることを確認する"
// @end-test-value
test("LiveRequestSurface はapproval解決中のbusy announcementと要求内容を保つ", () => {
  const html = renderToStaticMarkup(React.createElement(LiveRequestSurface, {
    liveApprovalRequest: approvalRequest,
    approvalActionRequestId: approvalRequest.requestId,
    liveElicitationRequest: null,
    elicitationActionRequestId: null,
    onResolveLiveApproval() {},
    onResolveLiveElicitation() {},
  }));

  assert.match(html, /class="live-approval-card"[^>]*aria-busy="true"/);
  assert.match(html, /role="status" aria-label="Processing approval request"/);
  assert.equal((html.match(/class="settings-action-spinner"/g) ?? []).length, 1);
  assert.match(html, /Run a command/);
  assert.match(html, /npm test/);
  assert.match(html, /This command can change workspace state\./);
  assert.match(html, />Allow Once<\/button>/);
  assert.match(html, />Reject<\/button>/);
});

// @test-value v2
// kind = "contract"
// claim = "Live input requestは解決中に対象領域のbusy stateと既存spinnerを示し、要求内容と操作識別を維持する"
// oracle = { type = "contract", ref = "src/chat/runtime/live-request-surface.tsx" }
// fault = "解決中のinput requestがdisabled操作だけになり、処理中であることを支援技術へ伝えられないか、request本文・操作labelを失う"
// observable = "input request領域のaria-busy、settings-action-spinnerのstatus、request本文、input操作label"
// observation_boundary = "component-behavior"
// scope = "live-input-request-resolution-feedback"
// lifecycle = "permanent"
// impact = "入力回答の送信中に再操作や待機状態を誤認し、要求内容を見失う"
// distinction = "disabled属性の有無だけでなく、busy announcementが一つだけ存在し、要求内容と操作識別が同時に残ることを確認する"
// @end-test-value
test("LiveRequestSurface はinput解決中のbusy announcementと操作labelを保つ", () => {
  const html = renderToStaticMarkup(React.createElement(LiveRequestSurface, {
    liveApprovalRequest: null,
    approvalActionRequestId: null,
    liveElicitationRequest: elicitationRequest,
    elicitationActionRequestId: elicitationRequest.requestId,
    onResolveLiveApproval() {},
    onResolveLiveElicitation() {},
  }));

  assert.match(html, /class="live-elicitation-card"[^>]*aria-busy="true"/);
  assert.match(html, /role="status" aria-label="Processing input request"/);
  assert.equal((html.match(/class="settings-action-spinner"/g) ?? []).length, 1);
  assert.match(html, /Choose a branch/);
  assert.match(html, />Submit<\/button>/);
  assert.match(html, />Reject<\/button>/);
  assert.match(html, />Close<\/button>/);
});

// @test-value v2
// kind = "contract"
// claim = "自由入力を許す単一選択は候補を残しつつ空の必須回答を拒否し、候補外の回答を文字列で送れる"
// oracle = { type = "contract", ref = "Claude AskUserQuestion required free-text answer contract" }
// fault = "候補が初期選択されたように見える、自由入力を拒否する、または空白を必須回答として送る"
// observable = "候補付き入力の初期値・候補、validation、送信payload"
// observation_boundary = "component-behavior"
// scope = "live-elicitation-free-text-select"
// lifecycle = "permanent"
// impact = "利用者の意図しない候補が回答されるか、Claudeへの必須回答を自由に入力できない"
// distinction = "型検査・静的markupだけでは入力後のvalidationとpayloadを確認できない"
// @end-test-value
test("LiveRequestSurface は自由入力の単一選択を候補付きで回答する", async () => {
  const request: LiveElicitationRequest = {
    requestId: "single-free", provider: "claude", mode: "form", message: "Choose direction",
    fields: [{ type: "select", name: "direction", title: "Direction", required: true, allowFreeText: true,
      options: [{ value: "north", label: "North" }] }],
  };
  const mounted = await mountElicitation(request);
  try {
    const input = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Direction"]');
    assert.ok(input);
    assert.equal(input.value, "");
    assert.equal(mounted.container.querySelector('datalist option[value="north"]')?.getAttribute("label"), "North");
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, []);
    assert.match(mounted.container.textContent ?? "", /Enter Direction\./);
    await enterText(mounted.dom, input, "  ");
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, []);
    await enterText(mounted.dom, input, "northeast");
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { direction: "northeast" } }]);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "自由入力を許す複数選択は選択肢だけ・自由入力だけ・双方を同じstring[] payloadで回答でき、空の必須回答を拒否する"
// oracle = { type = "contract", ref = "Claude AskUserQuestion required free-text answer contract" }
// fault = "自由入力のために既存選択肢を選ぶ必要がある、選択した候補を失う、または空回答を送る"
// observable = "checkboxとOther入力のDOM操作、validation、送信payload"
// observation_boundary = "component-behavior"
// scope = "live-elicitation-free-text-multi-select"
// lifecycle = "permanent"
// impact = "利用者の意図した複数回答をClaudeへ伝えられない"
// distinction = "単一選択の検査は選択肢と自由入力の結合や複数選択の必須判定を扱わない"
// @end-test-value
test("LiveRequestSurface は自由入力の複数選択を候補と併用できる", async () => {
  const request: LiveElicitationRequest = {
    requestId: "multi-free", provider: "claude", mode: "form", message: "Choose tools",
    fields: [{ type: "multi-select", name: "tools", title: "Tools", required: true, allowFreeText: true,
      options: [{ value: "editor", label: "Editor" }] }],
  };
  const mounted = await mountElicitation(request);
  try {
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, []);
    const input = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Tools Other"]');
    assert.ok(input);
    await enterText(mounted.dom, input, "terminal");
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { tools: ["terminal"] } }]);
    const checkbox = mounted.container.querySelector<HTMLInputElement>('.live-elicitation-option input[type="checkbox"]');
    assert.ok(checkbox);
    await act(async () => checkbox.click());
    await submit(mounted.container);
    assert.deepEqual(mounted.responses[1], { action: "accept", content: { tools: ["editor", "terminal"] } });
    await mounted.render({ ...request, requestId: "multi-free-next" });
    assert.equal(input.value, "", "新しいrequestへ自由入力を持ち越さない");
    await act(async () => checkbox.click());
    await submit(mounted.container);
    assert.deepEqual(mounted.responses[2], { action: "accept", content: { tools: ["editor"] } });
  } finally {
    await mounted.cleanup();
  }
});
