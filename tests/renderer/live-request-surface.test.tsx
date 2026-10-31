import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { ElicitationRecord, LiveApprovalRequest, LiveElicitationRequest } from "../../src-shared/session/runtime-state.js";
import { InlineResponseContent, LiveRequestSurface, type LiveRequestSurfaceProps, type LiveElicitationDrafts } from "../../src/chat/runtime/live-request-surface.js";
import { getShortcutDispatcher, SHORTCUT_COMMAND_IDS } from "../../src/settings/shortcut-registry.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mountElicitation(request: LiveElicitationRequest, initialProps: Partial<LiveRequestSurfaceProps> = {}) {
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
  await render(request, initialProps);
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

async function pasteFiles(dom: JSDOM, input: HTMLTextAreaElement, files: Array<{ name: string; type: string; arrayBuffer(): Promise<ArrayBuffer> }>) {
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files, items: [] } });
  await act(async () => { input.dispatchEvent(event); });
  return event;
}

function pastedFile(name: string, type: string) {
  return { name, type, arrayBuffer: async () => new TextEncoder().encode(name).buffer };
}

// @test-value v2
// kind = "contract"
// claim = "質問回答の同名衝突は影響を表示し、取消では入力を保持して置換を送らず、Replaceだけが確認hashを送って参照を挿入する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: Replace Pasted FileとCancel" }
// fault = "衝突を無確認で置換する、影響説明を失う、取消を置換として送る、または確定結果を回答に挿入しない"
// observable = "dialogの対象名・影響説明、取消後のtextareaとAPI要求、Replace後のhashとtextarea"
// observation_boundary = "component-behavior"
// scope = "question answer replacement dialog integration"
// lifecycle = "permanent"
// impact = "回答中の既存添付を意図せず変更することを防ぐ"
// distinction = "collector単体では実formのdialog表示・button wiring・本文保持を保証できない"
// @end-test-value
test("LiveRequestSurface confirms file replacement and preserves input on cancel", async () => {
  const mounted = await mountElicitation({ requestId: "replace", provider: "codex", mode: "form", message: "Answer", fields: [
    { type: "text", name: "answer", title: "Answer", required: true },
  ] }, { sessionId: "session-replace" });
  const hashes: Array<string | undefined> = [];
  try {
    Object.defineProperty(mounted.dom.window, "withmate", { value: {
      async savePastedSessionFile(input: { replaceExistingHash?: string }) {
        hashes.push(input.replaceExistingHash);
        return input.replaceExistingHash ? "C:/session-files/note.txt" : { status: "conflict", fileName: "note.txt", existingHash: "existing" };
      },
    } });
    const answer = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer"]')!;
    await enterText(mounted.dom, answer, "Keep this ");
    answer.setSelectionRange(answer.value.length, answer.value.length);
    await pasteFiles(mounted.dom, answer, [pastedFile("note.txt", "text/plain")]);
    const dialog = mounted.dom.window.document.querySelector<HTMLElement>('[role="dialog"][aria-label="Replace Pasted File"]')!;
    assert.ok(dialog);
    assert.match(dialog.textContent!, /note\.txt.*different contents/);
    assert.match(dialog.textContent!, /earlier messages/);
    const button = (text: string) => [...mounted.dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === text)!;
    await act(async () => button("Cancel").click());
    assert.equal(answer.value, "Keep this ");
    assert.equal(answer.disabled, false);
    assert.deepEqual(hashes, [undefined]);
    assert.equal(mounted.dom.window.document.querySelector('[aria-label="Replace Pasted File"]'), null);
    await pasteFiles(mounted.dom, answer, [pastedFile("note.txt", "text/plain")]);
    await act(async () => button("Replace File").click());
    assert.deepEqual(hashes, [undefined, undefined, "existing"]);
    assert.equal(answer.value, "Keep this @C:/session-files/note.txt");
    assert.equal(answer.disabled, false);
  } finally { await mounted.cleanup(); }
});

