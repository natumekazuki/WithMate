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
// claim = "選択中のCtrl+CとCtrl+Shift+Cは選択文字を一度コピーしてPTYへ入力せず、選択なしのCtrl+CはETXを送る"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 組み込みTerminalの入力とコピー" }
// fault = "Shiftをコピーの必須条件にする、コピー時もPTYへキーを渡す、または選択なしでもCtrl+Cを横取りする"
// observable = "clipboard.writeTextの引数と回数、writeTerminalInputの引数、keydown.defaultPrevented"
// observation_boundary = "component-behavior"
// scope = "SessionTerminalの実xtermキーボード入力からclipboardとTerminal APIまで"
// lifecycle = "permanent"
// impact = "コピー操作で実行中のコマンドを意図せず中断する、または端末の割り込み操作ができなくなる"
// distinction = "既存shortcut dispatcher testと型検査ではxtermのselectionとコピー・PTY配送の分岐を検証できない"
// @end-test-value
it("端末のCtrl+Cは選択があればコピーし、なければシェルへ渡す", async (context) => {
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
  const copies: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: {
    writeText: async (text: string) => { copies.push(text); },
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
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
