import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { CoordinationIdentity } from "../../src-shared/coordination/coordination-contract.js";
import type { CoordinationDisplayIdentity } from "../../src-shared/coordination/coordination-window-contract.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { coordinationIdentityKey, useCoordinationIdentities } from "../../src/coordination/use-coordination-identities.js";

// @test-value v2
// kind = "contract"
// claim = "Coordination identityは表示中の重複しないstable identityだけを読み、切替後の遅延応答を捨て、通信失敗を削除済みと混同しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Coordination; src-shared/coordination/coordination-window-contract.ts" }
// fault = "非表示でも全件取得する、incarnationをまとめる、または古いpage応答を表示し通信失敗を削除済みに変える"
// observable = "APIへ渡るidentity件数/値、hookの現在page表示metadata、失敗後の保持metadataとerror"
// observation_boundary = "component-behavior"
// scope = "useCoordinationIdentitiesの表示境界、重複排除、遅延応答と再取得"
// lifecycle = "permanent"
// impact = "相談の相手を取り違えず、非表示paneの不要取得と失敗による誤った削除表示を防ぐ"
// distinction = "型検査やIPC testはReact表示切替と遅いpromiseの適用順を検出できない"
// @end-test-value
test("Coordination identity reads follow only visible stable identities and retain failed metadata", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  globals.forEach((name) => Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
  }));
  const pending: Array<{ identity: CoordinationIdentity; resolve(value: CoordinationDisplayIdentity | null): void; reject(error: Error): void }> = [];
  dom.window.withmate = {
    getCoordinationIdentity: (identity) => new Promise((resolve, reject) => pending.push({ identity, resolve, reject })),
    subscribeSessionInvalidation: () => () => {},
  } as Pick<WithMateWindowApi, "getCoordinationIdentity" | "subscribeSessionInvalidation"> as WithMateWindowApi;
  const main: CoordinationIdentity = { kind: "main", sessionId: "main", incarnationId: "old" };
  const auxiliary: CoordinationIdentity = { kind: "auxiliary", sessionId: "aux", incarnationId: "current" };
  let output: ReturnType<typeof useCoordinationIdentities>;
  function Harness({ identities, active }: { identities: CoordinationIdentity[]; active: boolean }) {
    output = useCoordinationIdentities(identities, active);
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async (identities: CoordinationIdentity[], active: boolean) => {
    await act(async () => root.render(createElement(Harness, { identities, active })));
  };
  const display = { title: "Current Auxiliary", character: { name: "AZKi", iconPath: "azki.png" } };
  try {
    await render([main, main], false);
    assert.equal(pending.length, 0);
    await render([main, main], true);
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0]!.identity, main);
    await render([auxiliary], true);
    assert.equal(pending.length, 2);
    await act(async () => pending[0]!.resolve({ ...display, title: "Old Page" }));
    assert.equal(output!.reads[coordinationIdentityKey(main)], undefined);
    await act(async () => pending[1]!.resolve(display));
    assert.deepEqual(output!.reads[coordinationIdentityKey(auxiliary)], { identity: display });
    await act(async () => output!.refresh());
    await act(async () => pending[2]!.reject(new Error("Transport disconnected")));
    assert.deepEqual(output!.reads[coordinationIdentityKey(auxiliary)], { identity: display, error: "Transport disconnected" });
    await act(async () => output!.refresh());
    await act(async () => pending[3]!.resolve(null));
    assert.deepEqual(output!.reads[coordinationIdentityKey(auxiliary)], { identity: null });
    await render([{ ...auxiliary, incarnationId: "replacement" }], true);
    assert.equal(pending.length, 5);
    assert.equal(output!.reads[coordinationIdentityKey(auxiliary)], undefined);
    assert.equal(pending[4]!.identity.incarnationId, "replacement");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
