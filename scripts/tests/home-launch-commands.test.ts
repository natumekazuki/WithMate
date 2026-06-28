import assert from "node:assert/strict";
import test from "node:test";

import {
  openCompanionReviewWindow,
  openHomeWindow,
  openMemoryV6ReviewWindow,
  openSessionMonitorWindow,
  openSessionWindow,
  openSettingsWindow,
} from "../../src/home/home-launch-commands.js";

type WithMateApiStub = Record<string, (...args: string[]) => Promise<void>>;

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
    command: () => openSessionWindow("session-1"),
    expectedArgs: ["session-1"],
  },
  {
    name: "openHomeWindow",
    apiName: "openHomeWindow",
    command: () => openHomeWindow(),
    expectedArgs: [],
  },
  {
    name: "openSessionMonitorWindow",
    apiName: "openSessionMonitorWindow",
    command: () => openSessionMonitorWindow(),
    expectedArgs: [],
  },
  {
    name: "openSettingsWindow",
    apiName: "openSettingsWindow",
    command: () => openSettingsWindow(),
    expectedArgs: [],
  },
  {
    name: "openMemoryV6ReviewWindow",
    apiName: "openMemoryV6ReviewWindow",
    command: () => openMemoryV6ReviewWindow(),
    expectedArgs: [],
  },
  {
    name: "openCompanionReviewWindow",
    apiName: "openCompanionReviewWindow",
    command: () => openCompanionReviewWindow("companion-session-1"),
    expectedArgs: ["companion-session-1"],
  },
];

for (const testCase of windowCommandCases) {
  test(`${testCase.name} は withmate API の ${testCase.apiName} を呼ぶ`, async () => {
    const calls: Array<{ name: string; args: string[] }> = [];

    await withWindowApiStub(
      {
        [testCase.apiName]: async (...args: string[]) => {
          calls.push({ name: testCase.apiName, args });
        },
      },
      testCase.command,
    );

    assert.deepEqual(calls, [{ name: testCase.apiName, args: testCase.expectedArgs }]);
  });
}
