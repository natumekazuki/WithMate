import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import type { SessionInstructionsTarget } from "../../src-shared/session/session-instructions.js";
import { SessionInstructionsControl } from "../../src/chat/composer/session-instructions-control.js";

/** 対象の切替でエディターを再マウントし、古い読込・保存の応答が切替後の入力欄を上書きしたり閉じたりしないことを確認する。 */
test("切替前の読込・保存完了は新しい Instructions エディターを変更しない", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true });

  const main: SessionInstructionsTarget = {
    kind: "main",
    sessionId: "main",
    incarnationId: "main-v1",
  };
  const auxiliary: SessionInstructionsTarget = {
    kind: "auxiliary",
    sessionId: "aux",
    incarnationId: "aux-v1",
    mainSessionId: "main",
    mainIncarnationId: "main-v1",
  };
  const reads: Array<{
    target: SessionInstructionsTarget;
    finish: (body: string) => void;
  }> = [];
  const writes: Array<{
    target: SessionInstructionsTarget;
    body: string;
    finish: (result: { byteLength: number }) => void;
  }> = [];
  const api = {
    /** 本文の読み取り先を記録し、切替前後の応答が届く順序をテストから制御する。 */
    getSessionInstructions: (target: SessionInstructionsTarget) =>
      new Promise<string>((finish) => {
        reads.push({ target, finish });
      }),
    /** 保存先と編集中の本文を記録し、次の所有者が開いた後から保存完了を返せるようにする。 */
    setSessionInstructions: (target: SessionInstructionsTarget, body: string) =>
      new Promise<{ byteLength: number }>((finish) => {
        writes.push({ target, body, finish });
      }),
  };
  let root: Root | undefined;
  const body = dom.window.document.body;
  /** 対象の識別情報を React のキーに使い、切替時に別の編集インスタンスを描画する。 */
  const render = (target: SessionInstructionsTarget) =>
    act(async () => {
      root!.render(
        <SessionInstructionsControl
          key={JSON.stringify(target)}
          title={target.sessionId}
          target={target}
          api={api}
        />,
      );
    });
  /** 画面に出ている文言でボタンを選び、React の操作境界内で押す。 */
  const click = (name: string) =>
    act(async () => {
      const button = Array.from(body.querySelectorAll("button")).find(
        (element) => element.textContent === name,
      );
      assert.ok(button, name);
      button.click();
    });
  /** その時点で開いている指示入力欄を取得し、切替後は表示されない場合も扱う。 */
  const input = () => body.querySelector("textarea");
  try {
    const { createRoot } = await import("react-dom/client");
    root = createRoot(dom.window.document.getElementById("root")!);
    await render(main);
    await click("Instructions");
    assert.equal(input()?.readOnly, true);
    await render(auxiliary);
    assert.equal(input(), null);
    await click("Instructions");
    assert.deepEqual(
      reads.map(({ target }) => target),
      [main, auxiliary],
    );
    await act(async () => {
      reads[1].finish("補足😀");
    });
    await act(async () => {
      reads[0].finish("stale Main text");
    });
    assert.equal(input()?.value, "補足😀");

    await click("Save");
    assert.deepEqual(
      writes.map(({ target, body: draft }) => ({ target, draft })),
      [{ target: auxiliary, draft: "補足😀" }],
    );
    await render(main);
    await click("Instructions");
    await act(async () => {
      reads[2].finish("current Main");
    });
    await act(async () => {
      writes[0].finish({ byteLength: 10 });
    });
    assert.equal(input()?.value, "current Main");
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
