import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IpcMain, IpcMainEvent } from "electron";
import { registerTerminalHandlers } from "../../src-electron/ipc/terminal.js";
import { WITHMATE_RESIZE_TERMINAL_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import { TerminalService, type TerminalOwner } from "../../src-electron/terminal/terminal-service.js";
import type { TerminalPty } from "../../src-electron/terminal/utility-terminal-pty.js";

class StubWindow implements TerminalOwner {
  id = 1;
  destroyed = false;
  events: unknown[] = [];
  listeners = new Map<string, Array<(details: { isMainFrame?: boolean; isSameDocument?: boolean }) => void>>();
  webContents = {
    isDestroyed: () => this.destroyed,
    send: (_channel: string, event: unknown) => this.events.push(event),
    on: (name: string, listener: (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => void) => {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    },
  };
  isDestroyed(): boolean { return this.destroyed; }
  on(name: "closed", listener: () => void): void { this.webContents.on(name, listener); }
  emit(name: string): void { for (const listener of this.listeners.get(name) ?? []) listener({}); }
}

const TERMINAL_ID = "87263983-5b1d-4b5d-8f08-2b04899dbb8d";

function setup() {
  const window = new StubWindow();
  const other = new StubWindow();
  other.id = 2;
  const pty = {
    writes: [] as string[],
    resizes: [] as Array<[number, number]>,
    kills: 0,
    pauses: 0,
    resumes: 0,
    data: (_value: string) => {},
    exit: (_value: { exitCode: number; signal?: number }) => {},
    error: (_value: Error) => {},
    onData(listener: (value: string) => void) { this.data = listener; return { dispose() {} }; },
    onExit(listener: (value: { exitCode: number; signal?: number }) => void) { this.exit = listener; return { dispose() {} }; },
    onError(listener: (error: Error) => void) { this.error = listener; return { dispose() {} }; },
    write(value: string) { this.writes.push(value); },
    resize(cols: number, rows: number) { this.resizes.push([cols, rows]); },
    kill() { this.kills++; },
    pause() { this.pauses++; },
    resume() { this.resumes++; },
  };
  let confirm = false;
  const spawns: Array<[number, number]> = [];
  const service = new TerminalService({
    resolveOwner(sender) {
      if (sender === "owner" || (sender as { sender?: unknown })?.sender === window.webContents) return { window, sessionId: "session-a", workspacePath: "C:/saved path " };
      if (sender === "other") return { window: other, sessionId: "session-b", workspacePath: "C:/other" };
      return null;
    },
    confirmClose: () => confirm,
    sendEvent: (owner, event) => owner.webContents.send("terminal", event),
    spawn: async (_file, cwd, cols, rows) => {
      assert.equal(cwd, "C:/saved path ");
      spawns.push([cols, rows]);
      return pty as unknown as TerminalPty;
    },
    resolveShell: async () => ({ file: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", shellName: "PowerShell" }),
  });
  return { window, other, pty, service, spawns, approveClose: () => { confirm = true; } };
}

describe("TerminalService", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "通常fitの大きな寸法はcreateとresizeでPTYへ渡り、native整数範囲外の寸法は生存PTYを保持して拒否する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "500列・300行で正常なfitを拒否するか、不正寸法をPTYへ渡す"
  // observable = "spawn寸法、PTY resize列、拒否後のlive数と入力"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service geometry"
  // lifecycle = "permanent"
  // @end-test-value
  it("accepts large fitted dimensions and rejects invalid native coordinates without ending the PTY", async () => {
    const { service, pty, window, spawns } = setup();
    await service.create("owner", { terminalId: TERMINAL_ID, cols: 625, rows: 400 });
    assert.deepEqual(spawns, [[625, 400]]);
    service.resize("owner", TERMINAL_ID, 1_000, 350);
    service.resize("owner", TERMINAL_ID, 32_767, 1);
    for (const [cols, rows] of [[0, 24], [80, -1], [80.5, 24], [80, NaN], [Infinity, 24], [32_768, 24], [80, 32_768]]) {
      assert.throws(() => service.resize("owner", TERMINAL_ID, cols, rows), /Terminal size is invalid/);
    }
    assert.deepEqual(pty.resizes, [[1_000, 350], [32_767, 1]]);
    assert.equal(service.countLive(window), 1);
    service.write("owner", TERMINAL_ID, "still running");
    assert.deepEqual(pty.writes, ["still running"]);
    const rejected = setup();
    await assert.rejects(rejected.service.create("owner", { terminalId: TERMINAL_ID, cols: 32_768, rows: 24 }), /Terminal size is invalid/);
    assert.deepEqual(rejected.spawns, []);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "IPCの操作拒否はoperation-errorで通知し生存PTYを維持し、PTY障害はerror通知とlive除外を行う"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "resize検証の拒否をPTY障害としてrendererへ通知する"
  // observable = "登録済みIPC handlerが送るevent種別、後続resizeと入力、host障害後のlive数"
  // observation_boundary = "public-boundary"
  // scope = "terminal IPC operation failure"
  // lifecycle = "permanent"
  // @end-test-value
  it("distinguishes rejected IPC operations from fatal PTY errors", async () => {
    const { service, pty, window } = setup();
    const listeners = new Map<string, (event: IpcMainEvent, id: string, cols: number, rows: number) => void>();
    registerTerminalHandlers({
      handle() {},
      on(channel, listener) { listeners.set(channel, listener); return this as IpcMain; },
    } as Pick<IpcMain, "handle" | "on"> as IpcMain, service);
    await service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
    const resize = listeners.get(WITHMATE_RESIZE_TERMINAL_CHANNEL)!;
    const event = { sender: window.webContents } as unknown as IpcMainEvent;
    resize(event, TERMINAL_ID, 0, 24);
    assert.deepEqual(window.events, [{ type: "operation-error", terminalId: TERMINAL_ID, message: "Terminal size is invalid." }]);
    assert.equal(service.countLive(window), 1);
    resize(event, TERMINAL_ID, 625, 350);
    service.write("owner", TERMINAL_ID, "recovered");
    assert.deepEqual(pty.resizes, [[625, 350]]);
    assert.deepEqual(pty.writes, ["recovered"]);
    pty.error(new Error("host failed"));
    assert.deepEqual(window.events.at(-1), { type: "error", terminalId: TERMINAL_ID, message: "host failed" });
    assert.equal(service.countLive(window), 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "端末を作成したSession Window以外から入力・resize・終了を実行できない"
  // oracle = { type = "contract", ref = "Issue #740 権限・エラーの境界" }
  // fault = "terminal IDだけを照合し、IPC senderのWindow所有を照合しない"
  // observable = "他Windowからの操作の拒否と元のPTYの入力・resize・kill件数"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "別Windowのrendererがユーザーのシェルへ入力・終了できる"
  // distinction = "型検査はIPC senderの実行時所有関係を保証しない"
  // @end-test-value
  it("binds every operation to the sender's Session Window", async () => {
    const { service, pty } = setup();
    await service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
    assert.throws(() => service.write("other", TERMINAL_ID, "bad"));
    assert.throws(() => service.resize("other", TERMINAL_ID, 100, 30));
    assert.throws(() => service.close("other", TERMINAL_ID));
    assert.throws(() => service.release("other", TERMINAL_ID));
    assert.deepEqual(pty.writes, []);
    assert.deepEqual(pty.resizes, []);
    assert.equal(pty.kills, 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "生存中PTYのClose取消は保持し、renderer破棄は確認なしでPTYを終了する"
  // oracle = { type = "contract", ref = "Issue #740 生存期間と終了" }
  // fault = "確認取消時にPTYをkillするかrenderer破棄後にPTYを残す"
  // observable = "Close戻り値とPTY kill件数、残る端末数"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "利用者作業の意図しない停止または孤立したシェルの存続"
  // distinction = "型検査と通常のWindow close testはPTY所有物の解放を観測しない"
  // @end-test-value
  it("keeps a cancelled close and releases the PTY when its renderer is destroyed", async () => {
    const { service, pty, window } = setup();
    await service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
    assert.equal(service.close("owner", TERMINAL_ID), false);
    assert.equal(service.countLive(window), 1);
    assert.equal(pty.kills, 0);
    window.destroyed = true;
    window.emit("destroyed");
    assert.equal(service.countLive(window), 0);
    assert.equal(pty.kills, 1);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "出力の未処理量が上限に達するとPTYを一時停止し、ackによって下限以下になると再開する"
  // oracle = { type = "contract", ref = "Issue #740 再描画・出力・リサイズ" }
  // fault = "未処理出力が増え続けてもPTYを止めないかack後に再開しない"
  // observable = "PTY pause/resume件数と送信されたdata event"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "大量出力でmainのメモリ・応答性が悪化するか端末が詰まる"
  // distinction = "buildと型検査は実際の出力流量制御を確認しない"
  // @end-test-value
  it("pauses high output until xterm acknowledges it", async () => {
    const { service, pty, window } = setup();
    await service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
    pty.data("x".repeat(100_000));
    assert.equal(window.events.length, 1);
    assert.equal(pty.pauses, 1);
    service.acknowledge("owner", TERMINAL_ID, 80_000);
    assert.equal(pty.resumes, 1);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "起動中タブを解放した後でspawnが完了してもPTYを直ちに終了する"
  // oracle = { type = "contract", ref = "Issue #740 生存期間と終了" }
  // fault = "非同期spawnの完了後に解放済みのTerminalを実行中として残す"
  // observable = "遅延spawnしたPTYのkill件数とWindowの生存端末数"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "タブを閉じた後に孤立したシェルが残る"
  // distinction = "通常のclose testではcreate完了前の競合を再現しない"
  // @end-test-value
  it("kills a PTY spawned after its starting tab is released", async () => {
    const { window, pty } = setup();
    let finishSpawn!: (value: TerminalPty) => void;
    const service = new TerminalService({
      resolveOwner: (sender) => sender === "owner" ? { window, sessionId: "a", workspacePath: "C:/saved path " } : null,
      confirmClose: () => true,
      sendEvent: (owner, event) => owner.webContents.send("terminal", event),
      resolveShell: async () => ({ file: "C:/Windows/powershell.exe", shellName: "PowerShell" }),
      spawn: () => new Promise<TerminalPty>((resolve) => { finishSpawn = resolve; }),
    });
    const creating = service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
    await Promise.resolve();
    service.release("owner", TERMINAL_ID);
    finishSpawn(pty as unknown as TerminalPty);
    await assert.rejects(creating, /cancelled/);
    assert.equal(pty.kills, 1);
    assert.equal(service.countLive(window), 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "シェル解決失敗後のFailedタブは追加確認なしで閉じられる"
  // oracle = { type = "contract", ref = "Issue #740 タブバーはTerminal領域の内部" }
  // fault = "create失敗で内部owner記録を消し、Failedタブのcloseが拒否される"
  // observable = "シェル解決によるcreate失敗と後続closeの戻り値"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "操作不能なFailedタブがWindow内に残る"
  // distinction = "型検査は失敗後の端末状態遷移を保証しない"
  // @end-test-value
  it("lets a failed tab close without confirmation", async () => {
    const { window } = setup();
    const service = new TerminalService({
      resolveOwner: (sender) => sender === "owner" ? { window, sessionId: "a", workspacePath: "C:/saved path " } : null,
      confirmClose: () => { throw new Error("must not confirm"); },
      sendEvent: (owner, event) => owner.webContents.send("terminal", event),
      resolveShell: async () => { throw new Error("shell missing"); },
      spawn: async () => { throw new Error("must not spawn"); },
    });
    await assert.rejects(service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 }), /shell missing/);
    assert.equal(service.close("owner", TERMINAL_ID), true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "PTYの異常通知を該当terminal ID付きerror eventへ変換し、生存端末数から除外する"
  // oracle = { type = "contract", ref = "Issue #740 タブバーはTerminal領域の内部" }
  // fault = "端末hostの異常をExitedとして扱うかFailed通知なしで放置する"
  // observable = "owner Windowへ送られたerror eventと端末のlive数"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "起動済み端末が操作不能でも利用者に失敗理由が表示されない"
  // distinction = "型検査や通常の自然終了testはhost異常経路を確認しない"
  // @end-test-value
  it("reports an isolated host failure as Failed", async () => {
    const { service, pty, window } = setup();
    await service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
    pty.error(new Error("Terminal host exited unexpectedly (code 1)."));
    assert.deepEqual(window.events, [{
      type: "error", terminalId: TERMINAL_ID,
      message: "Terminal host exited unexpectedly (code 1).",
    }]);
    assert.equal(service.countLive(window), 0);
    assert.equal(service.close("owner", TERMINAL_ID), true);
  });
});
