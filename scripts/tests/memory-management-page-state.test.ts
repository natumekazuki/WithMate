import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getMemoryManagementCursor,
  normalizeMemoryManagementPages,
} from "../../src/memory/memory-management-page-state.js";

describe("memory-management-page-state", () => {
  it("mate_profile page がない legacy result を補完する", () => {
    const pages = normalizeMemoryManagementPages({
      session: { nextCursor: 10, hasMore: true, total: 20 },
      project: { nextCursor: null, hasMore: false, total: 1 },
      character: { nextCursor: null, hasMore: false, total: 2 },
    });

    assert.deepEqual(pages.mate_profile, { nextCursor: null, hasMore: false, total: 0 });
    assert.equal(getMemoryManagementCursor(pages, "session"), 10);
    assert.equal(getMemoryManagementCursor(pages, "mate_profile"), null);
  });
});
