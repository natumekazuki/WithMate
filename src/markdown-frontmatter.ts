export function formatMarkdownFrontmatterSource(value: string): string {
  const normalizedValue = value.replace(/\r\n?/g, "\n");
  return normalizedValue ? `---\n${normalizedValue}\n---` : "---\n---";
}
