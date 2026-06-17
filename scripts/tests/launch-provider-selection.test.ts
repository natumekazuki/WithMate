import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveSelectedLaunchProviderDraftId,
  resolveSelectedLaunchProviderId,
} from "../../src/launch/launch-provider-selection.js";

type TestProvider = { id: string };

describe("launch-provider-selection", () => {
  it("現在の provider id が存在すればそれを優先する", () => {
    const providers: TestProvider[] = [{ id: "alpha" }, { id: "beta" }];

    assert.equal(resolveSelectedLaunchProviderId(providers, "beta"), "beta");
  });

  it("存在しない provider id なら先頭の provider id を選ぶ", () => {
    const providers: TestProvider[] = [{ id: "alpha" }, { id: "beta" }];

    assert.equal(resolveSelectedLaunchProviderId(providers, "missing"), "alpha");
  });

  it("provider が空なら null を返す", () => {
    assert.equal(resolveSelectedLaunchProviderId([], "alpha"), null);
  });

  it("draft 用 provider id は provider が空なら空文字に正規化する", () => {
    assert.equal(resolveSelectedLaunchProviderDraftId([], ""), "");
  });
});
