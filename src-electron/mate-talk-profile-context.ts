import { readFile } from "node:fs/promises";

const MATE_TALK_PROFILE_SECTION_ORDER = ["core", "bond", "work_style", "notes"] as const;
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

type ProfileForMateTalkContext = {
  sections: ProfileSection[];
};

type BuildMateTalkProfileContextDeps = {
  readSectionText?: (filePath: string) => Promise<string>;
};

export async function buildMateTalkProfileContextText(
  profile: ProfileForMateTalkContext,
  deps: BuildMateTalkProfileContextDeps = {},
): Promise<string | null> {
  const readSectionText = deps.readSectionText ?? ((filePath: string) => readFile(filePath, "utf8"));

  const sectionTexts = await Promise.all(
    [...profile.sections]
      .sort(compareMateProfileSectionForMateTalk)
      .map(async (section) => {
        const content = await readMateProfileSectionTextForMateTalk(
          section.filePath,
          section.sectionKey,
          readSectionText,
        );
        if (!content) {
          return null;
        }
        return `# ${section.sectionKey}\n${content}`;
      }),
  );

  const availableSections = sectionTexts.filter((entry): entry is string => Boolean(entry));
  return availableSections.length > 0 ? availableSections.join("\n\n") : null;
}

function compareMateProfileSectionForMateTalk(
  left: { sectionKey: string },
  right: { sectionKey: string },
): number {
  const leftPriority = MATE_TALK_PROFILE_SECTION_PRIORITY.get(left.sectionKey);
  const rightPriority = MATE_TALK_PROFILE_SECTION_PRIORITY.get(right.sectionKey);
  if (leftPriority === rightPriority) {
    return left.sectionKey.localeCompare(right.sectionKey);
  }
  return (leftPriority ?? Number.MAX_SAFE_INTEGER) - (rightPriority ?? Number.MAX_SAFE_INTEGER);
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
