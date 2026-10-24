import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import { HomeCharactersPanel, type HomeCharactersPanelProps } from "../../src/home/HomeCharactersPanel.js";

// @test-value v2
// kind = "contract"
// claim = "Charactersは再取得中と取得失敗後も取得済みcardのfocusとscrollを保持し、取得失敗からRetryできる"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "loading/errorで既知の一覧DOMを置換し、閲覧位置とfocusを失うか、取得失敗から再試行できない"
// observable = "初回loading status、同一cardとlistのDOM identity、activeElementとscrollTop、error理由とRetry callback、正常0件の空本文"
// observation_boundary = "component-behavior"
// scope = "HomeCharactersPanelの初回取得・再取得・失敗・再試行・正常0件"
// lifecycle = "permanent"
// impact = "別Windowから戻った際に閲覧中Characterとkeyboard操作位置を失う"
// distinction = "型checkや既存New Session testは管理一覧のfocusとscroll保持を検出しない。小さなDOM遷移testで継続的な閲覧契約を確認する"
// @end-test-value
test("Characters keeps the known catalog mounted through refresh and retry", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const names = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of names) Object.defineProperty(globalThis, name, {
    configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
  });
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  let retries = 0;
  const edited: string[] = [];
  const character: CharacterCatalogEntry = {
    id: "known", name: "Known Character", description: "Description", iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" }, state: "active",
    createdAt: "", updatedAt: "", archivedAt: null,
  };
  let props: HomeCharactersPanelProps = {
    characters: [], searchText: "", characterLoadStatus: "loading",
    onRetry: () => { retries++; }, onCreateCharacter: () => {}, onEditCharacter: (id) => { edited.push(id); },
  };
  const render = async (next: Partial<HomeCharactersPanelProps>) => {
    props = { ...props, ...next };
    await act(async () => root.render(<HomeCharactersPanel {...props} />));
  };
  try {
    await render({});
    assert.ok(host.querySelector('[role="status"][aria-label="Loading characters"]'));
    assert.equal(host.querySelector('[role="alert"]'), null);
    await render({ characters: [character], characterLoadStatus: "loaded" });
    const list = host.querySelector<HTMLElement>(".home-character-list")!;
    const card = list.querySelector<HTMLButtonElement>("button")!;
    card.focus();
    list.scrollTop = 80;
    const assertCatalogRetained = () => {
      assert.equal(host.querySelector(".home-character-list"), list);
      assert.equal(list.querySelector("button"), card);
      assert.equal(dom.window.document.activeElement, card);
      assert.equal(list.scrollTop, 80);
    };
    await render({ characterLoadStatus: "loading" });
    assert.equal(host.firstElementChild?.getAttribute("aria-busy"), "true");
    assertCatalogRetained();
    await render({ characterLoadStatus: "error", feedback: "Catalog unavailable" });
    assertCatalogRetained();
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /Catalog unavailable/);
    await act(async () => card.click());
    assert.deepEqual(edited, ["known"]);
    await act(async () => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    assert.equal(retries, 1);
    await render({ characterLoadStatus: "loaded", characters: [], feedback: "" });
    assert.equal(list.childElementCount, 0);
    assert.equal(host.querySelector('[role="alert"]'), null);
    assert.equal(host.querySelector('[aria-label="Loading characters"]'), null);
    assert.ok(host.querySelector('[aria-label="Create character"]'));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    });
  }
});