// @test-value v2
// kind = "contract"
// claim = "質問回答の同内容貼付は操作不要の通知と参照を表示し、同名別内容ではコピーを選んで新しい参照を挿入できる"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: 操作不要の通知とSave a Copy" }
// fault = "再利用を無通知にする、通知で入力を停止する、コピーを置換として送る、保存先を回答に挿入しない"
// observable = "通知文とdialogの有無、API要求、回答textareaの参照"
// observation_boundary = "component-behavior"
// scope = "question answer pasted file reuse and copy"
// lifecycle = "permanent"
// impact = "再利用を把握でき、元の添付を保持したまま異なる画像を回答へ追加できる"
// distinction = "storageやcollector単体では質問formの通知表示・button配線・入力継続を確認できない"
// @end-test-value
test("LiveRequestSurface shows reuse notice and saves a conflict as a copy", async () => {
  const mounted = await mountElicitation({ requestId: "copy", provider: "codex", mode: "form", message: "Answer", fields: [
    { type: "text", name: "answer", title: "Answer", required: true },
  ] }, { sessionId: "session-copy" });
  const requests: Array<{ saveAsCopy?: boolean; replaceExistingHash?: string }> = [];
  try {
    Object.defineProperty(mounted.dom.window, "withmate", { value: {
      async savePastedSessionFile(input: { saveAsCopy?: boolean; replaceExistingHash?: string }) {
        requests.push(input);
        if (requests.length === 1) return { status: "reused", path: "C:/session-files/note.txt" };
        return input.saveAsCopy ? "C:/session-files/note-2.txt" : { status: "conflict", fileName: "note.txt", existingHash: "existing" };
      },
    } });
    const answer = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer"]')!;
    await enterText(mounted.dom, answer, "Draft ");
    answer.setSelectionRange(answer.value.length, answer.value.length);
    await pasteFiles(mounted.dom, answer, [pastedFile("note.txt", "text/plain")]);
    assert.match(mounted.dom.window.document.querySelector('[role="status"].pasted-file-reuse-notice')!.textContent!, /Identical File Reused: note\.txt/);
    assert.equal(mounted.dom.window.document.querySelector('[aria-label="Replace Pasted File"]'), null);
    assert.equal(answer.disabled, false);
    assert.equal(answer.value, "Draft @C:/session-files/note.txt");
    answer.setSelectionRange(answer.value.length, answer.value.length);
    await pasteFiles(mounted.dom, answer, [pastedFile("note.txt", "text/plain")]);
    const copy = [...mounted.dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save a Copy")!;
    await act(async () => copy.click());
    assert.equal(requests[2].saveAsCopy, true);
    assert.equal(requests[2].replaceExistingHash, undefined);
    assert.match(answer.value, /@C:\/session-files\/note-2\.txt/);
  } finally { await mounted.cleanup(); }
});

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
// claim = "質問のfile-backed画像と通常fileのpasteは元の名前で対象sessionへ保存され、改行を保持した同じrequestの同じfieldの文字列回答になる"
// oracle = { type = "contract", ref = "Issue #862: multiline free answer and attachment paths in the original question response; docs/design/desktop-ui.md#question-forms" }
// fault = "pasteを通常composerや別質問へ挿入する、sessionを誤る、または添付を別promptや別payloadへ分離する"
// observable = "保存APIのsessionIdとfile内容、各textarea値、元requestのSubmit payload"
// observation_boundary = "component-behavior"
// scope = "question-answer-paste-routing"
// lifecycle = "permanent"
// impact = "質問への回答が別会話へ漏れるか、添付と回答の文脈が失われる"
// distinction = "paste helper単体はフォームのfield/requestとの接続や最終回答payloadを検証できない"
// @end-test-value
test("LiveRequestSurface はmixed pasteを対象質問の文字列回答に保持する", async () => {
  const request: LiveElicitationRequest = { ...elicitationRequest, requestId: "paste-a", fields: [
    { type: "text", name: "answer", title: "Answer A", required: true },
    { type: "text", name: "note", title: "Note A", required: false },
  ] };
  const other: LiveElicitationRequest = { ...elicitationRequest, requestId: "paste-b", fields: [
    { type: "text", name: "answer", title: "Answer B", required: true },
  ] };
  const saved: Array<{ sessionId: string; fileName: string; content: string }> = [];
  const submitted: Array<{ requestId: string; response: unknown }> = [];
  const mounted = await mountElicitation(request, {
    sessionId: "session-paste", workspacePath: "C:/workspace", liveElicitationRequests: [request, other],
    onResolveLiveElicitation(current, response) { submitted.push({ requestId: current.requestId, response }); },
  });
  try {
    Object.defineProperty(mounted.dom.window, "withmate", { value: {
      isClipboardFileBacked: () => true,
      async savePastedSessionFile(input: { sessionId: string; fileName: string; data: ArrayBuffer }) {
        saved.push({ sessionId: input.sessionId, fileName: input.fileName, content: new TextDecoder().decode(input.data) });
        return `C:/session-files/${input.fileName}`;
      },
    } satisfies Pick<WithMateWindowApi, "isClipboardFileBacked" | "savePastedSessionFile"> });
    const answer = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer A"]')!;
    const note = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note A"]')!;
    const otherAnswer = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer B"]')!;
    assert.ok(answer && note && otherAnswer);
    await enterText(mounted.dom, answer, "First line\nSecond line\n");
    await enterText(mounted.dom, note, "Keep this note");
    answer.setSelectionRange(answer.value.length, answer.value.length);
    const event = await pasteFiles(mounted.dom, answer, [pastedFile("capture.png", "image/png"), pastedFile("notes.txt", "text/plain")]);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(saved, [
      { sessionId: "session-paste", fileName: "capture.png", content: "capture.png" },
      { sessionId: "session-paste", fileName: "notes.txt", content: "notes.txt" },
    ]);
    assert.match(answer.value, /^First line\nSecond line\n!\[.*\]\(C:\/session-files\/capture\.png\) @C:\/session-files\/notes\.txt$/);
    assert.equal(note.value, "Keep this note");
    assert.equal(otherAnswer.value, "");
    await submit(mounted.container);
    assert.deepEqual(submitted, [{ requestId: "paste-a", response: { action: "accept", content: { answer: answer.value, note: "Keep this note" } } }]);
  } finally { await mounted.cleanup(); }
});

// @test-value v2
// kind = "contract"
// claim = "自由回答のmultiline化後も文字数制約を検証し、format付きfieldは既存native inputから同じ構造化回答を送信する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms: native response constraints and strict MCP schemas" }
// fault = "textarea化でminLength/maxLength検証を迂回するか、format付き入力を自由回答へ置換してpayloadを変える"
// observable = "短すぎる/長すぎる回答のvalidationと送信件数、format input type、受理された回答payload"
// observation_boundary = "component-behavior"
// scope = "question-answer-schema-preservation"
// lifecycle = "permanent"
// impact = "providerが要求したschemaに違反する回答や変形した形式付き回答を送信する"
// distinction = "schema型検査ではmultiline editorの入力からSubmitへのvalidation接続を検証できない"
// @end-test-value
test("LiveRequestSurface はmultiline回答でも文字数制約とformat fieldを維持する", async () => {
  const mounted = await mountElicitation({ requestId: "strict", provider: "codex", mode: "form", message: "Enter values", fields: [
    { type: "text", name: "answer", title: "Answer", required: true, minLength: 3, maxLength: 5 },
    { type: "text", name: "url", title: "URL", required: true, format: "uri" },
  ] });
  try {
    const answer = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer"]')!;
    const url = mounted.container.querySelector<HTMLInputElement>('input[aria-label="URL"]')!;
    assert.ok(answer && url);
    assert.equal(url.type, "url");
    await enterText(mounted.dom, url, "https://example.test/reference");
    for (const [value, error] of [["a", "at least 3"], ["abc\ndef", "at most 5"]]) {
      await enterText(mounted.dom, answer, value);
      await submit(mounted.container);
      assert.deepEqual(mounted.responses, []);
      assert.ok(mounted.container.textContent?.includes(error));
    }
    await enterText(mounted.dom, answer, "a\nb");
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { answer: "a\nb", url: "https://example.test/reference" } }]);
  } finally { await mounted.cleanup(); }
});

