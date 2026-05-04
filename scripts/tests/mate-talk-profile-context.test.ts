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

  it("Profile Item が context に含まれ、section 順に並ぶ", async () => {
    const contextText = await buildMateTalkProfileContextText(
      {
        sections: [
          { sectionKey: "notes", filePath: "notes.md" },
          { sectionKey: "core", filePath: "core.md" },
        ],
        profileItems: [
          {
            sectionKey: "core",
            claimKey: "tone",
            renderedText: "丁寧語",
            projectionAllowed: true,
            state: "active",
            projectDigestId: null,
          },
          {
            sectionKey: "notes",
            claimKey: "personality",
            renderedText: "元気",
            projectionAllowed: true,
            state: "active",
            projectDigestId: null,
          },
          {
            sectionKey: "core",
            claimKey: "excluded",
            renderedText: "除外",
            projectionAllowed: false,
            state: "active",
            projectDigestId: null,
          },
        ],
      },
      {
        readSectionText: async (filePath) => {
          const map = new Map([
            ["core.md", "  コア  "],
            ["notes.md", "  補足  "],
          ]);
          return map.get(filePath) ?? "";
        },
      },
    );

    assert.ok(contextText?.includes("# core\nコア"));
    assert.ok(contextText?.includes("- **tone**\n  丁寧語"));
    assert.ok(contextText?.includes("# notes\n補足"));
    assert.ok(contextText?.includes("- **personality**\n  元気"));
    assert.equal(contextText?.includes("excluded"), false);
  });

  it("project_digest/projectionAllowed false/disabled 相当の item は除外される", async () => {
    const contextText = await buildMateTalkProfileContextText(
      {
        sections: [
          { sectionKey: "core", filePath: "core.md" },
        ],
        profileItems: [
          {
            sectionKey: "project_digest",
            claimKey: "project",
            renderedText: "プロジェクト情報",
            projectionAllowed: true,
            state: "active",
            projectDigestId: null,
          },
          {
            sectionKey: "core",
            claimKey: "disabled",
            renderedText: "有効じゃない",
            projectionAllowed: true,
            state: "disabled",
            projectDigestId: null,
          },
          {
            sectionKey: "core",
            claimKey: "private",
            renderedText: "非表示",
            projectionAllowed: false,
            state: "active",
            projectDigestId: null,
          },
          {
            sectionKey: "core",
            claimKey: "valid",
            renderedText: "有効",
            projectionAllowed: true,
            state: "active",
            projectDigestId: null,
          },
        ],
      },
      {
        readSectionText: async (filePath) => {
          const map = new Map([
            ["core.md", "  本体  "],
          ]);
          return map.get(filePath) ?? "";
        },
      },
    );

    assert.equal(contextText?.includes("- **project**"), false);
    assert.equal(contextText?.includes("- **disabled**"), false);
    assert.equal(contextText?.includes("- **private**"), false);
    assert.equal(contextText?.includes("- **valid**"), true);
  });

  it("project_digest section file は context から除外される", async () => {
    const contextText = await buildMateTalkProfileContextText(
      {
        sections: [
          { sectionKey: "core", filePath: "core.md" },
          { sectionKey: "project_digest", filePath: "project-digest.md" },
        ],
      },
      {
        readSectionText: async (filePath) => {
          const map = new Map([
            ["core.md", "  本体  "],
            ["project-digest.md", "  プロジェクト情報  "],
          ]);
          return map.get(filePath) ?? "";
        },
      },
    );

    assert.equal(contextText, "# core\n本体");
    assert.equal(contextText?.includes("project_digest"), false);
    assert.equal(contextText?.includes("プロジェクト情報"), false);
  });

  it("file section と Profile Item が両方ある場合は両方含まれる", async () => {
    const contextText = await buildMateTalkProfileContextText(
      {
        sections: [
          { sectionKey: "notes", filePath: "notes.md" },
          { sectionKey: "core", filePath: "core.md" },
          { sectionKey: "bond", filePath: "bond.md" },
        ],
        profileItems: [
          {
            sectionKey: "bond",
            claimKey: "first",
            renderedText: "1st",
            projectionAllowed: true,
            state: "active",
            projectDigestId: null,
          },
        ],
      },
      {
        readSectionText: async (filePath) => {
          const map = new Map([
            ["core.md", "  コア  "],
            ["bond.md", "  関係  "],
            ["notes.md", "  補足  "],
          ]);
          return map.get(filePath) ?? "";
        },
      },
    );

    const expectedPrefix = [
      "# core",
      "コア",
      "",
      "# bond",
      "関係",
      "- **first**",
      "  1st",
      "",
      "# notes",
      "補足",
    ].join("\n");

    assert.equal(contextText, expectedPrefix);
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
