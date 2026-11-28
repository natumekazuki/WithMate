import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveSelectedLaunchProviderDraftId,
  resolveSelectedLaunchProviderId,
} from "../../src/launch/launch-provider-selection.js";

/** 起動時の選択に使う識別子だけを持つプロバイダー。 */
type TestProvider = { id: string };

/** 起動フォームで、現在の選択を維持できる条件と代替値を確認する。 */
describe("launch-provider-selection", () => {
  /** 候補の並び順より、候補内に存在する現在の選択を優先する。 */
  it("現在の provider id が存在すればそれを優先する", () => {
    const providers: TestProvider[] = [{ id: "alpha" }, { id: "beta" }];

    assert.equal(resolveSelectedLaunchProviderId(providers, "beta"), "beta");
  });

  /** 現在の選択が候補から消えた場合に先頭の候補へ切り替える。 */
  it("存在しない provider id なら先頭の provider id を選ぶ", () => {
    const providers: TestProvider[] = [{ id: "alpha" }, { id: "beta" }];

    assert.equal(
      resolveSelectedLaunchProviderId(providers, "missing"),
      "alpha",
    );
  });

  /** 候補がなければ、選択された識別子を返さない。 */
  it("provider が空なら null を返す", () => {
    assert.equal(resolveSelectedLaunchProviderId([], "alpha"), null);
  });

  /** 下書きでは候補なしを空文字で表す。 */
  it("draft 用 provider id は provider が空なら空文字に正規化する", () => {
    assert.equal(resolveSelectedLaunchProviderDraftId([], ""), "");
  });
});
