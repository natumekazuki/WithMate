import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { buildMateTalkProviderAdditionalDirectories } from "../../src-electron/mate-talk-reference-access.js";

describe("buildMateTalkProviderAdditionalDirectories", () => {
  it("MateTalk の file/image attachment は親ディレクトリを provider access に追加する", () => {
    const filePath = path.resolve("fixtures", "notes", "memo.md");
    const imagePath = path.resolve("fixtures", "images", "avatar.png");
    const folderPath = path.resolve("fixtures", "docs");
    const explicitDirectory = path.resolve("fixtures", "shared");

    assert.deepEqual(
      buildMateTalkProviderAdditionalDirectories({
        attachments: [
          { kind: "file", path: filePath },
          { kind: "image", path: imagePath },
          { kind: "folder", path: folderPath },
        ],
        additionalDirectories: [explicitDirectory],
      }),
      [
        explicitDirectory,
        path.dirname(filePath),
        path.dirname(imagePath),
        folderPath,
      ],
    );
  });

  it("重複と相対 attachment path は provider access へ追加しない", () => {
    const filePath = path.resolve("fixtures", "notes", "memo.md");

    assert.deepEqual(
      buildMateTalkProviderAdditionalDirectories({
        attachments: [
          { kind: "file", path: filePath },
          { kind: "image", path: path.join(path.dirname(filePath), "image.png") },
          { kind: "file", path: "relative.md" },
        ],
        additionalDirectories: [path.dirname(filePath)],
      }),
      [path.dirname(filePath)],
    );
  });
});
