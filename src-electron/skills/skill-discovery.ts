import fs from "node:fs";
import path from "node:path";

import type {
  DiscoveredSkill,
  DiscoveredSkillSource,
} from "../../src-shared/session/runtime-state.js";

/** 探索ディレクトリと、検出したスキルに付ける出所情報。 */
type SkillRoot = {
  rootPath: string;
  source: DiscoveredSkillSource;
  sourceLabel: string;
};

/** ルート直下の変更を検出する照合値と、そのルートで見つけたスキル。 */
type CachedSkillRoot = {
  fingerprint: string;
  skills: DiscoveredSkill[];
};

/** 探索対象全体の照合値と、重複解消・整列済みのスキル一覧。 */
type CachedSkillDiscovery = {
  fingerprint: string;
  skills: DiscoveredSkill[];
};

const WORKSPACE_SKILL_ROOT_CANDIDATES = [
  ".agents/skills",
  ".github/skills",
  "skills",
  ".copilot/skills",
  ".codex/skills",
  ".claude/skills",
  ".opencode/skills",
] as const;

const skillRootCache = new Map<string, CachedSkillRoot>();
const skillDiscoveryCache = new Map<string, CachedSkillDiscovery>();

/** 表示パスや識別子に使う区切りをスラッシュに統一する。 */
function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** ワークスペース配下で探索する既定のディレクトリと出所ラベルを組み立てる。 */
function buildWorkspaceSkillRoots(workspacePath: string): SkillRoot[] {
  return WORKSPACE_SKILL_ROOT_CANDIDATES.map((relativePath) => ({
    rootPath: path.join(workspacePath, relativePath),
    source: "workspace" as const,
    sourceLabel: `workspace:${relativePath}`,
  }));
}

/** 先頭メタデータの指定キーから単一行の値を取得し、値がなければ空文字列を返す。 */
function parseFrontmatterValue(frontmatter: string, key: string): string {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter);
  if (!match) {
    return "";
  }

  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

/** SKILL.md の先頭メタデータから名前と説明を読み取る。先頭にメタデータがなければ両方を空にする。 */
async function parseSkillMarkdown(
  skillFilePath: string,
): Promise<{ name: string; description: string }> {
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

/** ワークスペース内のスキルは相対パスで表示し、範囲外やプロバイダー由来のスキルは元のパスを使う。 */
function toDisplayPath(
  workspacePath: string,
  source: DiscoveredSkillSource,
  skillDirectoryPath: string,
): string {
  if (source !== "workspace") {
    return normalizeSlashes(skillDirectoryPath);
  }

  const relativePath = path.relative(workspacePath, skillDirectoryPath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return normalizeSlashes(skillDirectoryPath);
  }

  return normalizeSlashes(relativePath);
}

/** 出所・出所ラベル・絶対パスを組み合わせてルート別キャッシュを区別する。 */
function getSkillRootCacheKey(root: SkillRoot): string {
  return `${root.source}:${root.sourceLabel}:${normalizeSlashes(path.resolve(root.rootPath))}`;
}

/** ワークスペースとプロバイダー側の探索ルートの組み合わせをキャッシュキーにする。 */
function getSkillDiscoveryCacheKey(
  workspacePath: string,
  providerSkillRootPath: string | null,
): string {
  return [
    normalizeSlashes(path.resolve(workspacePath)),
    normalizeSlashes(path.resolve(providerSkillRootPath?.trim() || ".")),
  ].join("|");
}

/** ファイル情報を取得し、取得に失敗した場合は存在しない場合と同様に扱う。 */
async function statFileIfExists(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}

/** 探索ルートと直下の各ディレクトリ・SKILL.md の更新時刻やサイズを照合値にし、列挙順の違いを無視する。 */
async function buildSkillRootFingerprint(rootPath: string): Promise<string> {
  const rootStats = await statFileIfExists(rootPath);
  if (!rootStats?.isDirectory()) {
    return "missing";
  }

  const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  const entryFingerprints = await Promise.all(
    entries
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
      }),
  );

  return [rootStats.mtimeMs, rootStats.size, ...entryFingerprints.sort()].join(
    "|",
  );
}

/** 呼び出し側で項目を書き換えてもキャッシュを汚さないよう、一覧と各項目を複製する。 */
function cloneSkills(skills: DiscoveredSkill[]): DiscoveredSkill[] {
  return skills.map((skill) => ({ ...skill }));
}

/** ルートの直下から SKILL.md を持つディレクトリを列挙し、名前が空ならディレクトリ名を使う。 */
async function discoverSkillsInRoot(
  workspacePath: string,
  root: SkillRoot,
): Promise<DiscoveredSkill[]> {
  const rootStats = root.rootPath
    ? await statFileIfExists(root.rootPath)
    : null;
  if (!rootStats?.isDirectory()) {
    return [];
  }

  const entries = await fs.promises.readdir(root.rootPath, {
    withFileTypes: true,
  });
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

/** ルートの照合値が一致する場合はキャッシュの複製を返し、変化したルートだけ再探索する。 */
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

/** 名前の前後の空白と大小文字を無視して重複を解消し、ワークスペース由来を優先して出所・名前順に並べる。 */
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

/** ワークスペースと指定されたプロバイダー側を探索し、ルートの照合値が変わらない場合は統合済み一覧を再利用する。 */
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

  const rootResults = await Promise.all(
    roots.map((root) => discoverSkillsInRootCached(workspacePath, root)),
  );
  const fingerprint = rootResults
    .map((result) => result.fingerprint)
    .join("||");
  const cacheKey = getSkillDiscoveryCacheKey(
    workspacePath,
    providerSkillRootPath,
  );
  const cached = skillDiscoveryCache.get(cacheKey);
  if (cached?.fingerprint === fingerprint) {
    return cloneSkills(cached.skills);
  }

  const skills = dedupeAndSortSkills(
    rootResults.flatMap((result) => result.skills),
  );
  skillDiscoveryCache.set(cacheKey, {
    fingerprint,
    skills: cloneSkills(skills),
  });

  return skills;
}