// @test-value v2
// kind = "contract"
// claim = "質問添付の保存待ちはSubmitを止めCloseを残し、保存失敗では入力回答を保持して理由を表示し再送できる"
// oracle = { type = "contract", ref = "Issue #862 attachment failure and pending submission contract; docs/design/ui-design-guidelines.md#操作とアクセシビリティ" }
// fault = "保存前に未添付回答を送る、Closeまで禁止する、失敗を成功扱いしてdraftを消す"
// observable = "保存待ちのSubmit/Close disabled、失敗alert、textarea値、失敗後の回答payload"
// observation_boundary = "component-behavior"
// scope = "question-answer-attachment-pending-failure"
// lifecycle = "permanent"
// impact = "添付が欠けた回答を送信するか入力内容を失い、保存待ちから質問を閉じられなくなる"
// distinction = "単体paste helperではフォーム送信の競合や利用可能なCloseを検証できない"
// @end-test-value
test("LiveRequestSurface は添付保存中の送信を止め失敗した回答を保持する", async () => {
  let rejectSave!: (error: Error) => void;
  const pending = new Promise<string>((_resolve, reject) => { rejectSave = reject; });
  const mounted = await mountElicitation(elicitationRequest, { sessionId: "session-pending" });
  try {
    Object.defineProperty(mounted.dom.window, "withmate", { value: { savePastedSessionFile: () => pending } });
    const answer = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Branch"]')!;
    assert.ok(answer);
    await enterText(mounted.dom, answer, "Keep\nmy answer");
    await pasteFiles(mounted.dom, answer, [pastedFile("notes.txt", "text/plain")]);
    const buttons = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")];
    assert.equal(buttons.find(button => button.textContent === "Submit")?.disabled, true);
    assert.equal(buttons.find(button => button.textContent === "Close")?.disabled, false);
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, []);
    await act(async () => { rejectSave(new Error("Session file save failed")); });
    assert.match(mounted.container.querySelector('[role="alert"]')?.textContent ?? "", /Session file save failed/);
    assert.equal(answer.value, "Keep\nmy answer");
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { branch: "Keep\nmy answer" } }]);
  } finally { await mounted.cleanup(); }
});

