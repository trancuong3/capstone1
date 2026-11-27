export type QualityHubTab = "metadata" | "reports" | "approval" | "user-books";

const VALID_TABS: readonly QualityHubTab[] = [
  "metadata",
  "reports",
  "approval",
  "user-books",
];

export function parseQualityHubTab(value?: string | null): QualityHubTab {
  if (value && (VALID_TABS as readonly string[]).includes(value)) {
    return value as QualityHubTab;
  }
  return "metadata";
}
