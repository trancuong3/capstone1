import type { UUID } from "@/types/profile";

export type BookLifecycleStatus = "ACTIVE" | "RETIRED";

export interface BookListItemDTO {
  readonly id: UUID;
  readonly title: string;
  readonly author: string | null;
  readonly min_grade: number;
  readonly max_grade: number;
  readonly lifecycle_status: BookLifecycleStatus;
}

// Parent-facing preview metadata is delivered through BookPagePreviewDTO.
// This keeps mutable Admin/OCR fields out of the detail contract.
export type BookDetailDTO = BookListItemDTO;

export interface BookPagePreviewDTO {
  readonly page_id: UUID;
  readonly page_number: number;
  readonly lifecycle_status: BookLifecycleStatus;
  readonly current_verified_revision_id: UUID;
  readonly preview_url: string;
}

export interface BookCatalogQuery {
  readonly search?: string;
  readonly author?: string;
  readonly grade?: number;
}
