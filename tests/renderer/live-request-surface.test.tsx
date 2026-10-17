import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ElicitationRecord, LiveApprovalRequest, LiveElicitationRequest } from "../../src-shared/session/runtime-state.js";
import { InlineQuestionContent, LiveRequestSurface, type LiveRequestSurfaceProps, type LiveElicitationDrafts } from "../../src/chat/runtime/live-request-surface.js";

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

async function enterText(dom: JSDOM, input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
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
// claim = "secret指定の入力質問は長文でもpassword inputにし、回答内容を既存formで送信する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Provider入力質問のsecret textとpassword input" }
// fault = "secretをtextareaや平文inputで表示する、または回答payloadを変える"
// observable = "password inputのtype、Submit後の回答payload"
// observation_boundary = "component-behavior"
// scope = "live-elicitation-secret-text"
// lifecycle = "permanent"
// impact = "画面上に秘匿回答が露出するか、入力した回答が送信されない"
// distinction = "schemaと型はDOM入力typeと長文分岐のマスクや実Submit payloadを保証できない"
// @end-test-value
test("LiveRequestSurfaceはsecret回答をmaskして送信する", async () => {
  const mounted = await mountElicitation({
    requestId: "secret-question", provider: "codex", mode: "form", blocking: false, message: "Enter private answer",
    fields: [{ type: "text", name: "answer", title: "Private answer", required: true, secret: true, maxLength: 500 }],
  });
  try {
    const input = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Private answer"]');
    assert.ok(input);
    assert.equal(input.type, "password");
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
    const input = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Direction Custom Answer"]');
    assert.ok(input);
    assert.equal(input.value, "");
    const north = mounted.container.querySelector<HTMLInputElement>('input[type="radio"]');
    assert.ok(north);
    assert.equal(north.parentElement?.textContent, "North");
    assert.equal(north.checked, false);
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, []);
    assert.match(mounted.container.textContent ?? "", /Enter Direction\./);
    await enterText(mounted.dom, input, "  ");
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, []);
    await enterText(mounted.dom, input, "northeast");
    await act(async () => north.click());
    await submit(mounted.container);
    assert.deepEqual(mounted.responses.pop(), { action: "accept", content: { direction: "north" } });
    const custom = mounted.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
    await act(async () => custom.click());
    assert.equal(input.value, "northeast");
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
// observable = "checkboxとCustom Answer入力のDOM操作、validation、送信payload"
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
    const input = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Tools Custom Answer"]');
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
    const nextInput = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Tools Custom Answer"]');
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
// claim = "質問記録は質問本文と選択肢だけを読み取り専用で示し、有効なフォームと同じ質問を重複表示しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms" }
// fault = "完了済み質問から操作可能なフォームを作るか、フォームと記録の重複で質問状態を誤認させる"
// observable = "質問本文の出現数、記録の本文・選択肢、フォームcontrol数"
// observation_boundary = "component-behavior"
// scope = "live-elicitation-records"
// lifecycle = "permanent"
// impact = "解決済み質問に再回答できるように見えるか、会話に余分な処理状態が表示される"
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
  const document = new JSDOM(html).window.document;
  assert.deepEqual([...document.querySelectorAll('.elicitation-record')].map(record => record.textContent), ["Resolved questionBranchMainFeature", "Ended question"]);
  assert.match(html, /<li>Main<\/li><li>Feature<\/li>/);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
});

