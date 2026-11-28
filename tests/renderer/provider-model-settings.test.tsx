import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { ModelAvailabilitySettings } from "../../src-shared/settings/model-availability.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** モデル設定の編集画面を独立したDOMで動かし、描画と後片付けを共通化する。 */
async function withSettings(
  run: (context: {
    document: Document;
    window: JSDOM["window"];
    render: (
      props: import("../../src/settings/provider-model-settings.js").ProviderModelSettingsProps,
    ) => Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
  });
  const globals = [
    "window",
    "document",
    "Node",
    "HTMLElement",
    "HTMLInputElement",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
  ] as const;
  const previous = Object.fromEntries(
    globals.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const key of globals)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key],
    });
  const { createRoot } = await import("react-dom/client");
  const { ProviderModelSettings } =
    await import("../../src/settings/provider-model-settings.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await run({
      document: dom.window.document,
      window: dom.window,
      /** 渡されたプロパティで設定画面を描画し、操作可能になるまで待つ。 */ render:
        async (props) => {
          await act(async () =>
            root.render(<ProviderModelSettings {...props} />),
          );
        },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of globals) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

/** 同じモデルID群を階層付きと平坦なプロバイダーの両方で試せるようにする。 */
const provider = (id: string): ModelCatalogProvider => ({
  id,
  label: id === "opencode" ? "OpenCode" : "Codex",
  defaultModelId: "",
  defaultReasoningEffort: "",
  models: [
    {
      id: "vendor/model10",
      label: "Model 10",
      sourceLabel: "vendor",
      reasoningEfforts: [],
    },
    {
      id: "vendor/model2",
      label: "Model 2",
      sourceLabel: "vendor",
      reasoningEfforts: [],
    },
  ],
});

