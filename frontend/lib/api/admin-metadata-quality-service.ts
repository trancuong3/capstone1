import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import type {
  MetadataQualityDashboardDTO,
  MetadataQualityQuery,
} from "@/types/metadata-quality";

const issueTypeSchema = z.enum([
  "MISSING_TITLE",
  "MISSING_AUTHOR",
  "INVALID_GRADE_RANGE",
  "POSSIBLE_DUPLICATE",
]);

const responseSchema = z.object({
  summary: z.object({
    total_books: z.number().int().nonnegative(),
    books_with_issues: z.number().int().nonnegative(),
    missing_title: z.number().int().nonnegative(),
    missing_author: z.number().int().nonnegative(),
    invalid_grade_range: z.number().int().nonnegative(),
    possible_duplicate_groups: z.number().int().nonnegative(),
    books_in_duplicate_groups: z.number().int().nonnegative(),
    checked_at: z.iso.datetime({ offset: true }),
  }),
  items: z.array(
    z.object({
      id: z.guid(),
      title: z.string().nullable(),
      author: z.string().nullable(),
      min_grade: z.number().int().nullable(),
      max_grade: z.number().int().nullable(),
      lifecycle_status: z.string(),
      issues: z.array(issueTypeSchema).min(1),
    }),
  ),
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().nonnegative(),
});

export interface AdminMetadataQualityService {
  get(query?: MetadataQualityQuery): Promise<MetadataQualityDashboardDTO>;
}

export function createAdminMetadataQualityService(): AdminMetadataQualityService {
  return {
    get: (query) =>
      requestApi(
        "/books/admin/metadata-quality" +
          apiQuery({
            search: query?.search,
            issue_type: query?.issue_type,
            lifecycle_status: query?.lifecycle_status,
            limit: query?.limit,
            offset: query?.offset,
          }),
        responseSchema,
      ),
  };
}
