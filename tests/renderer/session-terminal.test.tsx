import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import type { WithMateWindowNavigationApi, WithMateWindowTerminalApi } from "../../src-shared/ipc/withmate-window-api.js";
import { SessionTerminal } from "../../src/terminal/session-terminal.js";

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
    await act(async () => { root.render(createElement(SessionTerminal, { api, expanded: true, onCollapse() {} })); });
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
    await act(async () => { root.render(createElement(SessionTerminal, { api, expanded: true, onCollapse() {} })); });
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
