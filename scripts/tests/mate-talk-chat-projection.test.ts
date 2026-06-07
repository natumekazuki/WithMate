import assert from "node:assert/strict";
import test from "node:test";

import { buildMateTalkComposerCapabilityProps } from "../../src/chat/mate-talk-chat-projection.js";

test("buildMateTalkComposerCapabilityProps は runtime controls を表示し picker は隠す", () => {
  const onCollapse = () => {};
  const props = buildMateTalkComposerCapabilityProps({
    onCollapseActionDock: onCollapse,
  });

  assert.equal(props.showAttachmentControls, true);
  assert.equal(props.showAdditionalDirectoryControls, true);
  assert.equal(props.showExecutionModeControls, true);
  assert.equal(props.showCustomAgentPicker, false);
  assert.equal(props.showSkillPicker, false);
  assert.equal(props.canCollapseActionDock, true);
  assert.equal(props.onCollapse, onCollapse);
});

test("buildMateTalkComposerCapabilityProps は picker override を MateTalk 固有値で上書きする", () => {
  const props = buildMateTalkComposerCapabilityProps({
    composerCapabilityProps: {
      showCustomAgentPicker: true,
      showSkillPicker: true,
    },
    onCollapseActionDock: () => {},
  });

  assert.equal(props.showCustomAgentPicker, false);
  assert.equal(props.showSkillPicker, false);
});
