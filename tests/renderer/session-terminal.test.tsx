import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { Terminal } from "@xterm/xterm";
import type { WithMateWindowTerminalApi } from "../../src-shared/ipc/withmate-window-api.js";
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
  const api: WithMateWindowTerminalApi = {
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
