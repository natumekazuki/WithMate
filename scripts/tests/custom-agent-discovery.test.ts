import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { discoverSessionCustomAgents, resolveSessionCustomAgentConfigs } from "../../src-electron/custom-agent-discovery.js";

const createdDirectories: string[] = [];

function createTempDir(): string {
  const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-custom-agent-discovery-"));
  createdDirectories.push(directoryPath);
  return directoryPath;
}

function writeCustomAgent(
  rootPath: string,
  fileName: string,
  {
    name,
    displayName,
    description,
    userInvocable,
    prompt,
  }: { name?: string; displayName?: string; description?: string; userInvocable?: boolean; prompt: string },
): void {
  fs.mkdirSync(rootPath, { recursive: true });
  const frontmatterLines = [
    "---",
    ...(name ? [`name: ${name}`] : []),
    ...(displayName ? [`displayName: ${displayName}`] : []),
    ...(description ? [`description: ${description}`] : []),
    ...(typeof userInvocable === "boolean" ? [`user-invocable: ${userInvocable ? "true" : "false"}`] : []),
    "---",
    "",
  ];
  fs.writeFileSync(
    path.join(rootPath, `${fileName}.agent.md`),
    [...frontmatterLines, prompt].join("\n"),
    "utf8",
  );
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    const directoryPath = createdDirectories.pop();
    if (directoryPath && fs.existsSync(directoryPath)) {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  }
});

describe("discoverSessionCustomAgents", () => {
  it("workspace root と global root をまとめて列挙できる", () => {
    const workspacePath = createTempDir();
    const homeDirectory = createTempDir();
    writeCustomAgent(path.join(workspacePath, ".github", "agents"), "reviewer", {
      displayName: "Reviewer",
      description: "workspace agent",
      userInvocable: true,
      prompt: "Review the code carefully.",
    });
    writeCustomAgent(path.join(homeDirectory, ".copilot", "agents"), "refactor", {
      displayName: "Refactorer",
      description: "global agent",
      userInvocable: true,
      prompt: "Refactor the code safely.",
    });

    const agents = discoverSessionCustomAgents(workspacePath, homeDirectory);

    assert.equal(agents.length, 2);
    assert.equal(agents[0]?.source, "workspace");
    assert.equal(agents[0]?.displayName, "Reviewer");
    assert.equal(agents[1]?.source, "global");
    assert.equal(agents[1]?.displayName, "Refactorer");
  });

  it("同名 agent は workspace を優先する", () => {
    const workspacePath = createTempDir();
    const homeDirectory = createTempDir();
    writeCustomAgent(path.join(workspacePath, ".github", "agents"), "reviewer", {
      name: "reviewer",
      displayName: "Workspace Reviewer",
      userInvocable: true,
      prompt: "workspace prompt",
    });
    writeCustomAgent(path.join(homeDirectory, ".copilot", "agents"), "reviewer", {
      name: "reviewer",
      displayName: "Global Reviewer",
      userInvocable: true,
      prompt: "global prompt",
    });

    const agents = discoverSessionCustomAgents(workspacePath, homeDirectory);
    const resolved = resolveSessionCustomAgentConfigs(workspacePath, "reviewer", homeDirectory);

    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.source, "workspace");
    assert.equal(resolved.selectedAgentName, "reviewer");
    assert.equal(resolved.customAgents[0]?.displayName, "Workspace Reviewer");
    assert.equal(resolved.customAgents[0]?.prompt, "workspace prompt");
  });

  it("picker には user-invocable: true の agent だけを出す", () => {
    const workspacePath = createTempDir();
    const homeDirectory = createTempDir();
    writeCustomAgent(path.join(workspacePath, ".github", "agents"), "reviewer", {
      displayName: "Reviewer",
      userInvocable: true,
      prompt: "workspace prompt",
    });
    writeCustomAgent(path.join(workspacePath, ".github", "agents"), "hidden", {
      displayName: "Hidden Agent",
      userInvocable: false,
      prompt: "hidden prompt",
    });
    writeCustomAgent(path.join(homeDirectory, ".copilot", "agents"), "implicit-hidden", {
      displayName: "Implicit Hidden",
      prompt: "implicit hidden prompt",
    });

    const agents = discoverSessionCustomAgents(workspacePath, homeDirectory);
    const resolved = resolveSessionCustomAgentConfigs(workspacePath, "hidden", homeDirectory);

    assert.deepEqual(agents.map((agent) => agent.displayName), ["Reviewer"]);
    assert.equal(resolved.customAgents.length, 3);
    assert.equal(resolved.selectedAgentName, "hidden");
  });
});
