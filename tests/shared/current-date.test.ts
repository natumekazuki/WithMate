import assert from "node:assert/strict";
import { it } from "node:test";
import { formatCurrentDateTime } from "../../src-electron/session/current-date.js";

// @test-value v2
// kind = "contract"
// claim = "UTC offset付き日時は日付境界と非整数時間offsetでも同じ瞬間を表す"
// oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
// fault = "年月日やoffset符号を誤り別の瞬間を表示する"
// observable = "整形ISO日時とDate.parse結果"
// observation_boundary = "public-boundary"
// scope = "現在日時のoffset整形"
// lifecycle = "permanent"
// @end-test-value
it("offsetと日付境界を含む現在日時を整形する", () => {
  const date = new Date("2026-12-31T23:45:12.345Z");
  for (const [offset, expected] of [[540, "2027-01-01T08:45:12.345+09:00"], [-210, "2026-12-31T20:15:12.345-03:30"], [0, "2026-12-31T23:45:12.345+00:00"]] as const) {
    const actual = formatCurrentDateTime(date, offset); assert.equal(actual, expected); assert.equal(Date.parse(actual), date.getTime());
  }
  assert.equal(formatCurrentDateTime(date), formatCurrentDateTime(date, -date.getTimezoneOffset()));
});