// @test-value v2
// kind = "contract"
// claim = "添付待ちの単一選択fieldだけ回答選択を止め、並行保存の成功・失敗ごとに再選択を許可し、最後に選んだ回答を送信する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms: 添付待ちの対象入力・選択肢とSubmitの無効化、他fieldとCloseの維持" }
// fault = "添付待ちのradio選択を後着の添付が取り消す、別fieldまで無効化する、並行保存中の一部完了で操作可否を誤る"
// observable = "各fieldのradioとSubmit/Closeのdisabled、checked状態、保存結果と失敗alert、再選択後の回答payload"
// observation_boundary = "component-behavior"
// scope = "question-answer-attachment-choice-lock"
// lifecycle = "permanent"
// impact = "利用者が最後に選んだ回答と異なる内容を送るか、無関係な回答編集・質問の終了を妨げる"
// distinction = "既存の添付pending testはtext欄だけで、単一選択radioとの競合や複数fieldの並行保存の操作可否を検証しない"
// @end-test-value
test("LiveRequestSurface は添付待ちの回答選択をfieldごとに保護する", async () => {
  const request: LiveElicitationRequest = { ...elicitationRequest, kind: "question", fields: ["First", "Second"].map((title) => ({
    type: "select", name: title.toLowerCase(), title, required: true, allowFreeText: true, defaultValue: "keep",
    options: [{ value: "keep", label: "Keep" }, { value: "adjust", label: "Adjust" }],
  })) };
  let finishFirst!: (path: string) => void;
  let failSecond!: (error: Error) => void;
  const firstSave = new Promise<string>((resolve) => { finishFirst = resolve; });
  const secondSave = new Promise<string>((_resolve, reject) => { failSecond = reject; });
  const mounted = await mountElicitation(request, { sessionId: "session-choice" });
  try {
    Object.defineProperty(mounted.dom.window, "withmate", { value: {
      savePastedSessionFile(input: { fileName: string }) { return input.fileName === "first.txt" ? firstSave : secondSave; },
    } });
    const groups = [...mounted.container.querySelectorAll('[role="radiogroup"]')];
    const [first, second] = groups.map((group) => ({
      editor: group.querySelector("textarea")!,
      radios: [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')],
      adjust: group.querySelector<HTMLInputElement>('input[value="adjust"]')!,
      custom: group.querySelector<HTMLInputElement>('input[aria-label]')!,
    }));
    const submitButton = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Submit"]')!;
    const closeButton = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    await enterText(mounted.dom, first.editor, "Draft");
    first.editor.setSelectionRange(first.editor.value.length, first.editor.value.length);
    await pasteFiles(mounted.dom, first.editor, [pastedFile("first.txt", "text/plain")]);
    assert.ok(first.radios.every((radio) => radio.disabled));
    assert.ok(second.radios.every((radio) => !radio.disabled));
    assert.equal(second.editor.disabled, false);
    assert.equal(closeButton.disabled, false);
    assert.equal(submitButton.disabled, true);
    await act(async () => { first.adjust.click(); second.adjust.click(); });
    assert.equal(first.custom.checked, true);
    assert.equal(second.adjust.checked, true);
    await pasteFiles(mounted.dom, second.editor, [pastedFile("second.txt", "text/plain")]);
    assert.ok(second.radios.every((radio) => radio.disabled));
    await act(async () => second.custom.click());
    assert.equal(second.adjust.checked, true);
    await act(async () => finishFirst("C:/session-files/first.txt"));
    assert.equal(first.editor.value, "Draft @C:/session-files/first.txt");
    assert.ok(first.radios.every((radio) => !radio.disabled));
    assert.ok(second.radios.every((radio) => radio.disabled));
    assert.equal(submitButton.disabled, true);
    await act(async () => first.adjust.click());
    assert.equal(first.adjust.checked, true);
    await act(async () => failSecond(new Error("Second attachment failed")));
    assert.match(mounted.container.querySelector('[role="alert"]')?.textContent ?? "", /Second attachment failed/);
    assert.ok(second.radios.every((radio) => !radio.disabled));
    assert.equal(second.editor.value, "");
    assert.equal(second.adjust.checked, true);
    assert.equal(first.adjust.checked, true);
    assert.equal(submitButton.disabled, false);
    await act(async () => second.custom.click());
    assert.equal(second.custom.checked, true);
    await act(async () => second.radios[0]!.click());
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { first: "adjust", second: "keep" } }]);
  } finally { await mounted.cleanup(); }
});

// @test-value v2
// kind = "contract"
// claim = "質問置換後に完了した添付保存は次のrequestの入力や回答へ混入しない"
// oracle = { type = "contract", ref = "Issue #862 request-bound attachments; docs/design/desktop-ui.md#question-forms" }
// fault = "unmount済み質問の非同期完了で次の質問のdraftを更新する"
// observable = "置換requestのtextarea値、Submit有効性と回答payload"
// observation_boundary = "component-behavior"
// scope = "question-answer-stale-attachment"
// lifecycle = "permanent"
// impact = "別質問に意図しないfile参照が送られ回答の文脈とデータ境界が破れる"
// distinction = "同期のfield分離検査はrequest置換中の遅延保存を観測しない"
// @end-test-value
test("LiveRequestSurface は古い添付の完了を置換質問へ適用しない", async () => {
  let finishSave!: (path: string) => void;
  const pending = new Promise<string>(resolve => { finishSave = resolve; });
  const mounted = await mountElicitation(elicitationRequest, { sessionId: "session-old" });
  try {
    Object.defineProperty(mounted.dom.window, "withmate", { value: { savePastedSessionFile: () => pending } });
    const answer = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Branch"]')!;
    assert.ok(answer);
    await enterText(mounted.dom, answer, "Old answer");
    await pasteFiles(mounted.dom, answer, [pastedFile("old.txt", "text/plain")]);
    await mounted.render({ ...elicitationRequest, requestId: "replacement" }, { sessionId: "session-next" });
    const next = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Branch"]')!;
    await enterText(mounted.dom, next, "New answer");
    await act(async () => { finishSave("C:/session-files/old.txt"); });
    assert.equal(next.value, "New answer");
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { branch: "New answer" } }]);
  } finally { await mounted.cleanup(); }
});

