import type { MateProfile, MateProfileSectionState } from "../src/mate-state.js";
import type {
  MateProfileItem,
  MateProfileItemCategory,
  MateProfileItemSectionKey,
} from "./mate-profile-item-storage.js";

type RenderableSectionKey = Exclude<MateProfileItemSectionKey, "project_digest">;

export type MateProfileRenderedFile = {
  sectionKey: RenderableSectionKey;
  relativePath: string;
  content: string;
};

const RENDERABLE_SECTION_KEYS: readonly RenderableSectionKey[] = ["core", "bond", "work_style", "notes"];

const SECTION_TITLES: Readonly<Record<RenderableSectionKey, string>> = {
  core: "Core",
  bond: "Bond",
  work_style: "Work Style",
  notes: "Notes",
};

const CATEGORY_TITLES: Readonly<Record<MateProfileItemCategory, string>> = {
  persona: "Persona",
  voice: "Voice",
  preference: "Preference",
  relationship: "Relationship",
  work_style: "Work Style",
  boundary: "Boundary",
  project_context: "Project Context",
  note: "Note",
};

export function renderMateProfileFiles(
  profile: MateProfile,
  items: readonly MateProfileItem[],
): MateProfileRenderedFile[] {
  const itemsBySection = groupRenderableItems(items);

  return RENDERABLE_SECTION_KEYS.map((sectionKey) => {
    const section = findProfileSection(profile.sections, sectionKey);
    const sectionItems = itemsBySection.get(sectionKey) ?? [];

    return {
      sectionKey,
      relativePath: relativeProfilePath(section.filePath),
      content: renderSection(profile, sectionKey, sectionItems),
    };
  });
}

function groupRenderableItems(items: readonly MateProfileItem[]): Map<RenderableSectionKey, MateProfileItem[]> {
  const itemsBySection = new Map<RenderableSectionKey, MateProfileItem[]>();

  for (const item of items) {
    if (!isRenderableSection(item.sectionKey) || item.state !== "active" || !item.projectionAllowed) {
      continue;
    }

    const existing = itemsBySection.get(item.sectionKey) ?? [];
    existing.push(item);
    itemsBySection.set(item.sectionKey, existing);
  }

  for (const [sectionKey, sectionItems] of itemsBySection.entries()) {
    itemsBySection.set(sectionKey, [...sectionItems].sort(compareProfileItemsForRender));
  }

  return itemsBySection;
}

function renderSection(
  profile: MateProfile,
  sectionKey: RenderableSectionKey,
  items: readonly MateProfileItem[],
): string {
  const lines: string[] = [`# ${SECTION_TITLES[sectionKey]}`];

  if (sectionKey === "core") {
    lines.push("", "## Identity", `- Name: ${singleLine(profile.displayName)}`);
    const description = singleLine(profile.description);
    if (description) {
      lines.push(`- Description: ${description}`);
    }
  }

  const itemsByCategory = groupByCategory(items);
  for (const [category, categoryItems] of itemsByCategory.entries()) {
    lines.push("", `## ${CATEGORY_TITLES[category]}`);
    for (const item of categoryItems) {
      lines.push(`- ${singleLine(item.renderedText)}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function groupByCategory(items: readonly MateProfileItem[]): Map<MateProfileItemCategory, MateProfileItem[]> {
  const categories = new Map<MateProfileItemCategory, MateProfileItem[]>();
  for (const item of items) {
    const existing = categories.get(item.category) ?? [];
    existing.push(item);
    categories.set(item.category, existing);
  }

  return categories;
}

function compareProfileItemsForRender(left: MateProfileItem, right: MateProfileItem): number {
  const categoryOrder = CATEGORY_TITLES[left.category].localeCompare(CATEGORY_TITLES[right.category]);
  if (categoryOrder !== 0) {
    return categoryOrder;
  }

  const salienceOrder = right.salienceScore - left.salienceScore;
  if (salienceOrder !== 0) {
    return salienceOrder;
  }

  const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedOrder !== 0) {
    return updatedOrder;
  }

  return left.id.localeCompare(right.id);
}

function findProfileSection(
  sections: readonly MateProfileSectionState[],
  sectionKey: RenderableSectionKey,
): MateProfileSectionState {
  const section = sections.find((candidate) => candidate.sectionKey === sectionKey);
  if (!section) {
    throw new Error(`Mate profile section が見つからないよ: ${sectionKey}`);
  }
  return section;
}

function isRenderableSection(sectionKey: MateProfileItemSectionKey): sectionKey is RenderableSectionKey {
  return (RENDERABLE_SECTION_KEYS as readonly string[]).includes(sectionKey);
}

function relativeProfilePath(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const mateSegmentIndex = normalizedPath.indexOf("/mate/");
  if (mateSegmentIndex >= 0) {
    return normalizedPath.slice(mateSegmentIndex + 1);
  }

  const withoutDrive = normalizedPath.replace(/^[A-Za-z]:\//, "");
  return withoutDrive.startsWith("/") ? withoutDrive.slice(1) : withoutDrive;
}

function singleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
