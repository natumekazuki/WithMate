import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import type { WithMateWindowNavigationApi, WithMateWindowTerminalApi } from "../../src-shared/ipc/withmate-window-api.js";
import { SessionTerminal, type SessionTerminalHandle } from "../../src/terminal/session-terminal.js";

// @test-value v2
// kind = "contract"
// claim = "WindowsのCtrl+VとCtrl+Shift+VはClipboardを一度貼り付け、Ctrl+Cは選択時だけコピーし、非WindowsのCtrl+Vは制御入力を維持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/772; docs/design/desktop-ui.md: 組み込みTerminalの入力とコピー" }
// fault = "WindowsのCtrl+VでClipboardではなく制御文字を送る、貼り付けを重複する、bracketed pasteを失う、コピー時もPTYへ送る、または非Windowsの制御入力を横取りする"
// observable = "Clipboardの読取回数とコピー内容、writeTerminalInputの引数と回数、keydown.defaultPrevented、貼り付け失敗のalert"
// observation_boundary = "component-behavior"
// scope = "SessionTerminalの実xtermキーボード入力からclipboardとTerminal APIまで"
// lifecycle = "permanent"
// impact = "WSL内でClipboardを貼り付けられず、コピーでコマンドを意図せず中断する、または制御入力が使えなくなる"
// distinction = "既存shortcut dispatcher testと型検査では実xtermのselection・bracketed paste・ClipboardとPTY配送の分岐を検証できない"
// @end-test-value
it("端末のClipboard操作とシェルへの制御入力を分離する", async (context) => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    self: dom.window,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class { observe() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => ({
    measureText: () => ({ width: 8 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }) });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(dom.window.navigator, "platform", { configurable: true, value: "Win32" });
  const copies: string[] = [];
  let reads = 0;
  let clipboardError: Error | undefined;
  const clipboardText = "paste 日本語";
  Object.defineProperty(dom.window.navigator, "clipboard", { value: {
    writeText: async (text: string) => { copies.push(text); },
    readText: async () => {
      reads++;
      if (clipboardError) throw clipboardError;
      return clipboardText;
    },
  } });
  const writes: Array<{ terminalId: string; data: string }> = [];
  let terminalId = "";
  const api: WithMateWindowTerminalApi & Pick<WithMateWindowNavigationApi, "openPath"> = {
    openPath: async (target) => ({ status: "opened", targetType: "external-url", target }),
    createTerminal: async (request) => { terminalId = request.terminalId; return { shellName: "PowerShell" }; },
    writeTerminalInput: (id, data) => { writes.push({ terminalId: id, data }); },
    resizeTerminal() {},
    acknowledgeTerminalOutput() {},
    closeTerminal: async () => true,
    releaseTerminal: async () => {},
    subscribeTerminalEvents: () => () => {},
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    // Capture the real instance through its public API without replacing key handling or selection.
    const { Terminal: Xterm } = await import("@xterm/xterm");
    let terminal: Terminal | undefined;
    const open = Xterm.prototype.open;
    context.mock.method(Xterm.prototype, "open", function (this: Terminal, ...args: Parameters<Terminal["open"]>) {
      terminal = this;
      return open.apply(this, args);
    });
    await act(async () => { root.render(createElement(SessionTerminal, { api, expanded: true, onEmpty() {} })); });
    for (let attempt = 0; attempt < 100 && !terminalId; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    assert.notEqual(terminalId, "", "terminal creation must complete");
    assert.ok(terminal);
    await act(async () => {
      await new Promise<void>((resolve) => terminal!.write("prefix 選択文字 suffix", resolve));
    });
    const input = dom.window.document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    assert.ok(input);
    input.focus();
    for (const shiftKey of [false, true]) {
      terminal.select(7, 0, 8);
      assert.equal(terminal.getSelection(), "選択文字");
      const keydown = new dom.window.KeyboardEvent("keydown", {
        key: shiftKey ? "C" : "c", code: "KeyC", keyCode: 67, ctrlKey: true, shiftKey,
        bubbles: true, cancelable: true,
      });
      await act(async () => {
        input.dispatchEvent(keydown);
        input.dispatchEvent(new dom.window.KeyboardEvent("keyup", {
          key: shiftKey ? "C" : "c", code: "KeyC", keyCode: 67, ctrlKey: true, shiftKey, bubbles: true,
        }));
      });
      assert.equal(keydown.defaultPrevented, true);
      assert.deepEqual(writes, []);
    }
    assert.deepEqual(copies, ["選択文字", "選択文字"]);

    terminal.clearSelection();
    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "c", code: "KeyC", keyCode: 67, ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });
    assert.deepEqual(writes, [{ terminalId, data: "\u0003" }]);
    assert.deepEqual(copies, ["選択文字", "選択文字"]);

    const pressPaste = async (shiftKey: boolean) => {
      const keydown = new dom.window.KeyboardEvent("keydown", {
        key: shiftKey ? "V" : "v", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey,
        bubbles: true, cancelable: true,
      });
      await act(async () => {
        input.dispatchEvent(keydown);
        input.dispatchEvent(new dom.window.KeyboardEvent("keyup", {
          key: shiftKey ? "V" : "v", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey, bubbles: true,
        }));
      });
      return keydown;
    };
    // The shell controls bracketed-paste mode through its output, not platform detection.
    for (const bracketed of [false, true, false]) {
      await act(async () => {
        await new Promise<void>((resolve) => terminal!.write(`\x1b[?2004${bracketed ? "h" : "l"}`, resolve));
      });
      for (const shiftKey of [false, true]) {
        writes.length = 0;
        const beforeReads = reads;
        const event = await pressPaste(shiftKey);
        assert.equal(event.defaultPrevented, true);
        assert.equal(reads, beforeReads + 1, "each key chord reads the Clipboard once");
        assert.deepEqual(writes, [{ terminalId, data: bracketed ? `\x1b[200~${clipboardText}\x1b[201~` : clipboardText }]);
      }
    }

    for (const platform of ["MacIntel", "Linux x86_64"]) {
      Object.defineProperty(dom.window.navigator, "platform", { configurable: true, value: platform });
      writes.length = 0;
      const beforeReads = reads;
      await pressPaste(false);
      assert.equal(reads, beforeReads);
      assert.deepEqual(writes, [{ terminalId, data: "\u0016" }]);
    }

    Object.defineProperty(dom.window.navigator, "platform", { configurable: true, value: "Win32" });
    clipboardError = new Error("Clipboard unavailable");
    writes.length = 0;
    await pressPaste(false);
    assert.deepEqual(writes, []);
    assert.match(dom.window.document.querySelector('[role="alert"]')?.textContent ?? "", /Paste failed:.*Clipboard unavailable/);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "端末出力のHTTP(S)リンクとOSC 8のWebリンクはCtrl＋左クリックでだけopenPathへ届き、開けない場合は端末内に失敗を示す"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/815; docs/design/desktop-ui.md: TerminalのWebリンク" }
// fault = "WebLinksAddonを組み込まない、修飾キーやbuttonを無視する、OSC 8を別経路で開く、非Web URIを開く、またはopenPath失敗を隠す"
// observable = "実addonが出力から検出したリンク、openPathの対象と回数、PTYへの入力、端末alert"
// observation_boundary = "component-behavior"
// scope = "SessionTerminalの出力受信から実xtermの公開link provider／OSC 8 handlerとopenPathまで（OSブラウザー起動は対象外）"
// lifecycle = "permanent"
// impact = "PowerShell／WSLのWebリンクを開けない、通常の文字選択で意図せず外部へ移動する、または失敗を認識できない"
// distinction = "型検査やClipboard testでは実addonの出力検出とリンク操作の配送を確認できない。既存のJSDOMで小さな単一componentを検証する"
// @end-test-value
it("端末出力のWebリンクをCtrl＋左クリックで開き、失敗を表示する", async (context) => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    self: dom.window,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class { observe() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => ({
    measureText: () => ({ width: 8 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }) });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const opened: string[] = [];
  const writes: string[] = [];
  let openFailure: "result" | "throw" | undefined;
  let terminalId = "";
  let emit: Parameters<WithMateWindowTerminalApi["subscribeTerminalEvents"]>[0] | undefined;
  const api: WithMateWindowTerminalApi & Pick<WithMateWindowNavigationApi, "openPath"> = {
    openPath: async (target) => {
      opened.push(target);
      if (openFailure === "throw") throw new Error("Browser unavailable");
      if (openFailure === "result") return { status: "failed", targetType: "unknown", target, message: "Browser unavailable" };
      return { status: "opened", targetType: "external-url", target };
    },
    createTerminal: async (request) => { terminalId = request.terminalId; return { shellName: "PowerShell" }; },
    writeTerminalInput: (_id, data) => { writes.push(data); },
    resizeTerminal() {},
    acknowledgeTerminalOutput() {},
    closeTerminal: async () => true,
    releaseTerminal: async () => {},
    subscribeTerminalEvents: (listener) => { emit = listener; return () => { emit = undefined; }; },
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    const { Terminal: Xterm } = await import("@xterm/xterm");
    let terminal: Terminal | undefined;
    let provider: ILinkProvider | undefined;
    const open = Xterm.prototype.open;
    const registerLinkProvider = Xterm.prototype.registerLinkProvider;
    context.mock.method(Xterm.prototype, "open", function (this: Terminal, ...args: Parameters<Terminal["open"]>) {
      terminal = this;
      return open.apply(this, args);
    });
    context.mock.method(Xterm.prototype, "registerLinkProvider", function (this: Terminal, value: ILinkProvider) {
      provider = value;
      return registerLinkProvider.call(this, value);
    });
    await act(async () => { root.render(createElement(SessionTerminal, { api, expanded: true, onEmpty() {} })); });
    for (let attempt = 0; attempt < 100 && !terminalId; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    assert.notEqual(terminalId, "");
    assert.ok(terminal);
    assert.ok(provider, "the real web-links addon must register its public provider");
    assert.ok(emit);
    await act(async () => {
      emit!({ type: "data", terminalId, data: "PS> https://example.com/powershell\r\nWSL$ http://localhost:3000/wsl\r\n" });
      await new Promise<void>((resolve) => terminal!.write("", resolve));
    });
    const findLink = async (line: number) => {
      const links = await new Promise<ILink[] | undefined>((resolve) => provider!.provideLinks(line, resolve));
      assert.equal(links?.length, 1);
      return links![0];
    };
    const psLink = await findLink(1);
    const wslLink = await findLink(2);
    assert.equal(psLink.text, "https://example.com/powershell");
    assert.equal(wslLink.text, "http://localhost:3000/wsl");
    const activate = async (link: ILink, options: MouseEventInit) => {
      await act(async () => { link.activate(new dom.window.MouseEvent("click", options), link.text); });
    };
    for (const link of [psLink, wslLink]) {
      for (const options of [{ button: 0 }, { button: 1, ctrlKey: true }, { button: 2, ctrlKey: true }]) {
        await activate(link, options);
        assert.deepEqual(opened, []);
      }
    }
    await activate(psLink, { button: 0, ctrlKey: true });
    await activate(wslLink, { button: 0, ctrlKey: true });
    assert.deepEqual(opened, [psLink.text, wslLink.text]);
    assert.deepEqual(writes, [], "link activation must not send shell input");

    const oscHandler = terminal.options.linkHandler;
    assert.ok(oscHandler);
    const oscRange = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } };
    await act(async () => {
      oscHandler.activate(new dom.window.MouseEvent("click", { button: 0 }), psLink.text, oscRange);
      for (const target of ["file:///C:/local.txt", "javascript:alert(1)", "mailto:test@example.com"]) {
        oscHandler.activate(new dom.window.MouseEvent("click", { button: 0, ctrlKey: true }), target, oscRange);
      }
    });
    assert.equal(opened.length, 2);
    await act(async () => {
      oscHandler.activate(new dom.window.MouseEvent("click", { button: 0, ctrlKey: true }), "https://example.com/osc", oscRange);
    });
    assert.equal(opened.at(-1), "https://example.com/osc");

    for (const failure of ["result", "throw"] as const) {
      openFailure = failure;
      await activate(psLink, { button: 0, ctrlKey: true });
      assert.match(dom.window.document.querySelector('[role="alert"]')?.textContent ?? "", /Link could not be opened: Browser unavailable/);
    }
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Terminalは初回表示で作成され非表示でも維持される。矢印/Home/End選択はタブfocusを保ち、明示的な本文選択はxtermへfocusする。終了待機は対象だけにbusyを示し重複要求を防ぐ。終了失敗は対象を通知し原文の詳細入口を持ち、再試行は選択中でなく失敗した端末を閉じる。最後の終了成功だけonEmptyで通知する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: TerminalとAction Dock; docs/design/ui-design-guidelines.md: ボタンと操作、読込・空・失敗、アクセシビリティ" }
// fault = "非表示/再表示で端末を増減する、タブ移動キーをPTYへ送る、本文選択でfocusしない、終了待機の対象/busyを誤る、失敗詳細を失う、別端末を再試行で閉じる、重複終了する、または取消/失敗/残りタブと0件通知を誤対応する"
// observable = "createTerminal/releaseTerminal/closeTerminal/writeTerminalInputの対象と件数、activeElement、選択タブ、終了ボタンのbusy/spinner/disabled/操作名、終了失敗alertと関連付いたpopoverの原文、再試行対象、onEmptyの呼出回数"
// observation_boundary = "component-behavior"
// scope = "SessionTerminalの表示・複数タブのfocus・非同期終了のbusy・失敗詳細/再試行と0件通知"
// lifecycle = "permanent"
// impact = "意図しないシェル入力、終了待機の誤認、Prompt復帰の欠落、端末の喪失や不要な起動につながる"
// distinction = "既存の実component/xterm mountを再利用した有限操作列で継続コストを抑える。clipboard test、型検査、Main側の終了判定testはrendererのfocus意図・busy・再試行対象・タブ保持を検出しない。native popover開閉/focus復帰・実寸法/Tab順/描画はブラウザー確認が担う"
// @end-test-value
it("端末の表示と終了結果に応じてタブを保持し、最後の終了成功を通知する", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, self: dom.window,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => ({
    measureText: () => ({ width: 8 }), createLinearGradient: () => ({ addColorStop() {} }),
  }) });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const created: string[] = [];
  const released: string[] = [];
  const closed: string[] = [];
  const writes: Array<{ terminalId: string; data: string }> = [];
  let closeResult: boolean | Error | Promise<boolean> = true;
  let emptyCount = 0;
  const api: WithMateWindowTerminalApi & Pick<WithMateWindowNavigationApi, "openPath"> = {
    openPath: async (target) => ({ status: "opened", targetType: "external-url", target }),
    createTerminal: async ({ terminalId }) => { created.push(terminalId); return { shellName: "PowerShell" }; },
    writeTerminalInput: (terminalId, data) => { writes.push({ terminalId, data }); },
    resizeTerminal() {}, acknowledgeTerminalOutput() {},
    closeTerminal: async (id) => { closed.push(id); if (closeResult instanceof Error) throw closeResult; return closeResult; },
    releaseTerminal: async (id) => { released.push(id); },
    subscribeTerminalEvents: () => () => {},
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  const terminalRef = createRef<SessionTerminalHandle>();
  const render = async (expanded: boolean) => {
    await act(async () => root.render(createElement(SessionTerminal, { api, expanded, ref: terminalRef, onEmpty: () => { emptyCount++; } })));
  };
  const waitForCreated = async (count: number) => {
    for (let attempt = 0; attempt < 100 && created.length < count; attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    assert.equal(created.length, count, "terminal creation must complete");
  };
  const close = async (number: number) => {
    const button = dom.window.document.querySelector<HTMLButtonElement>(`[aria-label="Close Terminal ${number}"]`);
    assert.ok(button);
    await act(async () => button.click());
  };
  const press = async (key: string, modifiers: KeyboardEventInit = {}) => {
    const keyCodes: Record<string, number> = { Tab: 9, Enter: 13, End: 35, Home: 36, ArrowLeft: 37, ArrowRight: 39 };
    await act(async () => {
      dom.window.document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key, code: key, keyCode: keyCodes[key], bubbles: true, cancelable: true, ...modifiers,
      }));
    });
  };
  const selectedInput = () => dom.window.document.querySelector(".terminal-pane:not([hidden]) textarea");
  try {
    await render(false);
    assert.deepEqual(created, []);
    await render(true);
    await waitForCreated(1);
    assert.equal(dom.window.document.activeElement, selectedInput());
    const firstTab = dom.window.document.querySelector('[role="tab"]');
    await render(false);
    await render(true);
    assert.equal(dom.window.document.querySelector('[role="tab"]'), firstTab);
    assert.equal(created.length, 1);
    assert.deepEqual(released, []);
    assert.equal(dom.window.document.activeElement, selectedInput());

    closeResult = false;
    await close(1);
    assert.equal(dom.window.document.querySelector('[role="tab"]'), firstTab);
    assert.equal(emptyCount, 0);
    closeResult = new Error("Close unavailable");
    await close(1);
    assert.match(dom.window.document.querySelector('[role="alert"]')?.textContent ?? "", /Terminal 1 could not be closed/);
    const details = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Terminal 1 Close Error Details"]')!;
    assert.equal(details.getAttribute("aria-expanded"), "false");
    const popover = dom.window.document.getElementById(details.getAttribute("aria-controls")!);
    assert.equal(popover?.getAttribute("popover"), "auto");
    assert.match(popover?.textContent ?? "", /Terminal could not be closed: Error: Close unavailable/);
    assert.equal(dom.window.document.querySelector('[role="tab"]'), firstTab);
    assert.equal(emptyCount, 0);

    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="New Terminal"]')!.click());
    await waitForCreated(2);
    const tabButtons = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    assert.equal(dom.window.document.activeElement, selectedInput());
    closeResult = false;
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Retry Close Terminal 1"]')!.click());
    assert.equal(closed.at(-1), created[0], "retry targets the failed terminal, not the newly selected one");
    assert.equal(tabButtons[1].getAttribute("aria-selected"), "true");
    assert.deepEqual(released, [], "cancelled retry preserves both terminals");
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
    await press("Tab", { ctrlKey: true, shiftKey: true });
    assert.equal(dom.window.document.activeElement, tabButtons[1]);
    for (const [key, index] of [["ArrowLeft", 0], ["ArrowRight", 1], ["ArrowRight", 0], ["ArrowLeft", 1], ["Home", 0], ["End", 1], ["End", 1]] as const) {
      await press(key);
      assert.equal(tabButtons[index].getAttribute("aria-selected"), "true");
      assert.equal(dom.window.document.activeElement, tabButtons[index], key);
    }
    assert.deepEqual(writes, [], "tab navigation must not send input to the PTY");
    await act(async () => terminalRef.current!.focus());
    assert.equal(dom.window.document.activeElement, selectedInput(), "explicit Terminal mode focus enters the selected body");
    await act(async () => tabButtons[0].click());
    assert.equal(dom.window.document.activeElement, selectedInput(), "clicking another tab enters its body after activation");
    await press("Enter");
    assert.deepEqual(writes, [{ terminalId: created[0], data: "\r" }]);
    await press("Tab", { ctrlKey: true, shiftKey: true });
    await press("Home");
    await render(false);
    await render(true);
    assert.equal(dom.window.document.activeElement, selectedInput(), "same-tab navigation must not suppress focus on re-expansion");
    assert.equal(created.length, 2);
    assert.deepEqual(released, []);

    let settleClose!: (accepted: boolean) => void;
    closeResult = new Promise<boolean>((resolve) => { settleClose = resolve; });
    await close(1);
    const pendingClose = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Close Terminal 1"]')!;
    const otherClose = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Close Terminal 2"]')!;
    assert.equal(pendingClose.getAttribute("aria-busy"), "true");
    assert.ok(pendingClose.querySelector(".button-content-spinner"));
    assert.equal(pendingClose.textContent, "×", "the operation label remains reserved during busy");
    assert.equal(otherClose.getAttribute("aria-busy"), "false");
    assert.equal(otherClose.querySelector(".button-content-spinner"), null);
    assert.equal(pendingClose.disabled, true);
    assert.equal(otherClose.disabled, true);
    const closeCount = closed.length;
    await close(1);
    await close(2);
    assert.equal(closed.length, closeCount, "pending close cannot be duplicated");
    await act(async () => tabButtons[1].click());
    await press("Enter");
    assert.deepEqual(writes.at(-1), { terminalId: created[1], data: "\r" }, "another terminal remains usable during confirmation");
    await act(async () => settleClose(false));
    assert.equal(pendingClose.getAttribute("aria-busy"), "false");
    assert.equal(pendingClose.querySelector(".button-content-spinner"), null);
    assert.equal(pendingClose.disabled, false);
    assert.equal(otherClose.disabled, false);
    assert.equal(dom.window.document.querySelectorAll('[role="tab"]').length, 2);
    assert.equal(emptyCount, 0);
    closeResult = true;
    await close(1);
    assert.equal(dom.window.document.querySelectorAll('[role="tab"]').length, 1);
    assert.deepEqual(released, [created[0]]);
    assert.equal(emptyCount, 0);
    await close(2);
    assert.equal(dom.window.document.querySelectorAll('[role="tab"]').length, 0);
    assert.deepEqual(released, created);
    assert.equal(emptyCount, 1);

    // Prompt remains selected in the consumer, so dock expansion keeps Terminal hidden.
    await render(false);
    await render(false);
    assert.equal(created.length, 2);
    assert.equal(emptyCount, 1);
    // Explicitly selecting Terminal again can start a new shell.
    await render(true);
    await waitForCreated(3);
    assert.equal(dom.window.document.querySelectorAll('[role="tab"]').length, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
