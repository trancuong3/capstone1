export type UUID = string;

export type ISODateTime = string;

export type ParentRole = "parent" | "admin";

export interface ParentProfileDTO {
  readonly id: UUID;
  readonly display_name: string | null;
  readonly role: ParentRole;
  readonly created_at: ISODateTime;
}

export interface ParentProfileUpdateInput {
  display_name: string | null;
}
