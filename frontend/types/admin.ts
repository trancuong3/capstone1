import type { BookLifecycleStatus, BookListItemDTO } from "@/types/book";
import type { ISODateTime, UUID } from "@/types/profile";
import type { PageRevisionVerificationStatus } from "@/types/reading";

export interface AdminLoginRequest {
  readonly email: string;
  readonly password: string;
}

export interface AdminSessionUI {
  readonly actor_id: UUID;
  readonly role: "admin";
  readonly display_name: string;
}

export interface AdminBookCreateDTO {
  readonly title: string;
  readonly author: string | null;
  readonly min_grade: number;
  readonly max_grade: number;
}

export type AdminBookUpdateDTO = AdminBookCreateDTO;

export interface AdminBookQueryUI {
  readonly search?: string;
  readonly lifecycle_status?: BookLifecycleStatus;
  readonly verification_status?: PageRevisionVerificationStatus;
}

export interface AdminBookListItemUI {
  readonly book: BookListItemDTO;
  readonly page_count: number;
  readonly processing_count: number;
  readonly needs_review_count: number;
  readonly verified_count: number;
  readonly parent_catalog_eligible: boolean;
}

export interface AdminPageProcessingDTO {
  readonly page_id: UUID;
  readonly page_revision_id: UUID;
  readonly revision_no: number;
  readonly verification_status: PageRevisionVerificationStatus;
  readonly lifecycle_status: BookLifecycleStatus;
  readonly ocr_preview_metadata: Record<string, unknown>;
  readonly verified_at: ISODateTime | null;
  readonly current_verified_revision_id: UUID | null;
}

export interface AdminPageListItemUI {
  readonly book_id: UUID;
  readonly page_number: number;
  readonly processing: AdminPageProcessingDTO;
}

export interface AdminRevisionWordDTO {
  readonly word_index: number;
  readonly line_index: number;
  readonly text: string;
  readonly normalized_text: string;
  readonly bbox: readonly [number, number, number, number];
  readonly ocr_confidence: number | null;
}

export interface AdminPageRevisionDetailDTO {
  readonly page_id: UUID;
  readonly page_revision_id: UUID;
  readonly revision_no: number;
  readonly verification_status: PageRevisionVerificationStatus;
  readonly lifecycle_status: BookLifecycleStatus;
  readonly draft_text: string | null;
  readonly words: readonly AdminRevisionWordDTO[];
  readonly ocr_metadata: Record<string, unknown>;
  readonly created_at: ISODateTime;
  readonly verified_at: ISODateTime | null;
  readonly verified_by: UUID | null;
}

export interface AdminRevisionSummaryUI {
  readonly page_revision_id: UUID;
  readonly revision_no: number;
  readonly verification_status: PageRevisionVerificationStatus;
  readonly created_at: ISODateTime;
  readonly is_current_verified: boolean;
}

export interface AdminPageImageUI {
  readonly page_id: UUID;
  readonly page_number: number;
  readonly preview_url: string;
  readonly width: number;
  readonly height: number;
}

export interface AdminPageUploadInputUI {
  readonly client_id: string;
  readonly file_name: string;
  readonly mime_type: "image/jpeg" | "image/png" | "image/webp";
  readonly size_bytes: number;
  readonly page_number: number;
  readonly width: number;
  readonly height: number;
}

export interface AdminPageUploadProgressUI {
  readonly client_id: string;
  readonly progress_percent: number;
  readonly status: "QUEUED" | "UPLOADING" | "PROCESSING" | "FAILED";
}

export interface AdminRevisionVerifyRequestDTO {
  readonly page_revision_id: UUID;
  readonly corrected_text: string;
  readonly words: readonly AdminRevisionWordDTO[];
}

export interface StatusPatchDTO {
  readonly status: BookLifecycleStatus;
}

export interface AuditLogDTO {
  readonly id: UUID;
  readonly actor_id: UUID | null;
  readonly action: string;
  readonly resource_type: string;
  readonly resource_id: UUID | null;
  readonly request_id: string | null;
  readonly created_at: ISODateTime;
  readonly metadata: Record<string, unknown>;
}

export interface AuditLogQueryUI {
  readonly action?: string;
  readonly resource_type?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AuditLogPageDTO {
  readonly items: readonly AuditLogDTO[];
  readonly next_cursor: string | null;
}

export type OperationalHealthStatusUI = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";

export interface HealthServiceItemUI {
  readonly id: string;
  readonly label: string;
  readonly status: OperationalHealthStatusUI;
  readonly checked_at: ISODateTime;
  readonly safe_message: string;
}

export interface HealthSnapshotUI {
  readonly overall_status: OperationalHealthStatusUI;
  readonly checked_at: ISODateTime;
  readonly services: readonly HealthServiceItemUI[];
}

export type AdminMockScenario =
  | "default"
  | "loading"
  | "empty"
  | "error"
  | "no-result"
  | "invalid-credentials"
  | "unauthenticated"
  | "forbidden"
  | "invalid-upload"
  | "upload-failure"
  | "invalid-lifecycle"
  | "ocr-reprocess-invalid-state"
  | "degraded"
  | "unavailable";

export type AdminBookDTO = BookListItemDTO;