// @test-value v2
// kind = "contract"
// claim = "質問回答の通常Enterは改行用に残し、設定済み送信shortcutだけが元の質問を送信し、IME変換中とrepeatは送信しない"
// oracle = { type = "contract", ref = "Issue #862: multiline question editor with configured composerSubmit shortcut and IME/repeat guards" }
// fault = "Enterで質問を誤送信する、custom bindingを無視する、IME確定で送信する、または通常composerへ誤送信する"
// observable = "keyboard eventのdefaultPrevented、質問response数、通常composer handlerの呼出数"
// observation_boundary = "component-behavior"
// scope = "question-answer-local-shortcut"
// lifecycle = "permanent"
// impact = "未完成の回答または別の通常メッセージが意図せず送信される"
// distinction = "registry単体では質問textareaのlocal handler、IME状態とフォーム送信の接続を検証しない"
// @end-test-value
test("LiveRequestSurface は設定shortcutを質問内だけで扱う", async () => {
  const mounted = await mountElicitation(elicitationRequest);
  const dispatcher = getShortcutDispatcher()!;
  let composerSends = 0;
  dispatcher.setSettings({ overrides: { [SHORTCUT_COMMAND_IDS.composerSubmit]: {
    windows: { key: "Enter", altKey: true }, linux: { key: "Enter", altKey: true }, macos: { key: "Enter", altKey: true },
  } } });
  const unregisterScope = dispatcher.registerScope("composer");
  const unregisterHandler = dispatcher.registerHandler(SHORTCUT_COMMAND_IDS.composerSubmit, () => { composerSends += 1; });
  try {
    const answer = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Branch"]')!;
    assert.ok(answer);
    await enterText(mounted.dom, answer, "First\nSecond");
    const key = async (init: KeyboardEventInit) => {
      const event = new mounted.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ...init });
      await act(async () => { answer.dispatchEvent(event); });
      return event;
    };
    assert.equal((await key({})).defaultPrevented, false);
    assert.equal((await key({ ctrlKey: true })).defaultPrevented, false);
    await key({ altKey: true, repeat: true });
    await key({ altKey: true, isComposing: true });
    await act(async () => { answer.dispatchEvent(new mounted.dom.window.CompositionEvent("compositionstart", { bubbles: true })); });
    await key({ altKey: true });
    await act(async () => { answer.dispatchEvent(new mounted.dom.window.CompositionEvent("compositionend", { bubbles: true })); });
    assert.deepEqual(mounted.responses, []);
    assert.equal((await key({ altKey: true })).defaultPrevented, true);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { branch: "First\nSecond" } }]);
    assert.equal(composerSends, 0);
  } finally {
    unregisterHandler();
    unregisterScope();
    dispatcher.dispose();
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "質問回答のAttachは元file/folder/imageとSession Filesのcopy/file/folder/imageを同じ回答fieldへpath文字列として挿入する"
// oracle = { type = "contract", ref = "Issue #862: ActionDock-equivalent attachment actions; docs/design/desktop-ui.md#question-forms" }
// fault = "質問menuの操作を別APIへ接続する、sessionIdを渡さない、または回答にpathを含めない"
// observable = "各menu操作で呼ばれたpicker/copy APIと引数、回答payloadのpath文字列"
// observation_boundary = "component-behavior"
// scope = "question-answer-attachment-menu-routing"
// lifecycle = "permanent"
// impact = "利用者が選んだ資料やSession Filesが質問への回答に含まれない"
// distinction = "共有menuの単体testは質問editorが各callbackを正しいAPIと回答へ接続したことを保証しない"
// @end-test-value
test("LiveRequestSurface はAttachの各操作を質問回答へ接続する", async () => {
  const mounted = await mountElicitation(elicitationRequest, { sessionId: "session-menu", workspacePath: "C:/workspace" });
  const calls: unknown[] = [];
  try {
    Object.defineProperty(mounted.dom.window, "withmate", { value: {
      async pickFile(path: string) { calls.push(["file", path]); return "C:/original/file.txt"; },
      async pickDirectory(path: string) { calls.push(["folder", path]); return "C:/original/folder"; },
      async pickImageFile(path: string) { calls.push(["image", path]); return "C:/original/image.png"; },
      async pickFiles(path: string) { calls.push(["copy-pick", path]); return ["C:/original/copy.txt"]; },
      async copyFilesToSessionFiles(id: string, paths: string[]) { calls.push(["copy", id, paths]); return ["C:/session/copied.txt"]; },
      async pickSessionFiles(id: string) { calls.push(["session-file", id]); return ["C:/session/file.txt"]; },
      async pickSessionFolder(id: string) { calls.push(["session-folder", id]); return "C:/session/folder"; },
      async pickSessionImageFile(id: string) { calls.push(["session-image", id]); return "C:/session/image.png"; },
    } });
    const answer = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Branch"]')!;
    assert.ok(answer);
    await enterText(mounted.dom, answer, "References: ");
    for (const label of [
      "Attach the original file as a reference", "Attach the original folder as a reference", "Attach the original image as a reference",
      "Copy files to Session files and attach them", "Attach a file from Session files", "Attach a folder from Session files", "Attach an image from Session files",
    ]) {
      answer.setSelectionRange(answer.value.length, answer.value.length);
      await act(async () => { mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Attach"]')!.click(); });
      const action = mounted.dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      assert.ok(action);
      await act(async () => { action.click(); });
    }
    assert.deepEqual(calls, [
      ["file", "C:/workspace"], ["folder", "C:/original"], ["image", "C:/original/folder"], ["copy-pick", "C:/original"],
      ["copy", "session-menu", ["C:/original/copy.txt"]], ["session-file", "session-menu"], ["session-folder", "session-menu"], ["session-image", "session-menu"],
    ]);
    const expected = "References: @C:/original/file.txt @C:/original/folder @C:/original/image.png @C:/session/copied.txt @C:/session/file.txt @C:/session/folder @C:/session/image.png";
    assert.equal(answer.value, expected);
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { branch: expected } }]);
  } finally { await mounted.cleanup(); }
});

