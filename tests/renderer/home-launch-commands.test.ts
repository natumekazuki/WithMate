import assert from "node:assert/strict";
import test from "node:test";

import {
  openHomeWindow,
  openSessionMonitorWindow,
  openSessionWindow,
  openSettingsWindow,
} from "../../src/home/home-launch-commands.js";

/** ウィンドウ起動 IPC を差し替える、文字列引数を取る非同期 API の型。 */
type WithMateApiStub = Record<string, (...args: string[]) => Promise<void>>;

/** 起動コマンドを実行する間だけ preload API を差し替え、実行後は元の window に戻す。 */
async function withWindowApiStub<T>(
  withmate: WithMateApiStub,
  action: () => Promise<T>,
): Promise<T> {
  const previousWindow = globalThis.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { withmate },
  });

  try {
    return await action();
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }
}

const windowCommandCases = [
  {
    name: "openSessionWindow",
    apiName: "openSession",
    /** Session ID を指定して個別の会話ウィンドウを開く。 */
    command: () => openSessionWindow("session-1"),
    expectedArgs: ["session-1"],
  },
  {
    name: "openHomeWindow",
    apiName: "openHomeWindow",
    /** Home を引数なしで開く。 */
    command: () => openHomeWindow(),
    expectedArgs: [],
  },
  {
    name: "openSessionMonitorWindow",
    apiName: "openSessionMonitorWindow",
    /** Session Monitor を引数なしで開く。 */
    command: () => openSessionMonitorWindow(),
    expectedArgs: [],
  },
  {
    name: "openSettingsWindow",
    apiName: "openSettingsWindow",
    /** 設定ウィンドウを引数なしで開く。 */
    command: () => openSettingsWindow(),
    expectedArgs: [],
  },
];

for (const testCase of windowCommandCases) {
  /** 各コマンドが正しい preload メソッドに引数を一度だけ渡すことを確かめる。 */
  test(`${testCase.name} は withmate API の ${testCase.apiName} を呼ぶ`, async () => {
    const calls: Array<{ name: string; args: string[] }> = [];

    await withWindowApiStub(
      {
        /** 差し替えたメソッドの呼び出しと引数を観測する。 */
        [testCase.apiName]: async (...args: string[]) => {
          calls.push({ name: testCase.apiName, args });
        },
      },
      testCase.command,
    );

    assert.deepEqual(calls, [
      { name: testCase.apiName, args: testCase.expectedArgs },
    ]);
  });
}