// @test-value v2
// kind = "contract"
// claim = "OpenCodeのサービス無効化は個別チェックと他Provider設定を保持し、一時消失した無効Modelも再有効化できる"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md" }
// fault = "サービス変更で個別設定を消去するか、cacheにない保存済み無効Modelの再有効化を不能にする"
// observable = "サービスとModel checkboxのchecked/disabledおよびonChangeの全Provider設定"
// observation_boundary = "component-behavior"
// scope = "ProviderModelSettings OpenCode draft編集"
// lifecycle = "permanent"
// impact = "サービス再有効化で意図しないModelが復活するか、消失したModelの無効設定を取り消せない"
// distinction = "設定helperやstorageのtestでは検出できないnative checkboxと全体draft更新の対応を検証する"
// @end-test-value
/** 接続先の無効化で個別選択や他プロバイダーを変えず、一覧から消えた無効モデルも再び有効にできる。 */
test("service toggles preserve model choices and missing disabled models remain editable", async () => {
  await withSettings(async ({ document, render }) => {
    let availability: ModelAvailabilitySettings = {
      codex: { disabledServiceIds: [], disabledModelIds: ["other"] },
      opencode: {
        disabledServiceIds: [],
        disabledModelIds: ["vendor/model2", "missing/old"],
      },
    };
    /** 現在のOpenCode設定を表示するプロパティを作る。 */
    const props = () => ({
      provider: provider("opencode"),
      availability,
      providerEnabled: true,
      /** サービスやモデルのチェック操作で返った設定全体を控える。 */ onChange:
        (next: ModelAvailabilitySettings) => {
          availability = next;
        },
      /** チェックボックスの試験では前画面に遷移しない。 */ onBack: () => {},
    });
    /** vendor接続先の有効状態を操作するチェックを取る。 */
    const service = () =>
      document.querySelector<HTMLInputElement>(
        '[aria-label="vendor Service"]',
      )!;
    /** 候補にないモデルも含め、IDを持つ行のチェックを取る。 */
    const model = (id: string) =>
      document.querySelector<HTMLInputElement>(`label[title="${id}"] input`)!;
    await render(props());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="vendor Models"]')!
        .click(),
    );
    assert.equal(model("vendor/model2").checked, false);
    await act(async () => service().click());
    await render(props());
    assert.equal(model("vendor/model10").checked, true);
    assert.equal(model("vendor/model10").disabled, true);
    assert.equal(model("vendor/model2").checked, false);
    assert.deepEqual(availability.codex.disabledModelIds, ["other"]);
    await act(async () => service().click());
    await render(props());
    assert.equal(model("vendor/model2").checked, false);
    assert.equal(model("vendor/model2").disabled, false);
    assert.equal(model("missing/old").checked, false);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="missing Models"]')!
        .click(),
    );
    await act(async () => model("missing/old").click());
    assert.deepEqual(availability.opencode.disabledModelIds, ["vendor/model2"]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "接続先の開閉は有効設定と独立し、検索は一致Modelを開いて検索解除時に通常の開閉状態へ戻す"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#model-management" }
// fault = "閉じる操作で設定を変更する、有効切替で開閉する、または検索結果を閉じたままにして通常時の開閉状態を失う"
// observable = "開閉buttonのaria-expanded/controls、配下一覧のhidden、focus、onChange値と件数"
// observation_boundary = "component-behavior"
// scope = "ProviderModelSettings OpenCodeの開閉・有効設定・検索"
// lifecycle = "permanent"
// impact = "大量Modelの管理中に意図せず接続先を無効化するか検索で目的のModelを見つけられない"
// distinction = "既存の有効化と検索のtestは開閉操作・検索中の手動開閉・通常表示復帰の結線を検証しない"
// @end-test-value
/** 開閉を有効設定から分離し、検索中の一時展開と通常表示の開閉状態を区別する。 */
test("service disclosure and search preserve independent availability and browse expansion", async () => {
  await withSettings(async ({ document, window, render }) => {
    let availability: ModelAvailabilitySettings = {
      opencode: { disabledServiceIds: [], disabledModelIds: ["vendor/model2"] },
    };
    let changes = 0;
    const catalog = {
      ...provider("opencode"),
      models: [
        ...provider("opencode").models,
        { id: "other/model2", label: "Model 2", reasoningEfforts: [] },
      ],
    };
    /** 現在のカタログと許可設定で、開閉および検索を操作する画面を組み立てる。 */
    const props = () => ({
      provider: catalog,
      availability,
      providerEnabled: true,
      /** 有効状態の変更を数え、単なる開閉や検索で保存されていないことを確認できるようにする。 */ onChange:
        (next: ModelAvailabilitySettings) => {
          changes++;
          availability = next;
        },
      /** 開閉と検索の試験では戻る操作を扱わない。 */ onBack: () => {},
    });
    /** 指定した接続先のモデル一覧を展開するボタンを探す。 */
    const button = (service: string) =>
      document.querySelector<HTMLButtonElement>(
        `[aria-label="${service} Models"]`,
      )!;
    /** 開閉ボタンの通知先IDから対応するモデル一覧を引く。 */
    const list = (service: string) =>
      document.getElementById(button(service).getAttribute("aria-controls")!)!;
    /** 対象の開閉ボタンに焦点を置いて押し、Reactの反映を待つ。 */
    const toggle = async (service: string) => {
      await act(async () => {
        button(service).focus();
        button(service).click();
      });
    };
    /** 検索欄へ文字列または空文字を入力して表示候補を更新する。 */
    const search = async (value: string) => {
      const input = document.querySelector<HTMLInputElement>(
        '[aria-label="Search Models"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    };
    await render(props());
    assert.equal(button("vendor").getAttribute("aria-expanded"), "false");
    assert.equal(list("vendor").hidden, true);
    assert.equal(list("other").hidden, true);
    await toggle("vendor");
    assert.equal(document.activeElement, button("vendor"));
    assert.equal(button("vendor").getAttribute("aria-expanded"), "true");
    assert.equal(list("vendor").hidden, false);
    await toggle("vendor");
    assert.equal(changes, 0);
    /** 開閉と別に変更できるvendorの有効チェックを取得する。 */
    const service = () =>
      document.querySelector<HTMLInputElement>(
        '[aria-label="vendor Service"]',
      )!;
    await act(async () => service().click());
    await render(props());
    assert.equal(list("vendor").hidden, true);
    assert.deepEqual(availability.opencode, {
      disabledServiceIds: ["vendor"],
      disabledModelIds: ["vendor/model2"],
    });
    await act(async () => service().click());
    await render(props());
    await toggle("vendor");
    await search("Model 2");
    assert.equal(list("vendor").hidden, false);
    assert.equal(list("other").hidden, false);
    await toggle("other");
    await render(props());
    assert.equal(list("other").hidden, true);
    await search("Model");
    assert.equal(list("other").hidden, false);
    await search("");
    assert.equal(list("vendor").hidden, false);
    assert.equal(list("other").hidden, true);
    assert.deepEqual(availability.opencode, {
      disabledServiceIds: [],
      disabledModelIds: ["vendor/model2"],
    });
    assert.equal(changes, 2);
  });
});

// @test-value v2
// kind = "contract"
// claim = "非階層ProviderはModel名の自然順と共有検索で直接編集でき、Provider OFF中は保存済みチェックを保持して編集を止める"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md" }
// fault = "Model 10を2より前へ並べる、検索語を無視する、またはProvider無効時にチェックを解除する"
// observable = "検索後のModel label一覧、checkboxのchecked/disabled、Back callback"
// observation_boundary = "component-behavior"
// scope = "ProviderModelSettings 非階層Providerの検索と無効状態"
// lifecycle = "permanent"
// impact = "目的のModelを見つけられないかProvider再有効化時の選択状態を誤認する"
// distinction = "共有検索のpure testとは異なり検索input・候補表示・Provider状態の結線を検証する"
// @end-test-value
/** 平坦な一覧を自然順で検索でき、プロバイダー無効時はチェックを保ったまま操作を止める。 */
test("flat provider models use natural search ordering and retain checks while provider is disabled", async () => {
  await withSettings(async ({ document, window, render }) => {
    let back = 0;
    const props = {
      provider: provider("codex"),
      availability: {
        codex: { disabledServiceIds: [], disabledModelIds: ["vendor/model2"] },
      },
      providerEnabled: false,
      /** 無効状態で設定の更新が発生したら失敗として扱う。 */ onChange: () =>
        assert.fail("disabled model changed"),
      /** 前の設定へ戻る操作は無効状態でも届くことを数える。 */ onBack: () => {
        back += 1;
      },
    };
    await render(props);
    /** 現在の結果に含まれるモデル行を表示順に取得する。 */
    const rows = () => [
      ...document.querySelectorAll<HTMLLabelElement>("label[title]"),
    ];
    assert.deepEqual(
      rows().map((label) => label.title),
      ["vendor/model2", "vendor/model10"],
    );
    assert.equal(rows()[0].querySelector("input")!.checked, false);
    assert.equal(rows()[1].querySelector("input")!.checked, true);
    assert.ok(rows().every((label) => label.querySelector("input")!.disabled));
    const search = document.querySelector<HTMLInputElement>(
      '[aria-label="Search Models"]',
    )!;
    assert.equal(search.hasAttribute("placeholder"), false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(search, "Model 10");
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.deepEqual(
      rows().map((label) => label.title),
      ["vendor/model10"],
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("button")!.click(),
    );
    assert.equal(back, 1);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Model候補の背景再取得は取得済み内容・操作中のcheckbox focus・未保存設定を保持し、取得中と失敗を区別する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込空失敗" }
// fault = "再取得でfocus中の行を消去するか、loading/errorでcache候補を空へ置換する"
// observable = "activeElement、保持されたcheckbox、busy status、失敗alertとonChange値"
// observation_boundary = "component-behavior"
// scope = "ProviderModelSettings discovery更新"
// lifecycle = "permanent"
// impact = "候補更新中にkeyboard操作先を失うか編集中のModel設定を消す"
// distinction = "static/buildや検索helperでは扱わない再描画時のnative focusとdraft callbackを検証する"
// @end-test-value
/** 背景取得中と失敗時にキャッシュとフォーカスを維持し、設定変更を勝手に通知しない。 */
test("background discovery keeps focused rows and drafts while exposing loading and failure", async () => {
  await withSettings(async ({ document, render }) => {
    const changes: ModelAvailabilitySettings[] = [];
    const props = {
      provider: provider("codex"),
      availability: {},
      providerEnabled: true,
      /** 背景取得と明示的なチェック操作のどちらが設定を変えたか比較できるようにする。 */ onChange:
        (value: ModelAvailabilitySettings) => changes.push(value),
      /** 背景取得中は設定画面から離れない。 */ onBack: () => {},
    };
    await render(props);
    const input = document.querySelector<HTMLInputElement>(
      'label[title="vendor/model2"] input',
    )!;
    await act(async () => input.focus());
    await render({
      ...props,
      provider: { ...props.provider, models: [] },
      discovery: { status: "loading" },
    });
    assert.equal(document.activeElement, input);
    assert.ok(
      document.querySelector(
        '[aria-label="Loading Codex Models"][aria-busy="true"]',
      ),
    );
    await render({
      ...props,
      provider: { ...props.provider, models: [] },
      discovery: { status: "error", error: "Provider unavailable." },
    });
    assert.equal(document.activeElement, input);
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Provider unavailable/,
    );
    assert.deepEqual(changes, []);
    await act(async () => input.click());
    assert.deepEqual(changes, [
      {
        codex: { disabledServiceIds: [], disabledModelIds: ["vendor/model2"] },
      },
    ]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "非階層Providerの一括変更は保存済み消失IDも含む全件を編集し、Undoで混在状態を復元するが後続編集や設定置換は巻き戻さない"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#model-management" }
// fault = "一括変更で他Providerを変更する、Undoを逆操作で代用する、または古いUndoで新しい編集を上書きする"
// observable = "onChangeの全Provider設定、buttonのdisabledとUndoの利用可否、Undo後のfocus"
// observation_boundary = "component-behavior"
// scope = "ProviderModelSettings 非階層Providerの一括編集と一段Undo"
// lifecycle = "permanent"
// impact = "大量Modelの混在した設定や後から行った編集を意図せず失う"
// distinction = "個別checkboxのtestや型検査では保証できない一括対象範囲と取り消しの編集順序を検証する"
// @end-test-value
/** 平坦な一覧の一括変更に保存済みの消失IDを含め、後から個別編集や設定置換をした場合はUndoで巻き戻さない。 */
test("flat bulk edits restore mixed choices without reverting later edits or replacement settings", async () => {
  await withSettings(async ({ document, render }) => {
    const initial: ModelAvailabilitySettings = {
      codex: {
        disabledServiceIds: [],
        disabledModelIds: ["vendor/model2", "missing"],
      },
      opencode: {
        disabledServiceIds: ["other"],
        disabledModelIds: ["other/model"],
      },
    };
    let availability = initial;
    let changes = 0;
    let providerEnabled = true;
    /** 現在の設定全体とプロバイダー状態を一括操作の画面に渡す。 */
    const props = () => ({
      provider: provider("codex"),
      availability,
      providerEnabled,
      /** 一括処理やUndoの結果を次回の描画へ渡し、保存回数を控える。 */ onChange:
        (next: ModelAvailabilitySettings) => {
          availability = next;
          changes++;
        },
      /** 一括処理の検証では戻る遷移を行わない。 */ onBack: () => {},
    });
    /** ラベルが一致する一括操作かUndoのボタンを見つける。 */
    const button = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (element) => element.textContent === text,
      )!;
    /** ボタンを押した後、更新済みの設定で画面を描画し直す。 */
    const click = async (text: string) => {
      await act(async () => button(text).click());
      await render(props());
    };
    /** Undoが画面上で利用者に公開されているかを確認する。 */
    const canUndo = () =>
      button("Undo").getAttribute("aria-hidden") === "false";
    await render(props());
    await click("Disable All");
    assert.deepEqual(
      new Set(availability.codex.disabledModelIds),
      new Set(["vendor/model2", "vendor/model10", "missing"]),
    );
    assert.deepEqual(availability.opencode, initial.opencode);
    assert.equal(button("Disable All").disabled, true);
    await click("Disable All");
    assert.equal(changes, 1);
    assert.equal(canUndo(), true);
    await click("Undo");
    assert.deepEqual(availability, initial);
    assert.equal(
      document.activeElement,
      document.querySelector('[aria-label="Search Models"]'),
    );
    assert.equal(canUndo(), false);
    await click("Enable All");
    assert.deepEqual(availability.codex.disabledModelIds, []);
    assert.deepEqual(availability.opencode, initial.opencode);
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('label[title="vendor/model2"] input')!
        .click(),
    );
    await render(props());
    assert.equal(canUndo(), false);
    assert.deepEqual(availability.codex.disabledModelIds, ["vendor/model2"]);
    await click("Disable All");
    assert.equal(canUndo(), true);
    availability = structuredClone(availability);
    await render(props());
    assert.equal(canUndo(), false);
    await click("Undo");
    assert.deepEqual(
      new Set(availability.codex.disabledModelIds),
      new Set(["vendor/model2", "vendor/model10"]),
    );
    providerEnabled = false;
    await render(props());
    assert.equal(button("Enable All").disabled, true);
    assert.equal(button("Disable All").disabled, true);
    const before = changes;
    await click("Enable All");
    assert.equal(changes, before);
  });
});

// @test-value v2
// kind = "contract"
// claim = "OpenCodeの一括変更は接続先内の検索一致だけに限定され、接続先OFF中は個別設定を保持して一括操作を止める"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#model-management" }
// fault = "検索外または別接続先のModelを一緒に変更するか、一括操作で接続先を自動ONにする"
// observable = "検索中の操作label、onChangeの接続先・個別Model設定、buttonのdisabled、連続一括後のUndo値"
// observation_boundary = "component-behavior"
// scope = "ProviderModelSettings OpenCodeの検索対象一括編集"
// lifecycle = "permanent"
// impact = "目的外のModelを大量に無効化するか、意図して無効化した接続先を再有効化する"
// distinction = "非階層の一括testと異なり検索・接続先・個別設定の範囲と優先関係を検証する"
// @end-test-value
/** サービスごとの一括変更を検索に一致する候補に限定し、無効なサービスの既存設定を維持する。 */
test("service bulk actions affect only matching models and remain blocked by disabled services", async () => {
  await withSettings(async ({ document, window, render }) => {
    let availability: ModelAvailabilitySettings = {
      opencode: {
        disabledServiceIds: ["other"],
        disabledModelIds: ["vendor/model10", "other/model2"],
      },
    };
    const catalog = {
      ...provider("opencode"),
      models: [
        ...provider("opencode").models,
        { id: "other/model2", label: "Model 2", reasoningEfforts: [] },
      ],
    };
    /** OpenCodeの現在の許可設定と検索対象カタログを表示する。 */
    const props = () => ({
      provider: catalog,
      availability,
      providerEnabled: true,
      /** 一括変更で返った設定を保管し、他の接続先や検索不一致のIDと比較する。 */ onChange:
        (next: ModelAvailabilitySettings) => {
          availability = next;
        },
      /** 検索結果と一括変更の観測中は別画面へ移らない。 */ onBack: () => {},
    });
    /** 接続先ごとの操作グループからラベルが一致するボタンを選ぶ。 */
    const action = (service: string, text: string) =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          `[role="group"][aria-label="${service} Model Actions"] button`,
        ),
      ].find((element) => element.textContent === text)!;
    /** サービス操作から独立したUndoボタンを取得する。 */
    const undo = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (element) => element.textContent === "Undo",
      )!;
    await render(props());
    /** モデルの検索条件を入力し、接続先ごとに一致する候補を切り替える。 */
    const search = async (value: string) => {
      const input = document.querySelector<HTMLInputElement>(
        '[aria-label="Search Models"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    };
    await search("Model 2");
    assert.equal(action("other", "Enable Matches").disabled, true);
    assert.equal(action("other", "Disable Matches").disabled, true);
    const before = structuredClone(availability);
    await act(async () => action("other", "Enable Matches").click());
    assert.deepEqual(availability, before);
    await act(async () => action("vendor", "Disable Matches").click());
    await render(props());
    assert.deepEqual(availability.opencode.disabledServiceIds, ["other"]);
    assert.deepEqual(
      new Set(availability.opencode.disabledModelIds),
      new Set(["vendor/model10", "other/model2", "vendor/model2"]),
    );
    const afterDisable = availability;
    await act(async () => action("vendor", "Enable Matches").click());
    await render(props());
    assert.deepEqual(availability.opencode.disabledModelIds, [
      "vendor/model10",
      "other/model2",
    ]);
    await search("");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="vendor Models"]')!
        .click(),
    );
    await act(async () => undo().click());
    await render(props());
    assert.deepEqual(availability, afterDisable);
    assert.equal(undo().disabled, true);
    await act(async () => action("vendor", "Enable All").click());
    await render(props());
    assert.deepEqual(availability.opencode.disabledModelIds, ["other/model2"]);
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('[aria-label="vendor Service"]')!
        .click(),
    );
    await render(props());
    assert.equal(undo().disabled, true);
    assert.deepEqual(availability.opencode, {
      disabledServiceIds: ["other", "vendor"],
      disabledModelIds: ["other/model2"],
    });
    assert.equal(action("vendor", "Enable All").disabled, true);
    assert.equal(action("vendor", "Disable All").disabled, true);
  });
});

// @test-value v2
// kind = "contract"
// claim = "cacheにない保存済みModelだけの接続先を一括で再有効化して一覧が消えてもheaderのUndoで復元できる"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#model-management" }
// fault = "Undoを消失する接続先の中へ置いて取り消せなくするか保存済みの無効IDを復元しない"
// observable = "接続先一覧の消失と復元、headerのUndo操作、検索欄へのfocus、onChangeの保存済みID"
// observation_boundary = "component-behavior"
// scope = "ProviderModelSettings 保存済み消失Modelの一括再有効化"
// lifecycle = "permanent"
// impact = "一括再有効化の誤操作で元の無効IDを取り戻せない"
// distinction = "通常のcatalog内Modelでは発生しない一括後の対象一覧消失を操作可能性と共に検証する"
// @end-test-value
/** 保存済みの消失候補だけで構成されるサービスが消えても、ヘッダーからUndoして復元できる。 */
test("header undo survives removal of a service containing only saved missing models", async () => {
  await withSettings(async ({ document, render }) => {
    let availability: ModelAvailabilitySettings = {
      opencode: { disabledServiceIds: [], disabledModelIds: ["missing/model"] },
    };
    const initial = availability;
    /** 現在の設定で消失サービスを含む表示を描画する。 */
    const props = () => ({
      provider: provider("opencode"),
      availability,
      providerEnabled: true,
      /** 消失IDの再有効化やUndoで通知された設定をそのまま保持する。 */ onChange:
        (next: ModelAvailabilitySettings) => {
          availability = next;
        },
      /** 一覧が消えた後もナビゲーションせず同じ画面でUndoを行う。 */ onBack:
        () => {},
    });
    await render(props());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="missing Models"]')!
        .click(),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="missing Model Actions"] button',
        )!
        .click(),
    );
    await render(props());
    assert.equal(document.querySelector('[aria-label="missing Models"]'), null);
    assert.deepEqual(availability.opencode.disabledModelIds, []);
    assert.equal(
      document.activeElement,
      document.querySelector('[aria-label="Search Models"]'),
    );
    const undo = [
      ...document.querySelectorAll<HTMLButtonElement>("header button"),
    ].find((element) => element.textContent === "Undo")!;
    assert.equal(undo.disabled, false);
    await act(async () => undo.click());
    await render(props());
    assert.deepEqual(availability, initial);
    assert.ok(document.querySelector('[aria-label="missing Models"]'));
  });
});