// @test-value v2
// kind = "contract"
// claim = "有効な質問だけを指定本文範囲へ差し替え、本文のない質問は受信位置へ挿入し、回答後は元の会話を復元する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms" }
// fault = "同じ文言の別箇所を置換する、後続本文より後ろへ質問が移動する、または終了時に質問本文を失う"
// observable = "質問前後の本文・候補・フォームのDOM順序と終了後の本文"
// observation_boundary = "component-behavior"
// scope = "InlineQuestionContent source ranges and receipt anchors"
// lifecycle = "permanent"
// impact = "質問と回答の文脈を読み違えるか、履歴から質問が消える"
// distinction = "providerのID検査だけでは会話への差し替え位置と復元を保証できない"
// @end-test-value
test("InlineQuestionContent replaces only the source range and fixes tool questions at receipt", () => {
  const text = "Same? Before Same? After";
  const request: LiveElicitationRequest = { requestId: "async", provider: "codex", kind: "question", mode: "form", message: "Question", fields: [{ type: "text", name: "q", title: "Same?", required: true }] };
  const tool: LiveElicitationRequest = { ...request, requestId: "tool", fields: [{ type: "text", name: "q", title: "Tool question", required: true }] };
  const render = (active: boolean) => new JSDOM(renderToStaticMarkup(React.createElement(InlineQuestionContent, {
    text,
    records: [
      { requestId: "async", kind: "question", textRange: { start: 13, end: 18 }, message: "Question", fields: [{ title: "Same?" }], status: active ? "pending" : "answered" },
      { requestId: "tool", kind: "question", textRange: { start: 18, end: 18 }, message: "Question", fields: [{ title: "Tool question", options: ["A", "B"] }], status: active ? "pending" : "canceled" },
    ], requests: active ? [request, tool] : [], elicitationActionRequestId: null, onResolveLiveElicitation() {},
    renderText: (value, key) => React.createElement("p", { key, className: "body" }, value),
  }))).window.document;
  const pending = render(true);
  assert.deepEqual([...pending.body.children].map(node => node.className), ["body", "live-elicitation-card", "live-elicitation-card", "body"]);
  assert.deepEqual([...pending.querySelectorAll('.body')].map(node => node.textContent), ["Same? Before ", " After"]);
  assert.equal(pending.querySelectorAll('input').length, 2);
  const resolved = render(false);
  assert.deepEqual([...resolved.body.children].map(node => node.textContent), ["Same? Before Same?", "Tool questionAB", " After"]);
  assert.equal(resolved.querySelectorAll('input,button').length, 0);
});

// @test-value v2
// kind = "contract"
// claim = "source範囲を持つ質問は解決後も構造化選択肢を保持し、本文にある質問・候補を重複させず前後の本文順序を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms" }
// fault = "live request消失時に構造化候補を捨てるか、本文にもある質問・候補を二重に追加する"
// observable = "通常本文の保持と順序、補完候補の値、質問の出現数、解決済みフォームのcontrol数"
// observation_boundary = "component-behavior"
// scope = "InlineQuestionContent resolved source records"
// lifecycle = "permanent"
// impact = "回答・Close・失効後に質問の選択条件を履歴から確認できなくなる"
// distinction = "既存配置testのsource質問には候補がなく、型検査は解決後の表示欠落を検出しない。短い静的描画で既存本文との補完境界を継続検査する"
// @end-test-value
test("InlineQuestionContent retains structured choices when a source question resolves", () => {
  for (const status of ["answered", "declined", "canceled", "expired", "pending"] as const) {
    for (const [source, missing] of [
      ["Which branch?", ["Main", "Feature"]],
      ["Which branch? Mainland", ["Main", "Feature"]],
      ["Which **branch**?\n\n- **Main**", ["Feature"]],
      ["Which branch?\n\n- Main\n- Feature", []],
    ] as const) {
      const record: ElicitationRecord = {
        requestId: "source", kind: "question", message: "Question", status,
        textRange: { start: 7, end: 7 + source.length },
        fields: [{ title: "Which branch?", options: ["Main", "Feature"] }],
      };
      const dom = new JSDOM(renderToStaticMarkup(React.createElement(InlineQuestionContent, {
        text: `Before\n${source}\nAfter`, records: [record], requests: [],
        elicitationActionRequestId: null, onResolveLiveElicitation() {},
        renderText: (value, key) => React.createElement("p", { key, className: "body" }, value),
      })));
      try {
        const body = dom.window.document.body;
        assert.deepEqual([...body.querySelectorAll(".body")].map(node => node.textContent), [`Before\n${source}`, "\nAfter"]);
        assert.deepEqual([...body.querySelectorAll(".elicitation-record-options li")].map(node => node.textContent), missing);
        const visible = body.textContent!.replaceAll("**", "");
        for (const text of ["Which branch?", "Main", "Feature"]) {
          const sourceCount = source.replaceAll("**", "").split(text).length - 1;
          assert.equal(visible.split(text).length - 1, sourceCount + (missing.some(option => option === text) ? 1 : 0));
        }
        assert.ok(visible.indexOf("Before") < visible.indexOf("Which branch?"));
        assert.ok(visible.indexOf("Feature") < visible.indexOf("After"));
        assert.equal(body.querySelectorAll("input,button,select,textarea").length, 0);
      } finally { dom.window.close(); }
    }
  }
});
