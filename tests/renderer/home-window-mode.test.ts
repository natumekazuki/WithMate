import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveHomeWindowModeFromSearch } from "../../src/home/home-window-mode.js";

describe("home-window-mode", () => {
  it("known mode を解決する", () => {
    assert.equal(resolveHomeWindowModeFromSearch("?mode=monitor"), "monitor");
    assert.equal(resolveHomeWindowModeFromSearch("?mode=settings"), "settings");
    assert.equal(resolveHomeWindowModeFromSearch("?mode=memory-review"), "memory-review");
  });

  it("unknown mode は home に戻す", () => {
    assert.equal(resolveHomeWindowModeFromSearch(""), "home");
    assert.equal(resolveHomeWindowModeFromSearch("?mode=memory"), "home");
    assert.equal(resolveHomeWindowModeFromSearch("?mode=mate-talk"), "home");
  });
});
