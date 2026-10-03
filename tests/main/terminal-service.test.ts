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

function setup(confirmClose?: () => Promise<boolean>) {
  const window = new StubWindow();
  const other = new StubWindow();
  other.id = 2;
  const pty = {
    activity: "unknown" as "unknown" | "idle" | "busy",
    getActivity() { return this.activity; },
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
    confirmClose: confirmClose ?? (async () => confirm),
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
  // claim = "Window終了の確認対象はそのownerの起動中・実行中・判別不能の端末だけで、入力待ちと終了済みは含めない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "生存端末を一律集計して入力待ちでも警告するか、他Windowの端末を集計するか、起動中の端末を見落とす"
  // observable = "spawn前後・activity変化・自然終了前後のowner別確認対象数と生存数"
  // observation_boundary = "component-behavior"
  // scope = "Terminal Session Window close confirmation policy"
  // lifecycle = "permanent"
  // impact = "Session Window終了で不要な確認が続く、または作業が確認なしで終了する"
  // distinction = "個別closeのtestは複数owner向けWindow集計を通らず、型検査でもactivity別集計を保証できない"
  // @end-test-value
  it("counts only the owning Window's terminals requiring confirmation", async () => {
    const { service, pty, window, other } = setup();
    const creating = service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
    assert.equal(service.countRequiringCloseConfirmation(window), 1);
    assert.equal(service.countRequiringCloseConfirmation(other), 0);
    await creating;
    for (const activity of ["idle", "busy", "unknown"] as const) {
      pty.activity = activity;
      assert.equal(service.countLive(window), 1);
      assert.equal(service.countRequiringCloseConfirmation(window), activity === "idle" ? 0 : 1);
      assert.equal(service.countRequiringCloseConfirmation(other), 0);
    }
    pty.exit({ exitCode: 0 });
    assert.equal(service.countRequiringCloseConfirmation(window), 0);
    assert.equal(service.countLive(window), 0);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "入力待ちと確認できたPTYだけ確認を省略し、実行中・判別不能では取消によって保持する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "シェル生存だけで全端末へ警告するか、判別不能を安全とみなして終了する"
  // observable = "close戻り値、確認回数、PTY kill件数、live数"
  // observation_boundary = "component-behavior"
  // scope = "Terminal close activity policy"
  // lifecycle = "permanent"
  // impact = "不要な警告の常態化または利用者の実行中作業の消失"
  // distinction = "型検査は状態別の確認判断を保証せず、3状態の小さな実行で分岐を直接検証する"
  // @end-test-value
  it("only skips confirmation for a known idle shell", async () => {
    for (const activity of ["idle", "busy", "unknown"] as const) {
      let confirmations = 0;
      const { service, pty, window } = setup(async () => { confirmations++; return false; });
      await service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
      pty.activity = activity;
      const idle = activity === "idle";
      assert.equal(await service.close("owner", TERMINAL_ID), idle);
      assert.equal(confirmations, idle ? 0 : 1);
      assert.equal(pty.kills, idle ? 1 : 0);
      assert.equal(service.countLive(window), idle ? 0 : 1);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "同じ端末の非同期確認を共有し、確認待ちでもPTYイベントを配送して取消後も入力できる"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "確認中にイベントを保留するか、重複closeで別の確認を開くか、取消でPTYを停止する"
  // observable = "確認回数、未解決close中のdata event、取消戻り値、PTY入力とkill件数"
  // observation_boundary = "component-behavior"
  // scope = "Terminal asynchronous close cancellation"
  // lifecycle = "permanent"
  // impact = "終了確認中に端末出力が止まるか、取消しても作業を失う"
  // distinction = "実ダイアログの応答性は実機で別途確認し、この低コストtestはserviceの保留と取消を決定論的に検証する"
  // @end-test-value
  it("shares a pending confirmation while continuing terminal events and preserves cancellation", async () => {
    let answer!: (close: boolean) => void;
    let confirmations = 0;
    const { service, pty, window } = setup(() => {
      confirmations++;
      return new Promise<boolean>((resolve) => { answer = resolve; });
    });
    await service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
    const first = service.close("owner", TERMINAL_ID);
    const second = service.close("owner", TERMINAL_ID);
    pty.data("while confirming");
    assert.deepEqual(window.events, [{ type: "data", terminalId: TERMINAL_ID, data: "while confirming" }]);
    assert.equal(confirmations, 1);
    assert.equal(pty.kills, 0);
    answer(false);
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    service.write("owner", TERMINAL_ID, "still usable");
    assert.deepEqual(pty.writes, ["still usable"]);
    assert.equal(service.countLive(window), 1);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "確認中に解放された端末の遅延承認は同じIDで再作成された端末を終了しない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "確認完了時に古いentryではなくIDだけで現端末をkillする"
  // observable = "解放と遅延承認前後のkill件数、再作成後のlive数と入力"
  // observation_boundary = "component-behavior"
  // scope = "Terminal close identity race"
  // lifecycle = "permanent"
  // impact = "別の新しい端末の作業を誤って終了する"
  // distinction = "通常の取消testと型検査はawaitを跨ぐ端末identityを保証しない"
  // @end-test-value
  it("does not release a replacement terminal after an old confirmation resolves", async () => {
    let answer!: (close: boolean) => void;
    const { service, pty, window } = setup(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    await service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
    const closing = service.close("owner", TERMINAL_ID);
    service.release("owner", TERMINAL_ID);
    assert.equal(pty.kills, 1);
    await service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
    answer(true);
    assert.equal(await closing, true);
    assert.equal(pty.kills, 1);
    assert.equal(service.countLive(window), 1);
    service.write("owner", TERMINAL_ID, "replacement");
    assert.deepEqual(pty.writes, ["replacement"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "非同期確認中の自然終了は終了結果を配送し、承認時に終了済みPTYを再killしない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "await前のPTYを保持して自然終了後にもkillするかexit eventを配送しない"
  // observable = "確認中のexit event、close戻り値とPTY kill件数"
  // observation_boundary = "component-behavior"
  // scope = "Terminal close natural exit race"
  // lifecycle = "permanent"
  // @end-test-value
  it("handles natural exit while a confirmation is pending", async () => {
    let answer!: (close: boolean) => void;
    const { service, pty, window } = setup(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    await service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
    const closing = service.close("owner", TERMINAL_ID);
    pty.exit({ exitCode: 0 });
    assert.deepEqual(window.events, [{ type: "exit", terminalId: TERMINAL_ID, exitCode: 0 }]);
    answer(true);
    assert.equal(await closing, true);
    assert.equal(pty.kills, 0);
  });

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
    await assert.rejects(service.close("other", TERMINAL_ID));
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
    assert.equal(await service.close("owner", TERMINAL_ID), false);
    assert.equal(service.countLive(window), 1);
    assert.equal(pty.kills, 0);
    window.destroyed = true;
    window.emit("destroyed");
    assert.equal(service.countLive(window), 0);
    assert.equal(pty.kills, 1);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "現行watermark設定では未処理出力100000文字未満で停止せず、到達時に一度だけ停止し、ackで20000文字以下になるまで再開しない"
  // oracle = { type = "contract", ref = "Issue #740 再描画・出力・リサイズ（流量制御要求）; src-electron/terminal/terminal-service.ts OUTPUT_HIGH_WATER / OUTPUT_LOW_WATER（現行watermark設定）" }
  // fault = "任意出力でpauseするか任意ackでresumeするか、上下限の等号を誤るか、停止・再開を重複する"
  // observable = "未処理量99999・100000・100001でのpause件数と20001・20000・19999でのresume件数、全data event"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "大量出力でmainのメモリ・応答性が悪化するか端末が詰まる"
  // distinction = "buildと型検査は実際の出力流量制御を確認しない"
  // @end-test-value
  it("pauses and resumes only at the output watermarks", async () => {
    const { service, pty, window } = setup();
    await service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 });
    const initialOutput = "x".repeat(99_999);
    pty.data(initialOutput);
    assert.equal(pty.pauses, 0);
    pty.data("y");
    assert.equal(pty.pauses, 1);
    pty.data("z");
    assert.equal(pty.pauses, 1);
    assert.equal(pty.resumes, 0);
    assert.deepEqual(window.events, [
      { type: "data", terminalId: TERMINAL_ID, data: initialOutput },
      { type: "data", terminalId: TERMINAL_ID, data: "y" },
      { type: "data", terminalId: TERMINAL_ID, data: "z" },
    ]);
    service.acknowledge("owner", TERMINAL_ID, 80_000);
    assert.equal(pty.resumes, 0);
    service.acknowledge("owner", TERMINAL_ID, 1);
    assert.equal(pty.resumes, 1);
    service.acknowledge("owner", TERMINAL_ID, 1);
    assert.equal(pty.resumes, 1);
    const nextOutput = "w".repeat(80_002);
    pty.data(nextOutput);
    assert.equal(pty.pauses, 2);
    assert.equal(pty.resumes, 1);
    assert.deepEqual(window.events.at(-1), { type: "data", terminalId: TERMINAL_ID, data: nextOutput });
    service.acknowledge("owner", TERMINAL_ID, 80_002);
    assert.equal(pty.resumes, 2);
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
      confirmClose: async () => true,
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
    assert.equal(await service.close("owner", TERMINAL_ID), true);
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
    assert.equal(await service.close("owner", TERMINAL_ID), true);
  });
});
