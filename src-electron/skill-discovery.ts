import fs from "node:fs";
import path from "node:path";

import type { DiscoveredSkill, DiscoveredSkillSource } from "../src/app-state.js";

type SkillRoot = {
  rootPath: string;
  source: DiscoveredSkillSource;
  sourceLabel: string;
};

const WORKSPACE_SKILL_ROOT_CANDIDATES = [
  "skills",
  ".github/skills",
  ".copilot/skills",
  ".codex/skills",
  ".claude/skills",
] as const;

function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function buildWorkspaceSkillRoots(workspacePath: string): SkillRoot[] {
  return WORKSPACE_SKILL_ROOT_CANDIDATES.map((relativePath) => ({
    rootPath: path.join(workspacePath, relativePath),
    source: "workspace" as const,
    sourceLabel: `workspace:${relativePath}`,
  }));
}

function parseFrontmatterValue(frontmatter: string, key: string): string {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter);
  if (!match) {
    return "";
  }

  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function parseSkillMarkdown(skillFilePath: string): { name: string; description: string } {
  const markdown = fs.readFileSync(skillFilePath, "utf8");
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1] ?? "";
    return {
      name: parseFrontmatterValue(frontmatter, "name"),
      description: parseFrontmatterValue(frontmatter, "description"),
    };
  }

  return {
    name: "",
    description: "",
  };
}

function toDisplayPath(workspacePath: string, source: DiscoveredSkillSource, skillDirectoryPath: string): string {
  if (source !== "workspace") {
    return normalizeSlashes(skillDirectoryPath);
  }

  const relativePath = path.relative(workspacePath, skillDirectoryPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return normalizeSlashes(skillDirectoryPath);
  }

  return normalizeSlashes(relativePath);
}

function discoverSkillsInRoot(workspacePath: string, root: SkillRoot): DiscoveredSkill[] {
  if (!root.rootPath || !fs.existsSync(root.rootPath) || !fs.statSync(root.rootPath).isDirectory()) {
    return [];
  }

  const entries = fs.readdirSync(root.rootPath, { withFileTypes: true });
  const skills: DiscoveredSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDirectoryPath = path.join(root.rootPath, entry.name);
    const skillFilePath = path.join(skillDirectoryPath, "SKILL.md");
    if (!fs.existsSync(skillFilePath) || !fs.statSync(skillFilePath).isFile()) {
      continue;
    }

    const parsed = parseSkillMarkdown(skillFilePath);
    const skillName = parsed.name || entry.name;
    skills.push({
      id: `${root.source}:${normalizeSlashes(skillDirectoryPath)}`,
      name: skillName,
      description: parsed.description,
      source: root.source,
      sourcePath: toDisplayPath(workspacePath, root.source, skillDirectoryPath),
      sourceLabel: root.sourceLabel,
    });
  }

  return skills;
}

export function discoverSessionSkills(workspacePath: string, providerSkillRootPath: string): DiscoveredSkill[] {
  const roots: SkillRoot[] = [
    ...buildWorkspaceSkillRoots(workspacePath),
    ...(providerSkillRootPath.trim()
      ? [
          {
            rootPath: providerSkillRootPath.trim(),
            source: "provider" as const,
            sourceLabel: "provider",
          },
        ]
      : []),
  ];

  const discovered = roots.flatMap((root) => discoverSkillsInRoot(workspacePath, root));
  const deduped = new Map<string, DiscoveredSkill>();

  for (const skill of discovered) {
    const normalizedName = skill.name.trim().toLowerCase();
    const existing = deduped.get(normalizedName);
    if (!existing) {
      deduped.set(normalizedName, skill);
      continue;
    }

    if (existing.source === "provider" && skill.source === "workspace") {
      deduped.set(normalizedName, skill);
    }
  }

  return Array.from(deduped.values()).sort((left, right) => {
    if (left.source !== right.source) {
      return left.source === "workspace" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}