// @test-value v2
// kind = "contract"
// claim = "共有Attachは対象回答欄を識別してfocusに追従し、picker待ちに別欄へ移っても開始時の欄へ挿入して元質問に送る"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms: Attachの配置、初期対象、focusと保存中の対象固定" }
// fault = "共有Attachが別欄や別質問へpathを混入する、対象表示と挿入先が異なる、または選択式の自由回答を有効にしない"
// observable = "Attachのaccessible nameと対象欄名、picker待ち前後の各回答値とSubmit可否、送信された元質問のpayload"
// observation_boundary = "component-behavior"
// scope = "question-answer-shared-attachment-target"
// lifecycle = "permanent"
// impact = "添付資料が意図しない質問の回答へ混入するか、入力した資料が選択肢に置換されて送信されない"
// distinction = "既存pasteと7種pickerのtestは一つのAttachを複数回答欄で共有するfocus切替と非同期完了先を検証しない"
// @end-test-value
test("LiveRequestSurface は共有Attachの対象を示し選択開始時の回答欄を維持する", async () => {
  const request: LiveElicitationRequest = { ...elicitationRequest, kind: "question", fields: [
    { type: "text", name: "answer", title: "Answer", required: true, defaultValue: "First" },
    { type: "select", name: "choice", title: "Choice", required: true, allowFreeText: true,
      defaultValue: "keep", options: [{ value: "keep", label: "Keep" }] },
    { type: "text", name: "url", title: "URL", required: false, format: "uri" },
  ] };
  const other: LiveElicitationRequest = { ...elicitationRequest, kind: "question", requestId: "other", fields: [
    { type: "text", name: "other", title: "Other answer", required: false, defaultValue: "Other" },
  ] };
  let finishPick!: (path: string) => void;
  const pending = new Promise<string>((resolve) => { finishPick = resolve; });
  let picks = 0;
  const props = { sessionId: "session-shared", liveElicitationRequests: [request, other] };
  const mounted = await mountElicitation(request, props);
  try {
    Object.defineProperty(mounted.dom.window, "withmate", { value: {
      pickFile() { return ++picks === 1 ? pending : Promise.resolve("C:/choice.txt"); },
    } });
    await mounted.render(request, props);
    const [card, otherCard] = mounted.container.querySelectorAll('section[role="group"]');
    const answer = card.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer"]')!;
    const choice = card.querySelector<HTMLTextAreaElement>('textarea[aria-label="Choice Custom Answer"]')!;
    const url = card.querySelector<HTMLInputElement>('input[aria-label="URL"]')!;
    const custom = card.querySelector<HTMLInputElement>('input[aria-label="Choice Custom Answer"]')!;
    const pick = async (label: string) => {
      const trigger = card.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      assert.ok(trigger);
      await act(async () => trigger.click());
      const item = mounted.dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Attach the original file as a reference"]');
      assert.ok(item);
      await act(async () => item.click());
    };
    assert.deepEqual([...card.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")), ["Attach to Answer", "Close", "Submit"]);
    answer.setSelectionRange(answer.value.length, answer.value.length);
    await pick("Attach to Answer");
    assert.equal(answer.disabled, true);
    assert.equal(card.querySelector<HTMLButtonElement>('button[aria-label="Submit"]')!.disabled, true);
    assert.equal(otherCard.querySelector<HTMLButtonElement>('button[aria-label="Submit"]')!.disabled, false);
    await act(async () => custom.focus());
    assert.ok(card.querySelector('button[aria-label="Attach to Choice"]'));
    assert.equal(card.querySelector(".question-answer-attachment-label")?.textContent, "Choice");
    await act(async () => url.focus());
    assert.ok(card.querySelector('button[aria-label="Attach to Choice"]'));
    await act(async () => {
      finishPick("C:/first.txt");
      await new Promise<void>((resolve) => mounted.dom.window.requestAnimationFrame(() => resolve()));
    });
    assert.equal(answer.value, "First @C:/first.txt");
    assert.equal(choice.value, "");
    assert.equal(url.value, "");
    assert.equal(otherCard.querySelector("textarea")?.value, "Other");
    await act(async () => choice.focus());
    await pick("Attach to Choice");
    assert.equal(choice.value, "@C:/choice.txt");
    assert.equal(custom.checked, true);
    assert.equal(card.querySelector<HTMLButtonElement>('button[aria-label="Submit"]')!.disabled, false);
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { answer: "First @C:/first.txt", choice: "@C:/choice.txt" } }]);
  } finally { await mounted.cleanup(); }
});

// @test-value v2
// kind = "contract"
// claim = "Live approvalは実行したdecisionのbuttonだけにspinnerとbusyを示し、単一のstatusと要求本文・警告・折りたたみ詳細・操作識別を維持する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#ボタン と docs/design/desktop-ui.md#Approval Requests" }
// fault = "非実行buttonもspinnerまたはbusyになるか、busy announcementまたは要求本文・操作labelを失う"
// observable = "request領域と各buttonのaria-busy、spinnerの所属、status数、要求本文、warning/details、操作label"
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
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .filter((button) => button.textContent === "Allow Once" || button.textContent === "Reject");
    assert.deepEqual(buttons.map((button) => button.textContent), ["Allow Once", "Reject"]);
    const active = buttons[decision === "approve" ? 0 : 1];
    assert.ok(active.querySelector(".button-content-spinner[aria-hidden='true']"));
    assert.equal(active.getAttribute("aria-busy"), "true");
    assert.deepEqual(buttons.filter((button) => button.getAttribute("aria-busy") === "true"), [active]);
    assert.equal(document.querySelectorAll(".button-content-spinner").length, 1);
    assert.ok(buttons.every((button) => button.disabled));
    const group = document.querySelector('[role="group"][aria-label="Approval required"]');
    assert.ok(group);
    assert.equal(group.querySelector("p")?.textContent, approvalRequest.summary);
    assert.equal(group.querySelector('[role="alert"]')?.textContent, approvalRequest.warning);
    const detailsToggle = group.querySelector<HTMLButtonElement>('button[aria-label="Show approval details"]');
    assert.ok(detailsToggle);
    assert.equal(detailsToggle.disabled, false);
    assert.equal(detailsToggle.getAttribute("aria-expanded"), "false");
    const details = document.getElementById(detailsToggle.getAttribute("aria-controls")!);
    assert.ok(details);
    assert.equal(details.hidden, true);
    assert.equal(details.textContent, approvalRequest.details);
  }
});

