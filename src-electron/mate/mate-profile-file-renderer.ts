import type {
  MateProfile,
  MateProfileSectionState,
} from "../../src-shared/mate/mate-state.js";
import {
  getMateProfileSectionRule,
  isMateProfileRuntimeSectionKey,
  MATE_PROFILE_SECTION_KEYS,
  type MateProfileRuntimeSectionKey,
} from "../../src-shared/mate/mate-profile-sections.js";
import type {
  MateProfileItem,
  MateProfileItemCategory,
  MateProfileItemSectionKey,
} from "./mate-profile-item-storage.js";

/** プロフィールの投影先を指定する区分、相対パス、生成済み Markdown 本文。 */
export type MateProfileRenderedFile = {
  sectionKey: MateProfileRuntimeSectionKey;
  relativePath: string;
  content: string;
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
const PROJECT_DIGEST_MARKDOWN_HEADER = "### Project Digest";

/** 全プロフィール区分の Markdown を、投影を許可された有効項目から再生成する。 */
export function renderMateProfileFiles(
  profile: MateProfile,
  items: readonly MateProfileItem[],
): MateProfileRenderedFile[] {
  const itemsBySection = groupRenderableItems(items);

  return MATE_PROFILE_SECTION_KEYS.map((sectionKey) => {
    const section = findProfileSection(profile.sections, sectionKey);
    const sectionItems = itemsBySection.get(sectionKey) ?? [];

    return {
      sectionKey,
      relativePath: relativeProfilePath(section.filePath),
      content: renderSection(profile, sectionKey, sectionItems),
    };
  });
}

/** 指定プロジェクトの有効かつ投影可能な Digest 項目を、主張キー順、同じキーでは更新の新しい順で出力する。 */
export function renderProjectDigestProjectionText(
  projectDigestId: string,
  options?: { items?: readonly MateProfileItem[] },
): string {
  const items = (options?.items ?? []).filter(
    (item) =>
      item.sectionKey === "project_digest" &&
      item.projectDigestId === projectDigestId &&
      item.state === "active" &&
      item.projectionAllowed,
  );

  const sortedItems = [...items].sort((left, right) => {
    const keyOrder = left.claimKey.localeCompare(right.claimKey);
    if (keyOrder !== 0) {
      return keyOrder;
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });

  return [
    PROJECT_DIGEST_MARKDOWN_HEADER,
    ...sortedItems.map(
      (item) => `- **${item.claimKey}:** ${item.renderedText}`,
    ),
  ].join("\n");
}

/** ファイルに投影できる有効項目だけを区分別に集約し、出力順に整える。 */
function groupRenderableItems(
  items: readonly MateProfileItem[],
): Map<MateProfileRuntimeSectionKey, MateProfileItem[]> {
  const itemsBySection = new Map<
    MateProfileRuntimeSectionKey,
    MateProfileItem[]
  >();

  for (const item of items) {
    if (
      !isRenderableSection(item.sectionKey) ||
      item.state !== "active" ||
      !item.projectionAllowed
    ) {
      continue;
    }

    const existing = itemsBySection.get(item.sectionKey) ?? [];
    existing.push(item);
    itemsBySection.set(item.sectionKey, existing);
  }

  for (const [sectionKey, sectionItems] of itemsBySection.entries()) {
    itemsBySection.set(
      sectionKey,
      [...sectionItems].sort(compareProfileItemsForRender),
    );
  }

  return itemsBySection;
}

/** 区分名とカテゴリ別項目を Markdown に組み立て、core 区分だけに Mate の識別情報を添える。 */
function renderSection(
  profile: MateProfile,
  sectionKey: MateProfileRuntimeSectionKey,
  items: readonly MateProfileItem[],
): string {
  const lines: string[] = [`# ${getMateProfileSectionRule(sectionKey).title}`];

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

/** 出力順に並んだ項目をカテゴリでまとめ、各カテゴリ内の順序を保持する。 */
function groupByCategory(
  items: readonly MateProfileItem[],
): Map<MateProfileItemCategory, MateProfileItem[]> {
  const categories = new Map<MateProfileItemCategory, MateProfileItem[]>();
  for (const item of items) {
    const existing = categories.get(item.category) ?? [];
    existing.push(item);
    categories.set(item.category, existing);
  }

  return categories;
}

/** 表示カテゴリ名、重要度の降順、更新日時の降順、項目 ID の順で投影順を決める。 */
function compareProfileItemsForRender(
  left: MateProfileItem,
  right: MateProfileItem,
): number {
  const categoryOrder = CATEGORY_TITLES[left.category].localeCompare(
    CATEGORY_TITLES[right.category],
  );
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

/** 投影先パスを持つ区分定義を引き、必須区分が欠けていれば失敗させる。 */
function findProfileSection(
  sections: readonly MateProfileSectionState[],
  sectionKey: MateProfileRuntimeSectionKey,
): MateProfileSectionState {
  const section = sections.find(
    (candidate) => candidate.sectionKey === sectionKey,
  );
  if (!section) {
    throw new Error(`Mate profile section が見つからないよ: ${sectionKey}`);
  }
  return section;
}

/** 項目の区分がプロフィールファイルへの投影対象かを判定する。 */
function isRenderableSection(
  sectionKey: MateProfileItemSectionKey,
): sectionKey is MateProfileRuntimeSectionKey {
  return isMateProfileRuntimeSectionKey(sectionKey);
}

/** 区切りをスラッシュにそろえ、mate ディレクトリを含む場合はそこからの相対パスに変換する。 */
function relativeProfilePath(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const mateSegmentIndex = normalizedPath.indexOf("/mate/");
  if (mateSegmentIndex >= 0) {
    return normalizedPath.slice(mateSegmentIndex + 1);
  }

  const withoutDrive = normalizedPath.replace(/^[A-Za-z]:\//, "");
  return withoutDrive.startsWith("/") ? withoutDrive.slice(1) : withoutDrive;
}

/** 空白や改行を一つの空白にまとめ、Markdown の箇条書きに収まる一行に整える。 */
function singleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
