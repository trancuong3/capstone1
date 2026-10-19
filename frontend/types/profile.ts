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
}

export interface ParentProfileUpdateInput {
  display_name: string | null;
}