// @test-value v2
// kind = "contract"
// claim = "承認詳細は名前付きbuttonで開閉でき、同じ要求の更新と送信中は開閉状態を保ち、新しい要求では閉じる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#Approval Requests" }
// fault = "詳細buttonが開閉しない、aria-expandedと表示が食い違う、同じ要求の更新で閉じる、または次の要求へ開状態を持ち越す"
// observable = "詳細buttonのaccessible name・aria-expanded・aria-controls、対応する本文のhiddenと内容、更新前後のbutton同一性とfocus"
// observation_boundary = "component-behavior"
// scope = "live-approval-details-disclosure"
// lifecycle = "permanent"
// impact = "承認判断に必要な補足を開けないか、送信中や後続要求の表示が予期せず変わる"
// distinction = "静的markupと型検査では利用者の開閉操作と要求更新時の状態・focusを検証できず、局所的なDOM操作testで確認する"
// @end-test-value
test("LiveRequestSurface は承認詳細の開閉を要求ごとに保持する", async () => {
  const mounted = await mountElicitation(elicitationRequest);
  const renderApproval = (request: LiveApprovalRequest, busy = false) => mounted.render(elicitationRequest, {
    liveElicitationRequest: null,
    liveApprovalRequest: request,
    approvalActionRequestId: busy ? request.requestId : null,
    approvalActionDecision: busy ? "approve" : null,
  });
  try {
    await renderApproval(approvalRequest);
    const toggle = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Show approval details"]');
    assert.ok(toggle);
    const details = mounted.dom.window.document.getElementById(toggle.getAttribute("aria-controls")!);
    assert.ok(details);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(details.hidden, true);
    toggle.focus();
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-label"), "Hide approval details");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(details.hidden, false);
    assert.equal(details.textContent, approvalRequest.details);

    await renderApproval({ ...approvalRequest, summary: "Run the workspace tests" }, true);
    assert.equal(mounted.container.querySelector('[aria-label="Hide approval details"]'), toggle);
    assert.equal(mounted.dom.window.document.activeElement, toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.disabled, false);
    assert.equal(details.hidden, false);
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-label"), "Show approval details");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(details.hidden, true);
    await act(async () => toggle.click());
    assert.equal(details.hidden, false);

    await renderApproval({ ...approvalRequest, requestId: "approval-2", details: "Next request details" });
    const nextToggle = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Show approval details"]');
    assert.ok(nextToggle);
    assert.equal(nextToggle.getAttribute("aria-expanded"), "false");
    const nextDetails = mounted.dom.window.document.getElementById(nextToggle.getAttribute("aria-controls")!);
    assert.ok(nextDetails);
    assert.equal(nextDetails.hidden, true);
    await act(async () => nextToggle.click());
    assert.equal(nextDetails.hidden, false);
    assert.equal(nextDetails.textContent, "Next request details");
  } finally { await mounted.cleanup(); }
});

