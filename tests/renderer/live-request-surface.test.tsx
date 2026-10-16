import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { LiveApprovalRequest, LiveElicitationRequest } from "../../src-shared/session/runtime-state.js";
import { LiveRequestSurface, type LiveRequestSurfaceProps, type LiveElicitationDrafts } from "../../src/chat/runtime/live-request-surface.js";

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
  const render = async (nextRequest: LiveElicitationRequest, props: Partial<LiveRequestSurfaceProps> = {}) => {
    await act(async () => root.render(React.createElement(LiveRequestSurface, {
      liveApprovalRequest: null,
      approvalActionRequestId: null,
      liveElicitationRequest: nextRequest,
      elicitationActionRequestId: null,
      onResolveLiveApproval() {},
      onResolveLiveElicitation(_request, response) { responses.push(response); },
      ...props,
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
// claim = "Live approvalは実行したdecisionのbuttonだけにspinnerとbusyを示し、単一のstatusと要求内容・操作識別を維持する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#ボタン" }
// fault = "非実行buttonもspinnerになるか、busy announcementまたは要求本文・操作labelを失う"
// observable = "request領域と対象buttonのaria-busy、spinnerの所属、status数、要求本文、warning/details、操作label"
// observation_boundary = "component-behavior"
// scope = "live-request-resolution-feedback"
// lifecycle = "permanent"
// impact = "承認・入力回答の送信中に再操作や待機状態を誤認し、安全判断に必要な要求内容を見失う"
// distinction = "disabled属性の有無だけでなく、busy announcementが一つだけ存在し、要求内容と操作識別が同時に残ることを確認する"
// @end-test-value
test("LiveRequestSurface はapproval解決中のbusy announcementと要求内容を保つ", () => {
  for (const decision of ["approve", "deny"] as const) {
    const html = renderToStaticMarkup(React.createElement(LiveRequestSurface, {
      liveApprovalRequest: approvalRequest,
      approvalActionRequestId: approvalRequest.requestId,
      approvalActionDecision: decision,
      liveElicitationRequest: null,
      elicitationActionRequestId: null,
      onResolveLiveApproval() {},
      onResolveLiveElicitation() {},
    }));

    assert.match(html, /class="live-approval-card"[^>]*aria-busy="true"/);
    const document = new JSDOM(html).window.document;
    assert.equal(document.querySelectorAll('[role="status"]').length, 1);
    assert.equal(document.querySelector('[role="status"]')?.textContent, "Processing approval request");
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
    assert.deepEqual(buttons.map((button) => button.textContent), ["Allow Once", "Reject"]);
    const active = buttons[decision === "approve" ? 0 : 1];
    assert.ok(active.querySelector(".button-content-spinner[aria-hidden='true']"));
    assert.equal(active.getAttribute("aria-busy"), "true");
    assert.equal(document.querySelectorAll(".button-content-spinner").length, 1);
    assert.ok(buttons.every((button) => button.disabled));
    assert.match(html, /Run a command/);
    assert.match(html, /npm test/);
    assert.match(html, /This command can change workspace state\./);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Live input requestは実行したactionのbuttonだけにspinnerとbusyを示し、単一のstatusと要求内容・操作識別を維持する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#ボタン" }
// fault = "非実行buttonもspinnerになるか、busy announcementまたはrequest本文・操作labelを失う"
// observable = "input request領域と対象buttonのaria-busy、spinnerの所属、status数、request本文、操作label"
// observation_boundary = "component-behavior"
// scope = "live-input-request-resolution-feedback"
// lifecycle = "permanent"
// impact = "入力回答の送信中に再操作や待機状態を誤認し、要求内容を見失う"
// distinction = "disabled属性の有無だけでなく、busy announcementが一つだけ存在し、要求内容と操作識別が同時に残ることを確認する"
// @end-test-value
test("LiveRequestSurface はinput解決中のbusy announcementと操作labelを保つ", () => {
  for (const action of ["accept", "decline", "cancel"] as const) {
    const html = renderToStaticMarkup(React.createElement(LiveRequestSurface, {
      liveApprovalRequest: null,
      approvalActionRequestId: null,
      liveElicitationRequest: elicitationRequest,
      elicitationActionRequestId: elicitationRequest.requestId,
      elicitationAction: action,
      onResolveLiveApproval() {},
      onResolveLiveElicitation() {},
    }));

    assert.match(html, /class="live-elicitation-card"[^>]*aria-busy="true"/);
    const document = new JSDOM(html).window.document;
    assert.equal(document.querySelectorAll('[role="status"]').length, 1);
    assert.equal(document.querySelector('[role="status"]')?.textContent, "Processing input request");
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
    assert.deepEqual(buttons.map((button) => button.textContent), ["Submit", "Reject", "Close"]);
    const active = buttons[action === "accept" ? 0 : action === "decline" ? 1 : 2];
    assert.ok(active.querySelector(".button-content-spinner[aria-hidden='true']"));
    assert.equal(active.getAttribute("aria-busy"), "true");
    assert.equal(document.querySelectorAll(".button-content-spinner").length, 1);
    assert.ok(buttons.every((button) => button.disabled));
    assert.match(html, /Choose a branch/);
  }
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
    const nextInput = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Tools Other"]');
    const nextCheckbox = mounted.container.querySelector<HTMLInputElement>('.live-elicitation-option input[type="checkbox"]');
    assert.ok(nextInput);
    assert.ok(nextCheckbox);
    assert.equal(nextInput.value, "", "新しいrequestへ自由入力を持ち越さない");
    await act(async () => nextCheckbox.click());
    await submit(mounted.container);
    assert.deepEqual(mounted.responses[2], { action: "accept", content: { tools: ["editor"] } });
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "同時に有効な質問は別々のフォームを保持し、通常入力が利用不可の間は非同期回答を送らず、再描画後にdraftを再利用できる"
// oracle = { type = "contract", ref = "Issue #823 accepted question lifecycle: concurrent questions, current-turn input availability, draft preservation" }
// fault = "複数質問を単一フォームへ上書きする、入力不可でも送信する、またはsurface再配置でdraftを失う"
// observable = "表示されたフォーム数、Submitのdisabled状態、再マウント後の入力値と回答payload"
// observation_boundary = "component-behavior"
// scope = "live-elicitation-lifecycle"
// lifecycle = "permanent"
// impact = "有効な質問への回答または入力中の内容が失われ、providerへ誤ったタイミングで入力される"
// distinction = "型検査や単一フォームのtestでは複数requestのidentity、可用性遷移とunmount後のdraft復元を検出できない"
// @end-test-value
test("LiveRequestSurface preserves concurrent question drafts across availability and remount", async () => {
  const request: LiveElicitationRequest = {
    requestId: "async-a", provider: "codex", delivery: "user-message", mode: "form", message: "Choose direction",
    fields: [{ type: "text", name: "direction", title: "Direction", required: true }],
  };
  const native: LiveElicitationRequest = { ...request, requestId: "native-b", delivery: undefined, message: "Choose branch",
    fields: [{ type: "text", name: "branch", title: "Branch", required: true }] };
  const mounted = await mountElicitation(request);
  const drafts: LiveElicitationDrafts = new Map();
  const active = { liveElicitationRequests: [request, native], drafts };
  try {
    await mounted.render(request, { ...active, inputAvailable: false });
    assert.equal(mounted.container.querySelectorAll(".live-elicitation-card").length, 2);
    const input = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Direction"]');
    assert.ok(input);
    await enterText(mounted.dom, input, "northeast");
    const buttons = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Submit");
    assert.equal(buttons[0].disabled, true);
    assert.equal(buttons[1].disabled, false);
    await act(async () => buttons[0].click());
    assert.deepEqual(mounted.responses, []);
    await mounted.render(request, { liveElicitationRequests: [], drafts });
    await mounted.render(request, { ...active, inputAvailable: true });
    assert.equal(mounted.container.querySelector<HTMLInputElement>('input[aria-label="Direction"]')?.value, "northeast");
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { direction: "northeast" } }]);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "質問記録は本文と選択肢とフォーム処理結果を読み取り専用で示し、有効なフォームと同じ質問を重複表示しない"
// oracle = { type = "contract", ref = "Issue #823 accepted question lifecycle: read-only question records after resolution" }
// fault = "完了済み質問から操作可能なフォームを作るか、フォームと記録の重複で質問状態を誤認させる"
// observable = "質問本文の出現数、記録の選択肢と状態ラベル、フォームcontrol数"
// observation_boundary = "component-behavior"
// scope = "live-elicitation-records"
// lifecycle = "permanent"
// impact = "解決済み質問に再回答できるように見え、通常チャット回答とフォーム未送信の違いが失われる"
// distinction = "backendのrecord生成検査と型検査は利用者へ提示される状態・操作境界を検査しない。小さな静的描画で継続検査する"
// @end-test-value
test("LiveRequestSurface renders question records and active forms without duplicate questions", () => {
  const request: LiveElicitationRequest = { requestId: "active", provider: "codex", mode: "form", message: "Active question", fields: [] };
  const html = renderToStaticMarkup(React.createElement(LiveRequestSurface, {
    liveApprovalRequest: null, approvalActionRequestId: null, liveElicitationRequest: request,
    elicitationActionRequestId: null, onResolveLiveApproval() {}, onResolveLiveElicitation() {},
    elicitationRecords: [
      { requestId: "active", message: "Active question", fields: [], status: "pending" },
      { requestId: "answered", message: "Resolved question", fields: [{ title: "Branch", options: ["Main", "Feature"] }], status: "answered" },
      { requestId: "ended", message: "Ended question", fields: [], status: "expired" },
    ],
  }));
  assert.equal((html.match(/Active question/g) ?? []).length, 1);
  assert.match(html, /Answer Submitted/);
  assert.match(html, /No Form Response/);
  assert.match(html, /<li>Main<\/li><li>Feature<\/li>/);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.equal((html.match(/aria-label="Question record"/g) ?? []).length, 2);
});
