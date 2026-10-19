export type MetadataQualityIssueType =
  | "MISSING_TITLE"
  | "MISSING_AUTHOR"
  | "INVALID_GRADE_RANGE"
  | "POSSIBLE_DUPLICATE";

export type MetadataQualityLifecycleStatus = "ACTIVE" | "RETIRED";

export interface MetadataQualityBookIssueDTO {
  readonly id: string;
  readonly title: string | null;
  readonly author: string | null;
  readonly min_grade: number | null;
  readonly max_grade: number | null;
  readonly lifecycle_status: string;
  readonly issues: readonly MetadataQualityIssueType[];
}

export interface MetadataQualitySummaryDTO {
  readonly total_books: number;
  readonly books_with_issues: number;
  readonly missing_title: number;
  readonly missing_author: number;
  readonly invalid_grade_range: number;
  readonly possible_duplicate_groups: number;
  readonly books_in_duplicate_groups: number;
  readonly checked_at: string;
}

export interface MetadataQualityDashboardDTO {
  readonly summary: MetadataQualitySummaryDTO;
  readonly items: readonly MetadataQualityBookIssueDTO[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface MetadataQualityQuery {
  readonly search?: string;
  readonly issue_type?: MetadataQualityIssueType;
  readonly lifecycle_status?: MetadataQualityLifecycleStatus;
  readonly limit?: number;
  readonly offset?: number;
}
