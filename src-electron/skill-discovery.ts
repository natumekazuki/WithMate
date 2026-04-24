import fs from "node:fs";
import path from "node:path";

import type { DiscoveredSkill, DiscoveredSkillSource } from "../src/app-state.js";

type SkillRoot = {
  rootPath: string;
  source: DiscoveredSkillSource;
  sourceLabel: string;
};

type CachedSkillRoot = {
  fingerprint: string;
  skills: DiscoveredSkill[];
};

type CachedSkillDiscovery = {
  fingerprint: string;
  skills: DiscoveredSkill[];
};

const WORKSPACE_SKILL_ROOT_CANDIDATES = [
  "skills",
  ".github/skills",
  ".copilot/skills",
  ".codex/skills",
  ".claude/skills",
] as const;

const skillRootCache = new Map<string, CachedSkillRoot>();
const skillDiscoveryCache = new Map<string, CachedSkillDiscovery>();

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

async function parseSkillMarkdown(skillFilePath: string): Promise<{ name: string; description: string }> {
  const markdown = await fs.promises.readFile(skillFilePath, "utf8");
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

function getSkillRootCacheKey(root: SkillRoot): string {
  return `${root.source}:${root.sourceLabel}:${normalizeSlashes(path.resolve(root.rootPath))}`;
}

function getSkillDiscoveryCacheKey(workspacePath: string, providerSkillRootPath: string | null): string {
  return [
    normalizeSlashes(path.resolve(workspacePath)),
    normalizeSlashes(path.resolve(providerSkillRootPath?.trim() || ".")),
  ].join("|");
}

async function statFileIfExists(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}

async function buildSkillRootFingerprint(rootPath: string): Promise<string> {
  const rootStats = await statFileIfExists(rootPath);
  if (!rootStats?.isDirectory()) {
    return "missing";
  }

  const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  const entryFingerprints = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const skillDirectoryPath = path.join(rootPath, entry.name);
      const skillDirectoryStats = await statFileIfExists(skillDirectoryPath);
      const skillFilePath = path.join(skillDirectoryPath, "SKILL.md");
      const skillFileStats = await statFileIfExists(skillFilePath);
      const skillFingerprint = skillFileStats?.isFile()
        ? `file:${skillFileStats.mtimeMs}:${skillFileStats.size}`
        : "missing";

      return [
        entry.name,
        skillDirectoryStats?.mtimeMs ?? 0,
        skillDirectoryStats?.size ?? 0,
        skillFingerprint,
      ].join(":");
    }));

  return [
    rootStats.mtimeMs,
    rootStats.size,
    ...entryFingerprints.sort(),
  ].join("|");
}

function cloneSkills(skills: DiscoveredSkill[]): DiscoveredSkill[] {
  return skills.map((skill) => ({ ...skill }));
}

async function discoverSkillsInRoot(workspacePath: string, root: SkillRoot): Promise<DiscoveredSkill[]> {
  const rootStats = root.rootPath ? await statFileIfExists(root.rootPath) : null;
  if (!rootStats?.isDirectory()) {
    return [];
  }

  const entries = await fs.promises.readdir(root.rootPath, { withFileTypes: true });
  const skills: DiscoveredSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDirectoryPath = path.join(root.rootPath, entry.name);
    const skillFilePath = path.join(skillDirectoryPath, "SKILL.md");
    const skillFileStats = await statFileIfExists(skillFilePath);
    if (!skillFileStats?.isFile()) {
      continue;
    }

    const parsed = await parseSkillMarkdown(skillFilePath);
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

async function discoverSkillsInRootCached(
  workspacePath: string,
  root: SkillRoot,
): Promise<{ fingerprint: string; skills: DiscoveredSkill[] }> {
  const fingerprint = await buildSkillRootFingerprint(root.rootPath);
  const cacheKey = getSkillRootCacheKey(root);
  const cached = skillRootCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) {
    return {
      fingerprint,
      skills: cloneSkills(cached.skills),
    };
  }

  const skills = await discoverSkillsInRoot(workspacePath, root);
  skillRootCache.set(cacheKey, {
    fingerprint,
    skills: cloneSkills(skills),
  });

  return {
    fingerprint,
    skills,
  };
}

function dedupeAndSortSkills(discovered: DiscoveredSkill[]): DiscoveredSkill[] {
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

export async function discoverSessionSkills(
  workspacePath: string,
  providerSkillRootPath: string | null,
): Promise<DiscoveredSkill[]> {
  const normalizedProviderSkillRootPath = providerSkillRootPath?.trim() ?? "";
  const roots: SkillRoot[] = [
    ...buildWorkspaceSkillRoots(workspacePath),
    ...(normalizedProviderSkillRootPath
      ? [
          {
            rootPath: normalizedProviderSkillRootPath,
            source: "provider" as const,
            sourceLabel: "provider",
          },
        ]
      : []),
  ];

  const rootResults = await Promise.all(roots.map((root) => discoverSkillsInRootCached(workspacePath, root)));
  const fingerprint = rootResults.map((result) => result.fingerprint).join("||");
  const cacheKey = getSkillDiscoveryCacheKey(workspacePath, providerSkillRootPath);
  const cached = skillDiscoveryCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) {
    return cloneSkills(cached.skills);
  }

  const skills = dedupeAndSortSkills(rootResults.flatMap((result) => result.skills));
  skillDiscoveryCache.set(cacheKey, {
    fingerprint,
    skills: cloneSkills(skills),
  });

  return skills;
}
