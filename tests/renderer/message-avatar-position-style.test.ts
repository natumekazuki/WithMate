import { readStylesheet } from "../support/read-stylesheet.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @test-value v2
// kind = "invariant"
// claim = "長いassistant messageのavatar stackはmessage listのscroll row内で追従し、狭い画面ではstatic配置になる"
// oracle = { type = "contract", ref = "conversation message avatar layout CSS" }
// fault = "avatar stackがmessage listのrow境界から外れる、または狭い画面でstickyが内容を覆う"
// observable = "session-message-listのoverflow、message-avatar-stackのsticky top、mobile media queryのstatic宣言とcomponent position mode"
// observation_boundary = "declaration"
// scope = "message-avatar-stack-position-css"
// lifecycle = "permanent"
// distinction = "message rendering内容やscroll eventではなく、avatarの位置拘束とresponsive fallbackを確認する"
// @end-test-value
test("長い assistant message の avatar stack は message list 内で row に拘束して追従する", async () => {
  const [componentSource, stylesSource] = await Promise.all([
    readFile("src/chat/conversation/session-message-column.tsx", "utf8"),
    readStylesheet(),
  ]);

  assert.match(componentSource, /directDomUpdatesMode:\s*"position"/);
  assert.match(
    stylesSource,
    /\.session-message-list\s*{[\s\S]*?overflow:\s*auto;[\s\S]*?}/,
  );
  assert.match(
    stylesSource,
    /\.message-avatar-stack\s*{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*8px;[\s\S]*?}/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width:\s*760px\)\s*{[\s\S]*?\.message-avatar-stack\s*{\s*position:\s*static;\s*}/,
  );
});
