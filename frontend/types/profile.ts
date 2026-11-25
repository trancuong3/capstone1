import type { ChildProfileDTO } from "@/types/child";

export type UUID = string;

export type ISODateTime = string;

export type ParentRole = "parent" | "admin";

export type ContactInfoStatus =
  "available" | "not_configured" | "user_not_found" | "lookup_failed";

export interface ParentProfileChildDTO {
  readonly id: UUID;
  readonly alias: string;
  readonly grade: number;
  readonly created_at: ISODateTime;
  readonly avatar_url?: string | null;
}

export interface ParentProfileDTO {
  readonly id: UUID;
  readonly display_name: string | null;
  readonly role: ParentRole;
  readonly created_at: ISODateTime;
  readonly email: string | null;
  readonly contact_phone: string | null;
  readonly pending_email: string | null;
  readonly email_verified: boolean | null;
  readonly contact_info_status: ContactInfoStatus;
  readonly children: readonly ParentProfileChildDTO[];
  readonly avatar_url?: string | null;
}

export interface ParentProfileUpdateInput {
  display_name: string | null;
}

export interface DashboardLatestSessionDTO {
  readonly id: UUID;
  readonly child_id: UUID;
  readonly book_id: UUID;
  readonly book_title: string | null;
  readonly state: string;
  readonly started_at: ISODateTime | null;
  readonly ended_at: ISODateTime | null;
  readonly resumable: boolean;
}

export interface DashboardSummaryDTO {
  readonly profile: ParentProfileDTO | null;
  readonly children: ChildProfileDTO[];
  readonly latest_sessions_by_child: Record<
    string,
    DashboardLatestSessionDTO | null
  >;
  readonly source: "dashboard-summary" | "fallback";
}
