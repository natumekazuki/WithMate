import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildActionDockCompactPreview } from "../../src/action-dock-preview.js";

describe("action dock compact preview", () => {
  it("空白を正規化して下書きなしを超過しない範囲で表示する", () => {
    const preview = buildActionDockCompactPreview("  a   b \n c  ", false);

    assert.equal(preview, "a b c");
  });

  it("84 文字超は App 仕様の ellipsis で短縮する", () => {
    const draft = "a".repeat(85);

    assert.equal(buildActionDockCompactPreview(draft, false), `${"a".repeat(84)}…`);
  });

  it("実行中は suffix と関係なく 実行中 を返す", () => {
    assert.equal(buildActionDockCompactPreview("   ", true), "実行中");
    assert.equal(buildActionDockCompactPreview("   ", true, { truncationSuffix: "..." }), "実行中");
  });

  it("下書きがない場合は suffix と関係なく 下書きなし を返す", () => {
    assert.equal(buildActionDockCompactPreview("   \n", false), "下書きなし");
    assert.equal(buildActionDockCompactPreview("   \n", false, { truncationSuffix: "..." }), "下書きなし");
  });

  it("CompanionReview 側は ... で短縮する", () => {
    assert.equal(buildActionDockCompactPreview("b".repeat(90), false, { truncationSuffix: "..." }), `${"b".repeat(84)}...`);
  });
});
