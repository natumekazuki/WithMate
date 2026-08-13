import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("長い assistant message の avatar stack は message list 内で row に拘束して追従する", async () => {
  const [componentSource, stylesSource] = await Promise.all([
    readFile("src/session-components.tsx", "utf8"),
    readFile("src/styles.css", "utf8"),
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
