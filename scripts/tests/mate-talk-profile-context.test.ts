import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMateTalkProfileContextText } from "../../src-electron/mate-talk-profile-context.js";

describe("buildMateTalkProfileContextText", () => {
  it("優先セクション(core,bond,work_style,notes)とアルファベット順でセクションを並べる", async () => {
    const profile = {
      sections: [
        { sectionKey: "notes", filePath: "notes.md" },
        { sectionKey: "work_style", filePath: "work-style.md" },
        { sectionKey: "beta", filePath: "beta.md" },
        { sectionKey: "core", filePath: "core.md" },
        { sectionKey: "alpha", filePath: "alpha.md" },
        { sectionKey: "bond", filePath: "bond.md" },
      ],
    };

    const contextText = await buildMateTalkProfileContextText(profile, {
      readSectionText: async (filePath) => {
        const map = new Map([
          ["core.md", "  ひだりの\ncore  "],
          ["bond.md", "  みぎの\nbond  "],
          ["work-style.md", "  作業\nwork_style  "],
          ["notes.md", "  補足\nnotes  "],
          ["alpha.md", "  補助\nalpha  "],
          ["beta.md", "  補助2\nbeta  "],
        ]);
        return map.get(filePath) ?? "";
      },
    });

    assert.equal(
      contextText,
      [
        "# core",
        "ひだりの\ncore",
        "",
        "# bond",
        "みぎの\nbond",
        "",
        "# work_style",
        "作業\nwork_style",
        "",
        "# notes",
        "補足\nnotes",
        "",
        "# alpha",
        "補助\nalpha",
        "",
        "# beta",
        "補助2\nbeta",
      ].join("\n"),
    );
  });

  it("空文字のセクションはスキップして内容付きだけを返す", async () => {
    const profile = {
      sections: [
        { sectionKey: "core", filePath: "core.md" },
        { sectionKey: "notes", filePath: "notes.md" },
      ],
    };
    const contextText = await buildMateTalkProfileContextText(profile, {
      readSectionText: async (filePath) => {
        const map = new Map([
          ["core.md", "   \n  "],
          ["notes.md", "  ノート  \n"],
        ]);
        return map.get(filePath) ?? "";
      },
    });

    assert.equal(contextText, "# notes\nノート");
  });

  it("読取失敗したセクションはスキップし、読み取り可能なセクションだけを返す", async () => {
    const profile = {
      sections: [
        { sectionKey: "core", filePath: "core.md" },
        { sectionKey: "notes", filePath: "notes.md" },
      ],
    };
    const contextText = await buildMateTalkProfileContextText(profile, {
      readSectionText: async (filePath) => {
        if (filePath === "core.md") {
          const error: NodeJS.ErrnoException = new Error("not found") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return "  ノート  ";
      },
    });

    assert.equal(contextText, "# notes\nノート");
  });

  it("有効な内容が1件も無い場合は null を返す", async () => {
    const profile = {
      sections: [
        { sectionKey: "core", filePath: "core.md" },
        { sectionKey: "notes", filePath: "notes.md" },
      ],
    };
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const contextText = await buildMateTalkProfileContextText(profile, {
        readSectionText: async (filePath) => {
          if (filePath === "core.md") {
            return "   ";
          }
          const error: NodeJS.ErrnoException = new Error("not found") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        },
      });

      assert.equal(contextText, null);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.[0], "Failed to read Mate profile section for MateTalk");
    } finally {
      console.warn = originalWarn;
    }
  });
});
