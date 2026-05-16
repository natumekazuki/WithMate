import type { MateProfile } from "../src/mate/mate-state.js";
import { renderMateProfileFiles } from "./mate-profile-file-renderer.js";
import type { MateProfileItem } from "./mate-profile-item-storage.js";

export function buildMateProviderInstructionProfileSectionReader(
  profile: MateProfile,
  profileItems: readonly MateProfileItem[],
): (section: MateProfile["sections"][number]) => Promise<string | null> {
  const sectionTextByKey = new Map<string, string>(
    renderMateProfileFiles(profile, profileItems.filter((item) => item.state === "active"))
      .map((file) => [file.sectionKey, file.content]),
  );

  return async (section) => sectionTextByKey.get(section.sectionKey) ?? null;
}
