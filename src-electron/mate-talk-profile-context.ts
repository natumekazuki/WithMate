import { readFile } from "node:fs/promises";

const MATE_TALK_PROFILE_SECTION_ORDER = ["core", "bond", "work_style", "notes"] as const;
const MATE_TALK_PROFILE_ITEM_DEFAULT_LIMIT = 40;
const MATE_TALK_PROFILE_SECTION_PRIORITY = MATE_TALK_PROFILE_SECTION_ORDER.reduce(
  (accumulator, sectionKey, index) => {
    accumulator.set(sectionKey, index);
    return accumulator;
  },
  new Map<string, number>(),
);

type ProfileSection = {
  sectionKey: string;
  filePath: string;
};

type ProfileItem = {
  sectionKey: string;
  claimKey: string;
  renderedText: string;
  state?: "active" | "disabled" | "forgotten" | "superseded" | null;
  projectionAllowed?: boolean;
  projectDigestId?: string | null;
};

type ProfileForMateTalkContext = {
  sections: ProfileSection[];
  profileItems?: ProfileItem[];
};

type BuildMateTalkProfileContextDeps = {
  readSectionText?: (filePath: string) => Promise<string>;
  profileItemLimit?: number;
};

export async function buildMateTalkProfileContextText(
  profile: ProfileForMateTalkContext,
  deps: BuildMateTalkProfileContextDeps = {},
): Promise<string | null> {
  const readSectionText = deps.readSectionText ?? ((filePath: string) => readFile(filePath, "utf8"));
  const profileItemLimit = resolveProfileItemLimit(deps.profileItemLimit);

  const sectionFileEntries = await Promise.all(
    [...profile.sections].map(async (section) => {
      const content = await readMateProfileSectionTextForMateTalk(
        section.filePath,
        section.sectionKey,
        readSectionText,
      );
      if (!content) {
        return null;
      }
      return { sectionKey: section.sectionKey, content };
    }),
  );
  const filteredProfileItems = [...(profile.profileItems ?? [])]
    .filter((item) => isMateTalkProfileItemAllowed(item))
    .sort(compareMateProfileItemForMateTalk)
    .slice(0, profileItemLimit) ?? [];

  const allSectionKeys = new Set<string>();
  for (const section of profile.sections) {
    allSectionKeys.add(section.sectionKey);
  }
  for (const item of filteredProfileItems) {
    allSectionKeys.add(item.sectionKey);
  }

  const sectionContents = new Map<string, string>();
  for (const sectionText of sectionFileEntries) {
    if (sectionText) {
      sectionContents.set(sectionText.sectionKey, sectionText.content);
    }
  }

  const itemGroups = new Map<string, ProfileItem[]>();
  for (const item of filteredProfileItems) {
    const values = itemGroups.get(item.sectionKey) ?? [];
    values.push(item);
    itemGroups.set(item.sectionKey, values);
  }
  for (const values of itemGroups.values()) {
    values.sort(compareMateProfileItemForMateTalk);
  }

  const entries = [...allSectionKeys]
    .sort(compareMateProfileSectionForMateTalk)
    .map((sectionKey) => {
      const sectionHeader = `# ${sectionKey}`;
      const sectionContent = sectionContents.get(sectionKey);
      const renderedItems = (itemGroups.get(sectionKey) ?? [])
        .map((item) => renderMateProfileItemForMateTalk(item))
        .filter((entry): entry is string => Boolean(entry));
      const hasSectionContent = Boolean(sectionContent);
      const hasProfileItems = renderedItems.length > 0;
      if (!hasSectionContent && !hasProfileItems) {
        return null;
      }

      const chunks: string[] = [];
      chunks.push(sectionHeader);
      if (hasSectionContent) {
        chunks.push(sectionContent ?? "");
      }
      if (hasProfileItems) {
        chunks.push(renderedItems.join("\n"));
      }
      return chunks.join("\n");
    });

  const availableSections = entries.filter((entry): entry is string => Boolean(entry));
  return availableSections.length > 0 ? availableSections.join("\n\n") : null;
}

function compareMateProfileSectionForMateTalk(
  left: { sectionKey: string } | string,
  right: { sectionKey: string } | string,
): number {
  const leftSectionKey = typeof left === "string" ? left : left.sectionKey;
  const rightSectionKey = typeof right === "string" ? right : right.sectionKey;
  const leftPriority = MATE_TALK_PROFILE_SECTION_PRIORITY.get(leftSectionKey);
  const rightPriority = MATE_TALK_PROFILE_SECTION_PRIORITY.get(rightSectionKey);
  if (leftPriority === rightPriority) {
    return leftSectionKey.localeCompare(rightSectionKey);
  }
  return (leftPriority ?? Number.MAX_SAFE_INTEGER) - (rightPriority ?? Number.MAX_SAFE_INTEGER);
}

function compareMateProfileItemForMateTalk(left: ProfileItem, right: ProfileItem): number {
  const sectionCompare = compareMateProfileSectionForMateTalk(left, right);
  if (sectionCompare !== 0) {
    return sectionCompare;
  }
  return left.claimKey.localeCompare(right.claimKey);
}

function isMateTalkProfileItemAllowed(item: ProfileItem): boolean {
  if (item.sectionKey === "project_digest") {
    return false;
  }
  if (item.state !== undefined && item.state !== null && item.state !== "active") {
    return false;
  }
  if (item.projectionAllowed !== undefined && item.projectionAllowed !== true) {
    return false;
  }
  if (item.projectDigestId !== undefined && item.projectDigestId !== null) {
    return false;
  }
  return item.claimKey.trim().length > 0 && item.renderedText.trim().length > 0;
}

function renderMateProfileItemForMateTalk(item: ProfileItem): string | null {
  const claimKey = item.claimKey.trim();
  const renderedText = item.renderedText.trim();
  if (!claimKey || !renderedText) {
    return null;
  }
  const indented = renderedText
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `- **${claimKey}**\n${indented}`;
}

function resolveProfileItemLimit(value?: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return MATE_TALK_PROFILE_ITEM_DEFAULT_LIMIT;
}

async function readMateProfileSectionTextForMateTalk(
  filePath: string,
  sectionKey: string,
  readSectionText: BuildMateTalkProfileContextDeps["readSectionText"],
): Promise<string | null> {
  try {
    const content = await readSectionText?.(filePath);
    if (content === undefined) {
      return null;
    }

    const trimmed = content.trim();
    return trimmed || null;
  } catch (error) {
    const errnoError = error as NodeJS.ErrnoException | undefined;
    if (errnoError?.code !== "ENOENT") {
      console.warn("Failed to read Mate profile section for MateTalk", sectionKey, filePath, error);
    }
    return null;
  }
}
