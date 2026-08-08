import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChangedFileTree,
  changedFileDisplayName,
} from "../../src/file-explorer/changed-file-tree.js";
import type { FileRootGitChangeEntry } from "../../src/file-explorer/file-explorer-contract.js";

const entries: FileRootGitChangeEntry[] = [
  {
    relativePath: "README.md",
    previousRelativePath: null,
    kinds: { "working-tree": "modified" },
    scopes: ["working-tree"],
  },
  {
    relativePath: "src/zeta.ts",
    previousRelativePath: null,
    kinds: { staged: "modified" },
    scopes: ["staged"],
  },
  {
    relativePath: "src/components/Button.tsx",
    previousRelativePath: null,
    kinds: { "working-tree": "untracked" },
    scopes: ["working-tree"],
  },
  {
    relativePath: "docs/guide.md",
    previousRelativePath: null,
    kinds: { "working-tree": "modified" },
    scopes: ["working-tree"],
  },
  {
    relativePath: "src/alpha.ts",
    previousRelativePath: "legacy/old-alpha.ts",
    kinds: { "working-tree": "renamed" },
    scopes: ["working-tree"],
  },
];

test("buildChangedFileTree は scope を分離し directory-first の階層へ投影する", () => {
  const tree = buildChangedFileTree(entries, "working-tree");

  assert.deepEqual(tree.map((node) => [node.type, node.name]), [
    ["directory", "docs"],
    ["directory", "src"],
    ["file", "README.md"],
  ]);
  const src = tree[1];
  assert.equal(src?.type, "directory");
  if (src?.type !== "directory") {
    return;
  }
  assert.deepEqual(src.children.map((node) => [node.type, node.name]), [
    ["directory", "components"],
    ["file", "alpha.ts"],
  ]);
  assert.equal(src.children.some((node) => node.name === "zeta.ts"), false);
});

test("buildChangedFileTree は同名の directory と file を別nodeとして保持する", () => {
  const replacementEntries: FileRootGitChangeEntry[] = [
    {
      relativePath: "target",
      previousRelativePath: null,
      kinds: { staged: "deleted" },
      scopes: ["staged"],
    },
    {
      relativePath: "target/new.txt",
      previousRelativePath: null,
      kinds: { staged: "added" },
      scopes: ["staged"],
    },
  ];

  assert.deepEqual(
    buildChangedFileTree(replacementEntries, "staged").map((node) => [node.type, node.name]),
    [["directory", "target"], ["file", "target"]],
  );
});

test("changedFileDisplayName は rename の旧名と新名を表示する", () => {
  const renamed = entries.find((entry) => entry.previousRelativePath);
  assert.ok(renamed);
  assert.equal(changedFileDisplayName(renamed), "old-alpha.ts → alpha.ts");
  assert.equal(changedFileDisplayName(entries[0]!), "README.md");
});
