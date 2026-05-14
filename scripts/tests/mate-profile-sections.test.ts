import assert from "node:assert/strict";
import test from "node:test";

import {
  MATE_PROFILE_SECTION_RULES,
  MATE_TALK_PROFILE_SECTION_KEYS,
  PROVIDER_INSTRUCTION_PROFILE_SECTION_KEYS,
  getMateProfileSectionRule,
  isMateProfileRuntimeSectionKey,
  isMateTalkProfileSectionKey,
  isProviderInstructionProfileSectionKey,
} from "../../src/mate/mate-profile-sections.js";

test("Mate Profile section rules は runtime section の責務と投影境界を固定する", () => {
  assert.deepEqual(
    MATE_PROFILE_SECTION_RULES.map((rule) => rule.sectionKey),
    ["core", "bond", "work_style", "notes"],
  );
  assert.equal(getMateProfileSectionRule("core").role.includes("自己定義"), true);
  assert.equal(getMateProfileSectionRule("bond").role.includes("関係性"), true);
  assert.equal(getMateProfileSectionRule("work_style").role.includes("作業時"), true);
  assert.equal(getMateProfileSectionRule("notes").role.includes("直接指示として扱わない"), true);
});

test("MateTalk は notes を含め、provider instruction は notes を含めない", () => {
  assert.deepEqual(MATE_TALK_PROFILE_SECTION_KEYS, ["core", "bond", "work_style", "notes"]);
  assert.deepEqual(PROVIDER_INSTRUCTION_PROFILE_SECTION_KEYS, ["core", "bond", "work_style"]);

  assert.equal(isMateTalkProfileSectionKey("notes"), true);
  assert.equal(isProviderInstructionProfileSectionKey("notes"), false);
  assert.equal(isProviderInstructionProfileSectionKey("project_digest"), false);
});

test("runtime section 判定は project_digest や未知 section を profile section として扱わない", () => {
  assert.equal(isMateProfileRuntimeSectionKey("core"), true);
  assert.equal(isMateProfileRuntimeSectionKey("notes"), true);
  assert.equal(isMateProfileRuntimeSectionKey("project_digest"), false);
  assert.equal(isMateProfileRuntimeSectionKey("unknown"), false);
});
