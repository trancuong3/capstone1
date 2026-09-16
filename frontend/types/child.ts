import type { ISODateTime, UUID } from "@/types/profile";

export const CHILD_GRADES = [1, 2, 3, 4, 5] as const;

export interface ChildProfileDTO {
  readonly id: UUID;
  readonly parent_id: UUID;
  readonly alias: string;
  readonly grade: number;
  readonly settings: Record<string, unknown>;
  readonly created_at: ISODateTime;
}

export interface ChildProfileCreateDTO {
  alias: string;
  grade: number;
  settings?: Record<string, unknown>;
}

export interface ChildProfilePatchDTO {
  alias?: string;
  grade?: number;
  settings?: Record<string, unknown>;
}

export function isChildGrade(value: number): boolean {
  return CHILD_GRADES.some((grade) => grade === value);
}