// @test-value v2
// kind = "contract"
// claim = "質問のicon buttonとMCPの文字buttonは実行したactionだけにspinnerとbusyを示し、単一のstatusと要求内容・accessible nameを維持する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#ボタン" }
// fault = "非実行buttonもspinnerまたはbusyになるか、busy announcementまたはrequest本文・操作labelを失う"
// observable = "input request領域と各buttonのaria-busy、spinnerの所属、status数、request本文、accessible name、質問iconのtooltipとaria-hidden"
// observation_boundary = "component-behavior"
// scope = "live-input-request-resolution-feedback"
// lifecycle = "permanent"
// impact = "入力回答の送信中に再操作や待機状態を誤認し、要求内容を見失う"
// distinction = "disabled属性の有無だけでなく、busy announcementが一つだけ存在し、要求内容と操作識別が同時に残ることを確認する"
// @end-test-value
test("LiveRequestSurface はinput解決中のbusy announcementと操作labelを保つ", () => {
  for (const kind of [undefined, "question"] as const) {
    for (const action of ["accept", "decline", "cancel"] as const) {
      if (kind === "question" && action === "decline") continue;
      const html = renderToStaticMarkup(React.createElement(LiveRequestSurface, {
        liveApprovalRequest: null,
        approvalActionRequestId: null,
        liveElicitationRequest: { ...elicitationRequest, kind },
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
      const labels = kind === "question" ? ["Close", "Submit"] : ["Reject", "Close", "Submit"];
      assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent), labels);
      if (kind === "question") {
        assert.deepEqual(buttons.map((button) => button.title), labels);
        assert.ok(buttons.every((button) => button.querySelector('svg[aria-hidden="true"]')));
      } else {
        assert.deepEqual(buttons.map((button) => button.textContent), labels);
      }
      const actionLabel = action === "accept" ? "Submit" : action === "decline" ? "Reject" : "Close";
      const active = buttons[labels.indexOf(actionLabel)];
      assert.ok(active.querySelector(".button-content-spinner[aria-hidden='true']"));
      assert.equal(active.getAttribute("aria-busy"), "true");
      assert.deepEqual(buttons.filter((button) => button.getAttribute("aria-busy") === "true"), [active]);
      assert.equal(document.querySelectorAll(".button-content-spinner").length, 1);
      assert.ok(buttons.every((button) => button.disabled));
      assert.match(html, kind === "question" ? /Branch/ : /Choose a branch/);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "自由入力を許す単一選択はaccessible nameを持つradioで自由回答へ戻れ、候補を残しつつ空回答を拒否して改行を含む回答を送れる"
// oracle = { type = "contract", ref = "Claude AskUserQuestion required free-text answer contract; Issue #862 multiline answers" }
// fault = "候補が初期選択されたように見える、自由入力や改行を失う、または空白を必須回答として送る"
// observable = "候補付き入力の初期値・候補、自由回答radioのaccessible nameと選択状態、validation、送信payload"
// observation_boundary = "component-behavior"
// scope = "live-elicitation-free-text-select"
// lifecycle = "permanent"
// impact = "利用者の意図しない候補が回答されるか、Claudeへの必須回答を自由に入力できない"
// distinction = "型検査・静的markupだけでは入力後のvalidationとpayloadを確認できない"
// @end-test-value
test("LiveRequestSurface は自由入力の単一選択を候補付きで回答する", async () => {
  const request: LiveElicitationRequest = {
    requestId: "single-free", provider: "claude", kind: "question", mode: "form", message: "Choose direction",
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
    await enterText(mounted.dom, input, "northeast\nvia river");
    await act(async () => north.click());
    await submit(mounted.container);
    assert.deepEqual(mounted.responses.pop(), { action: "accept", content: { direction: "north" } });
    const custom = mounted.container.querySelector<HTMLInputElement>('input[type="radio"][aria-label="Direction Custom Answer"]');
    assert.ok(custom);
    await act(async () => custom.click());
    assert.equal(custom.checked, true);
    assert.equal(input.value, "northeast\nvia river");
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { direction: "northeast\nvia river" } }]);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "自由入力を許す複数選択は選択肢だけ・改行を含む自由入力だけ・双方を同じstring[] payloadで回答でき、空の必須回答を拒否する"
// oracle = { type = "contract", ref = "Claude AskUserQuestion required free-text answer contract; Issue #862 multiline answers" }
// fault = "自由入力のために既存選択肢を選ぶ必要がある、選択した候補や自由入力の改行を失う、または空回答を送る"
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
    const input = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Tools Custom Answer"]');
    assert.ok(input);
    await enterText(mounted.dom, input, "terminal\nwith shell");
    await submit(mounted.container);
    assert.deepEqual(mounted.responses, [{ action: "accept", content: { tools: ["terminal\nwith shell"] } }]);
    const checkbox = mounted.container.querySelector<HTMLInputElement>('.live-elicitation-option input[type="checkbox"]');
    assert.ok(checkbox);
    await act(async () => checkbox.click());
    await submit(mounted.container);
    assert.deepEqual(mounted.responses[1], { action: "accept", content: { tools: ["editor", "terminal\nwith shell"] } });
    await mounted.render({ ...request, requestId: "multi-free-next" });
    const nextInput = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Tools Custom Answer"]');
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
    const input = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Direction"]');
    assert.ok(input);
    await enterText(mounted.dom, input, "northeast");
    const buttons = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Submit");
    assert.equal(buttons[0].disabled, true);
    assert.equal(buttons[1].disabled, false);
    await act(async () => buttons[0].click());
    assert.deepEqual(mounted.responses, []);
    await mounted.render(request, { liveElicitationRequests: [], drafts });
    await mounted.render(request, { ...active, inputAvailable: true });
    assert.equal(mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Direction"]')?.value, "northeast");
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
// scope = "InlineResponseContent source ranges and receipt anchors"
// lifecycle = "permanent"
// impact = "質問と回答の文脈を読み違えるか、履歴から質問が消える"
// distinction = "providerのID検査だけでは会話への差し替え位置と復元を保証できない"
// @end-test-value
test("InlineResponseContent replaces only the source range and fixes tool questions at receipt", () => {
  const text = "Same? Before Same? After";
  const request: LiveElicitationRequest = { requestId: "async", provider: "codex", kind: "question", mode: "form", message: "Question", fields: [{ type: "text", name: "q", title: "Same?", required: true }] };
  const tool: LiveElicitationRequest = { ...request, requestId: "tool", fields: [{ type: "text", name: "q", title: "Tool question", required: true }] };
  const render = (active: boolean) => new JSDOM(renderToStaticMarkup(React.createElement(InlineResponseContent, {
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
  assert.equal(pending.querySelectorAll('textarea').length, 2);
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
// scope = "InlineResponseContent resolved source records"
// lifecycle = "permanent"
// impact = "回答・Close・失効後に質問の選択条件を履歴から確認できなくなる"
// distinction = "既存配置testのsource質問には候補がなく、型検査は解決後の表示欠落を検出しない。短い静的描画で既存本文との補完境界を継続検査する"
// @end-test-value
test("InlineResponseContent retains structured choices when a source question resolves", () => {
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
      const dom = new JSDOM(renderToStaticMarkup(React.createElement(InlineResponseContent, {
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
