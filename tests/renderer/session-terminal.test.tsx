import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import type {
  WithMateWindowNavigationApi,
  WithMateWindowTerminalApi,
} from "../../src-shared/ipc/withmate-window-api.js";
import {
  SessionTerminal,
  type SessionTerminalHandle,
} from "../../src/terminal/session-terminal.js";

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
/** Windows の貼り付けと選択時コピーをクリップボードへ送る一方、選択なしの割り込みや非 Windows の Ctrl+V は PTY に残すことを確認する。 */
it("端末のClipboard操作とシェルへの制御入力を分離する", async (context) => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
    pretendToBeVisual: true,
  });
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
    ResizeObserver: class {
      observe /** サイズ測定の購読は受け付けるが、このキー入力試験では再サイズを通知しない。 */() {}
      disconnect /** 実監視を開始していないため、解除時に片付けるものはない。 */() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(dom.window, "matchMedia", {
    /** JSDOM にないメディア照会を、一致しない固定結果で補う。 */ value:
      () => ({
        matches: false,
        /** 旧式のメディア照会購読は保持しない。 */ addListener() {},
        /** 保持していない旧式のリスナーは削除不要。 */ removeListener() {},
        /** 表示条件を変更しないため現行イベントを登録しない。 */ addEventListener() {},
        /** 解除時に処分する現行イベントの登録はない。 */ removeEventListener() {},
      }),
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    /** xterm の文字レイアウトに必要な最小の Canvas context を返す。 */ value:
      () => ({
        /** 選択したセル位置が安定するよう文字幅を固定する。 */
        measureText: () => ({ width: 8 }),
        /** Canvas の勾配を要求されても描画しないスタブを返す。 */ createLinearGradient:
          () => ({
            /** 色指定を受け付けるが DOM 上には描画しない。 */ addColorStop() {},
          }),
      }),
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(dom.window.navigator, "platform", {
    configurable: true,
    value: "Win32",
  });
  const copies: string[] = [];
  let reads = 0;
  let clipboardError: Error | undefined;
  const clipboardText = "paste 日本語";
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: {
      /** システムの Clipboard を使わず、選択コピーが渡した文字列を記録する。 */
      writeText: async (text: string) => {
        copies.push(text);
      },
      /** 貼り付け1回あたりの読取を数え、指定時はクリップボード障害を発生させる。 */
      readText: async () => {
        reads++;
        if (clipboardError) throw clipboardError;
        return clipboardText;
      },
    },
  });
  const writes: Array<{ terminalId: string; data: string }> = [];
  let terminalId = "";
  const api: WithMateWindowTerminalApi &
    Pick<WithMateWindowNavigationApi, "openPath"> = {
    /** リンクを扱わないため OS に渡さず、成功形だけ返す。 */
    openPath: async (target) => ({
      status: "opened",
      targetType: "external-url",
      target,
    }),
    /** 入力の配送先と比較する端末 ID を採取し、PowerShell の端末として開く。 */
    createTerminal: async (request) => {
      terminalId = request.terminalId;
      return { shellName: "PowerShell" };
    },
    /** 実 PTY に書かず、クリップボード文字列か制御入力かを照合できるよう記録する。 */
    writeTerminalInput: (id, data) => {
      writes.push({ terminalId: id, data });
    },
    /** シェル側のサイズ変更を行わず、キー処理の配送だけを観測する。 */
    resizeTerminal() {},
    /** 送信できる端末出力を模擬していないので受領通知は不要。 */
    acknowledgeTerminalOutput() {},
    /** 後片付け時の端末終了要求を受け入れる。 */
    closeTerminal: async () => true,
    /** 実端末を持たないため、解放時にリソースは変更しない。 */
    releaseTerminal: async () => {},
    /** 端末出力は xterm に直接書くため、Main からのイベントを登録しない。 */
    subscribeTerminalEvents: () => () => {},
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    // キー処理や選択の挙動を置き換えず、公開 API を通じて実際のインスタンスを取得する。
    const { Terminal: Xterm } = await import("@xterm/xterm");
    let terminal: Terminal | undefined;
    const open = Xterm.prototype.open;
    context.mock.method(
      Xterm.prototype,
      "open",
      function (this: Terminal, ...args: Parameters<Terminal["open"]>) {
        terminal = this;
        return open.apply(this, args);
      },
    );
    await act(async () => {
      root.render(
        createElement(SessionTerminal, {
          api,
          expanded: true,
          /** タブ件数の通知はこの Clipboard 試験の観測対象にしない。 */ onEmpty() {},
        }),
      );
    });
    for (let attempt = 0; attempt < 100 && !terminalId; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    assert.notEqual(terminalId, "", "terminal creation must complete");
    assert.ok(terminal);
    await act(async () => {
      await new Promise<void>((resolve) =>
        terminal!.write("prefix 選択文字 suffix", resolve),
      );
    });
    const input = dom.window.document.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    assert.ok(input);
    input.focus();
    for (const shiftKey of [false, true]) {
      terminal.select(7, 0, 8);
      assert.equal(terminal.getSelection(), "選択文字");
      const keydown = new dom.window.KeyboardEvent("keydown", {
        key: shiftKey ? "C" : "c",
        code: "KeyC",
        keyCode: 67,
        ctrlKey: true,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        input.dispatchEvent(keydown);
        input.dispatchEvent(
          new dom.window.KeyboardEvent("keyup", {
            key: shiftKey ? "C" : "c",
            code: "KeyC",
            keyCode: 67,
            ctrlKey: true,
            shiftKey,
            bubbles: true,
          }),
        );
      });
      assert.equal(keydown.defaultPrevented, true);
      assert.deepEqual(writes, []);
    }
    assert.deepEqual(copies, ["選択文字", "選択文字"]);

    terminal.clearSelection();
    await act(async () => {
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "c",
          code: "KeyC",
          keyCode: 67,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.deepEqual(writes, [{ terminalId, data: "\u0003" }]);
    assert.deepEqual(copies, ["選択文字", "選択文字"]);

    /** Shift の有無を指定して貼り付けキーを発火し、既定動作を抑止したか調べるため keydown を返す。 */
    const pressPaste = async (shiftKey: boolean) => {
      const keydown = new dom.window.KeyboardEvent("keydown", {
        key: shiftKey ? "V" : "v",
        code: "KeyV",
        keyCode: 86,
        ctrlKey: true,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        input.dispatchEvent(keydown);
        input.dispatchEvent(
          new dom.window.KeyboardEvent("keyup", {
            key: shiftKey ? "V" : "v",
            code: "KeyV",
            keyCode: 86,
            ctrlKey: true,
            shiftKey,
            bubbles: true,
          }),
        );
      });
      return keydown;
    };
    // ブラケット付きペーストモードはプラットフォームの判定ではなく、シェルの出力によって切り替わる。
    for (const bracketed of [false, true, false]) {
      await act(async () => {
        await new Promise<void>((resolve) =>
          terminal!.write(`\x1b[?2004${bracketed ? "h" : "l"}`, resolve),
        );
      });
      for (const shiftKey of [false, true]) {
        writes.length = 0;
        const beforeReads = reads;
        const event = await pressPaste(shiftKey);
        assert.equal(event.defaultPrevented, true);
        assert.equal(
          reads,
          beforeReads + 1,
          "each key chord reads the Clipboard once",
        );
        assert.deepEqual(writes, [
          {
            terminalId,
            data: bracketed
              ? `\x1b[200~${clipboardText}\x1b[201~`
              : clipboardText,
          },
        ]);
      }
    }

    for (const platform of ["MacIntel", "Linux x86_64"]) {
      Object.defineProperty(dom.window.navigator, "platform", {
        configurable: true,
        value: platform,
      });
      writes.length = 0;
      const beforeReads = reads;
      await pressPaste(false);
      assert.equal(reads, beforeReads);
      assert.deepEqual(writes, [{ terminalId, data: "\u0016" }]);
    }

    Object.defineProperty(dom.window.navigator, "platform", {
      configurable: true,
      value: "Win32",
    });
    clipboardError = new Error("Clipboard unavailable");
    writes.length = 0;
    await pressPaste(false);
    assert.deepEqual(writes, []);
    assert.match(
      dom.window.document.querySelector('[role="alert"]')?.textContent ?? "",
      /Paste failed:.*Clipboard unavailable/,
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
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
/** 実 xterm の Web リンクと OSC 8 を Ctrl＋左クリックでのみ開き、許可されない URI や通常クリックは開かず、失敗を alert に出すことを確認する。 */
it("端末出力のWebリンクをCtrl＋左クリックで開き、失敗を表示する", async (context) => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
    pretendToBeVisual: true,
  });
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
    ResizeObserver: class {
      observe /** 出力にあるリンクを解析する間、リサイズ通知のない Observer を使う。 */() {}
      disconnect /** 通知を登録していないため Observer の切断は不要。 */() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(dom.window, "matchMedia", {
    /** xterm に変化のないメディア設定を供給する。 */ value: () => ({
      matches: false,
      /** 旧式メディア照会の変更は通知しない。 */ addListener() {},
      /** 旧式の購読を保持しないため削除しない。 */ removeListener() {},
      /** リンク試験中にメディア条件は変わらず、変更通知を登録しない。 */ addEventListener() {},
      /** 保持していないメディアイベントを解除しない。 */ removeEventListener() {},
    }),
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    /** JSDOM で Canvas を必要とする xterm の初期化を可能にする。 */ value:
      () => ({
        /** 行の列位置を安定させる固定文字幅を返す。 */
        measureText: () => ({ width: 8 }),
        /** リンク検出に不要な Canvas の勾配描画を模擬する。 */ createLinearGradient:
          () => ({
            /** 勾配の色は出力文字のリンク判定に使わない。 */ addColorStop() {},
          }),
      }),
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const opened: string[] = [];
  const writes: string[] = [];
  let openFailure: "result" | "throw" | undefined;
  let terminalId = "";
  let emit:
    | Parameters<WithMateWindowTerminalApi["subscribeTerminalEvents"]>[0]
    | undefined;
  const api: WithMateWindowTerminalApi &
    Pick<WithMateWindowNavigationApi, "openPath"> = {
    /** 開こうとした URI を記録し、OS を起動せず結果の失敗と例外を切り替える。 */
    openPath: async (target) => {
      opened.push(target);
      if (openFailure === "throw") throw new Error("Browser unavailable");
      if (openFailure === "result")
        return {
          status: "failed",
          targetType: "unknown",
          target,
          message: "Browser unavailable",
        };
      return { status: "opened", targetType: "external-url", target };
    },
    /** イベントで出力を届ける先の端末 ID を把握し、PowerShell 起動済みとして返す。 */
    createTerminal: async (request) => {
      terminalId = request.terminalId;
      return { shellName: "PowerShell" };
    },
    /** リンク操作がシェル入力を発生させていないか確認できるようデータを記録する。 */
    writeTerminalInput: (_id, data) => {
      writes.push(data);
    },
    /** 出力を送る端末のサイズを実際のシェルへ伝える必要はない。 */
    resizeTerminal() {},
    /** 試験で直接供給した出力に対し受領処理は行わない。 */
    acknowledgeTerminalOutput() {},
    /** 終了時の端末クローズを成功として扱う。 */
    closeTerminal: async () => true,
    /** OS 側に割り当てた端末がないため解放時は何もしない。 */
    releaseTerminal: async () => {},
    /** 実 UI の購読先に出力を手動で届けられるよう保存し、購読解除で捨てる。 */
    subscribeTerminalEvents: (listener) => {
      emit = listener;
      return () => {
        emit = undefined;
      };
    },
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    const { Terminal: Xterm } = await import("@xterm/xterm");
    let terminal: Terminal | undefined;
    let provider: ILinkProvider | undefined;
    const open = Xterm.prototype.open;
    const registerLinkProvider = Xterm.prototype.registerLinkProvider;
    context.mock.method(
      Xterm.prototype,
      "open",
      function (this: Terminal, ...args: Parameters<Terminal["open"]>) {
        terminal = this;
        return open.apply(this, args);
      },
    );
    context.mock.method(
      Xterm.prototype,
      "registerLinkProvider",
      function (this: Terminal, value: ILinkProvider) {
        provider = value;
        return registerLinkProvider.call(this, value);
      },
    );
    await act(async () => {
      root.render(
        createElement(SessionTerminal, {
          api,
          expanded: true,
          /** リンク操作の試験では端末一覧が空になった通知を使わない。 */ onEmpty() {},
        }),
      );
    });
    for (let attempt = 0; attempt < 100 && !terminalId; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    assert.notEqual(terminalId, "");
    assert.ok(terminal);
    assert.ok(
      provider,
      "the real web-links addon must register its public provider",
    );
    assert.ok(emit);
    await act(async () => {
      emit!({
        type: "data",
        terminalId,
        data: "PS> https://example.com/powershell\r\nWSL$ http://localhost:3000/wsl\r\n",
      });
      await new Promise<void>((resolve) => terminal!.write("", resolve));
    });
    /** 実リンクプロバイダーに指定行を解析させ、検出された唯一のリンクを返す。 */
    const findLink = async (line: number) => {
      const links = await new Promise<ILink[] | undefined>((resolve) =>
        provider!.provideLinks(line, resolve),
      );
      assert.equal(links?.length, 1);
      return links![0];
    };
    const psLink = await findLink(1);
    const wslLink = await findLink(2);
    assert.equal(psLink.text, "https://example.com/powershell");
    assert.equal(wslLink.text, "http://localhost:3000/wsl");
    /** 修飾キーとマウスボタンを変えて実リンクの操作を呼び、非同期の画面反映まで待つ。 */
    const activate = async (link: ILink, options: MouseEventInit) => {
      await act(async () => {
        link.activate(new dom.window.MouseEvent("click", options), link.text);
      });
    };
    for (const link of [psLink, wslLink]) {
      for (const options of [
        { button: 0 },
        { button: 1, ctrlKey: true },
        { button: 2, ctrlKey: true },
      ]) {
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
      oscHandler.activate(
        new dom.window.MouseEvent("click", { button: 0 }),
        psLink.text,
        oscRange,
      );
      for (const target of [
        "file:///C:/local.txt",
        "javascript:alert(1)",
        "mailto:test@example.com",
      ]) {
        oscHandler.activate(
          new dom.window.MouseEvent("click", { button: 0, ctrlKey: true }),
          target,
          oscRange,
        );
      }
    });
    assert.equal(opened.length, 2);
    await act(async () => {
      oscHandler.activate(
        new dom.window.MouseEvent("click", { button: 0, ctrlKey: true }),
        "https://example.com/osc",
        oscRange,
      );
    });
    assert.equal(opened.at(-1), "https://example.com/osc");

    for (const failure of ["result", "throw"] as const) {
      openFailure = failure;
      await activate(psLink, { button: 0, ctrlKey: true });
      assert.match(
        dom.window.document.querySelector('[role="alert"]')?.textContent ?? "",
        /Link could not be opened: Browser unavailable/,
      );
    }
  } finally {
    await act(async () => {
      root.unmount();
    });
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
/** 初回表示と再展開、タブの選択と入力フォーカス、終了中・取消・失敗・再試行を通し、最後の終了成功時だけ空を通知することを確認する。 */
it("端末の表示と終了結果に応じてタブを保持し、最後の終了成功を通知する", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
    pretendToBeVisual: true,
  });
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
    ResizeObserver: class {
      observe /** 表示の切替だけを明示的に進め、サイズ監視から更新を発火しない。 */() {}
      disconnect /** 登録した監視対象がないため、端末が消えた時の解除は何もしない。 */() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(dom.window, "matchMedia", {
    /** タブの状態試験をブラウザーのメディア条件に依存させない。 */ value:
      () => ({
        matches: false,
        /** 旧式メディアクエリのリスナーを登録しない。 */ addListener() {},
        /** 登録していない旧式の購読は解除しない。 */ removeListener() {},
        /** タブの表示条件を変えるメディア通知は送らない。 */ addEventListener() {},
        /** メディア通知の登録資源はない。 */ removeEventListener() {},
      }),
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    /** タブごとの xterm 初期化に必要な Canvas の形だけを用意する。 */ value:
      () => ({
        /** 全端末で測定された文字幅を同じ値に固定する。 */ measureText:
          () => ({ width: 8 }),
        /** Canvas の勾配は描画せず色設定の入口だけ返す。 */ createLinearGradient:
          () => ({
            /** フォーカスや閉じる操作の比較では描画色を適用しない。 */ addColorStop() {},
          }),
      }),
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const created: string[] = [];
  const released: string[] = [];
  const closed: string[] = [];
  const writes: Array<{ terminalId: string; data: string }> = [];
  let closeResult: boolean | Error | Promise<boolean> = true;
  let emptyCount = 0;
  const api: WithMateWindowTerminalApi &
    Pick<WithMateWindowNavigationApi, "openPath"> = {
    /** このタブ試験からはブラウザーを起動せず、リンクを開く API の形だけ満たす。 */
    openPath: async (target) => ({
      status: "opened",
      targetType: "external-url",
      target,
    }),
    /** 端末作成の ID を順に保存し、再展開による重複作成と終了対象を照合できるようにする。 */
    createTerminal: async ({ terminalId }) => {
      created.push(terminalId);
      return { shellName: "PowerShell" };
    },
    /** キー入力が選択した端末だけに配送され、タブ移動が PTY 入力にならないか検査できるよう記録する。 */
    writeTerminalInput: (terminalId, data) => {
      writes.push({ terminalId, data });
    },
    /** タブの lifecycle だけを扱うためバックエンドのリサイズを行わない。 */ resizeTerminal() {},
    /** 端末データを配信しないため受領の記録は不要。 */ acknowledgeTerminalOutput() {},
    /** 閉じる要求の対象を保存し、試験用に指定した成功・取消・例外・保留を返す。 */
    closeTerminal: async (id) => {
      closed.push(id);
      if (closeResult instanceof Error) throw closeResult;
      return closeResult;
    },
    /** 正常終了で破棄された端末の ID を保存する。 */
    releaseTerminal: async (id) => {
      released.push(id);
    },
    /** 終了は close の応答で操作するため、端末側から独立した通知を配信しない。 */
    subscribeTerminalEvents: () => () => {},
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  const terminalRef = createRef<SessionTerminalHandle>();
  /** 端末コンポーネントを同じ root で展開または折りたたみ、フォーカス変更を反映する。 */
  const render = async (expanded: boolean) => {
    await act(async () =>
      root.render(
        createElement(SessionTerminal, {
          api,
          expanded,
          ref: terminalRef,
          /** 最後の端末が消えた通知の回数を数える。 */ onEmpty: () => {
            emptyCount++;
          },
        }),
      ),
    );
  };
  /** 非同期で要求される端末の作成数が期待値に達するまで待ち、超過も失敗にする。 */
  const waitForCreated = async (count: number) => {
    for (let attempt = 0; attempt < 100 && created.length < count; attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    assert.equal(created.length, count, "terminal creation must complete");
  };
  /** 指定した番号の端末の閉じるボタンを押し、同期的な画面反映を待つ。 */
  const close = async (number: number) => {
    const button = dom.window.document.querySelector<HTMLButtonElement>(
      `[aria-label="Close Terminal ${number}"]`,
    );
    assert.ok(button);
    await act(async () => button.click());
  };
  /** その時点でフォーカスされたタブまたは本文へキーを送り、ナビゲーションと PTY 入力の作用を分ける。 */
  const press = async (key: string, modifiers: KeyboardEventInit = {}) => {
    const keyCodes: Record<string, number> = {
      Tab: 9,
      Enter: 13,
      End: 35,
      Home: 36,
      ArrowLeft: 37,
      ArrowRight: 39,
    };
    await act(async () => {
      dom.window.document.activeElement!.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key,
          code: key,
          keyCode: keyCodes[key],
          bubbles: true,
          cancelable: true,
          ...modifiers,
        }),
      );
    });
  };
  /** 非表示の端末を除き、現在の本文入力欄を取得してフォーカス先と比較する。 */
  const selectedInput = () =>
    dom.window.document.querySelector(".terminal-pane:not([hidden]) textarea");
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
    assert.match(
      dom.window.document.querySelector('[role="alert"]')?.textContent ?? "",
      /Terminal 1 could not be closed/,
    );
    const details = dom.window.document.querySelector<HTMLButtonElement>(
      '[aria-label="Terminal 1 Close Error Details"]',
    )!;
    assert.equal(details.getAttribute("aria-expanded"), "false");
    const popover = dom.window.document.getElementById(
      details.getAttribute("aria-controls")!,
    );
    assert.equal(popover?.getAttribute("popover"), "auto");
    assert.match(
      popover?.textContent ?? "",
      /Terminal could not be closed: Error: Close unavailable/,
    );
    assert.equal(dom.window.document.querySelector('[role="tab"]'), firstTab);
    assert.equal(emptyCount, 0);

    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>('[aria-label="New Terminal"]')!
        .click(),
    );
    await waitForCreated(2);
    const tabButtons = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    assert.equal(dom.window.document.activeElement, selectedInput());
    closeResult = false;
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Retry Close Terminal 1"]',
        )!
        .click(),
    );
    assert.equal(
      closed.at(-1),
      created[0],
      "retry targets the failed terminal, not the newly selected one",
    );
    assert.equal(tabButtons[1].getAttribute("aria-selected"), "true");
    assert.deepEqual(released, [], "cancelled retry preserves both terminals");
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
    await press("Tab", { ctrlKey: true, shiftKey: true });
    assert.equal(dom.window.document.activeElement, tabButtons[1]);
    for (const [key, index] of [
      ["ArrowLeft", 0],
      ["ArrowRight", 1],
      ["ArrowRight", 0],
      ["ArrowLeft", 1],
      ["Home", 0],
      ["End", 1],
      ["End", 1],
    ] as const) {
      await press(key);
      assert.equal(tabButtons[index].getAttribute("aria-selected"), "true");
      assert.equal(dom.window.document.activeElement, tabButtons[index], key);
    }
    assert.deepEqual(
      writes,
      [],
      "tab navigation must not send input to the PTY",
    );
    await act(async () => terminalRef.current!.focus());
    assert.equal(
      dom.window.document.activeElement,
      selectedInput(),
      "explicit Terminal mode focus enters the selected body",
    );
    await act(async () => tabButtons[0].click());
    assert.equal(
      dom.window.document.activeElement,
      selectedInput(),
      "clicking another tab enters its body after activation",
    );
    await press("Enter");
    assert.deepEqual(writes, [{ terminalId: created[0], data: "\r" }]);
    await press("Tab", { ctrlKey: true, shiftKey: true });
    await press("Home");
    await render(false);
    await render(true);
    assert.equal(
      dom.window.document.activeElement,
      selectedInput(),
      "same-tab navigation must not suppress focus on re-expansion",
    );
    assert.equal(created.length, 2);
    assert.deepEqual(released, []);

    let settleClose!: (accepted: boolean) => void;
    closeResult = new Promise<boolean>((resolve) => {
      settleClose = resolve;
    });
    await close(1);
    const pendingClose = dom.window.document.querySelector<HTMLButtonElement>(
      '[aria-label="Close Terminal 1"]',
    )!;
    const otherClose = dom.window.document.querySelector<HTMLButtonElement>(
      '[aria-label="Close Terminal 2"]',
    )!;
    assert.equal(pendingClose.getAttribute("aria-busy"), "true");
    assert.ok(pendingClose.querySelector(".button-content-spinner"));
    assert.equal(
      pendingClose.textContent,
      "×",
      "the operation label remains reserved during busy",
    );
    assert.equal(otherClose.getAttribute("aria-busy"), "false");
    assert.equal(otherClose.querySelector(".button-content-spinner"), null);
    assert.equal(pendingClose.disabled, true);
    assert.equal(otherClose.disabled, true);
    const closeCount = closed.length;
    await close(1);
    await close(2);
    assert.equal(
      closed.length,
      closeCount,
      "pending close cannot be duplicated",
    );
    await act(async () => tabButtons[1].click());
    await press("Enter");
    assert.deepEqual(
      writes.at(-1),
      { terminalId: created[1], data: "\r" },
      "another terminal remains usable during confirmation",
    );
    await act(async () => settleClose(false));
    assert.equal(pendingClose.getAttribute("aria-busy"), "false");
    assert.equal(pendingClose.querySelector(".button-content-spinner"), null);
    assert.equal(pendingClose.disabled, false);
    assert.equal(otherClose.disabled, false);
    assert.equal(
      dom.window.document.querySelectorAll('[role="tab"]').length,
      2,
    );
    assert.equal(emptyCount, 0);
    closeResult = true;
    await close(1);
    assert.equal(
      dom.window.document.querySelectorAll('[role="tab"]').length,
      1,
    );
    assert.deepEqual(released, [created[0]]);
    assert.equal(emptyCount, 0);
    await close(2);
    assert.equal(
      dom.window.document.querySelectorAll('[role="tab"]').length,
      0,
    );
    assert.deepEqual(released, created);
    assert.equal(emptyCount, 1);

    // 利用側では Prompt の選択が維持されるため、ドックを展開しても Terminal は非表示のままになる。
    await render(false);
    await render(false);
    assert.equal(created.length, 2);
    assert.equal(emptyCount, 1);
    // Terminal を改めて明示的に選ぶと、新しいシェルを起動できる。
    await render(true);
    await waitForCreated(3);
    assert.equal(
      dom.window.document.querySelectorAll('[role="tab"]').length,
      1,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
