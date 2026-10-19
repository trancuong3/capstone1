export type ReadingGoalMetric = "MINUTES" | "SESSIONS";
export type ReadingGoalPeriod = "DAILY" | "WEEKLY";
export type ReadingGoalStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "ENDED";
export type BookCollectionType = "FAVORITE" | "WANT_TO_READ";

export interface ReadingGoalDTO {
  id: string; child_id: string; metric: ReadingGoalMetric; target_value: number;
  period: ReadingGoalPeriod; starts_on: string; ends_on: string | null; timezone: string;
  status: ReadingGoalStatus; current_value: number; progress_percent: number;
  completed_value?: number | null; completed_at?: string | null;
  created_at: string; updated_at: string;
}
export interface BookSummaryDTO {
  id: string; title: string; author: string | null; min_grade: number; max_grade: number;
  lifecycle_status: "ACTIVE" | "RETIRED"; available_to_read: boolean;
}
export interface ChildBookCollectionDTO {
  id: string; child_id: string; book_id: string; collection_type: BookCollectionType;
  created_at: string; book: BookSummaryDTO;
}
export interface ReadingReminderDTO {
  id: string; child_id: string; remind_at: string; weekdays: number[]; timezone: string;
  is_active: boolean; deleted_at: string | null; created_at: string; updated_at: string;
}
export interface ReadingReminderOccurrenceDTO {
  id: string; reminder_id: string; scheduled_local_date: string; scheduled_for: string;
  status: "PENDING" | "ACKNOWLEDGED"; acknowledged_at: string | null; reminder: ReadingReminderDTO | null;
}
export interface ReadingGoalCreateDTO {
  child_id: string; metric: ReadingGoalMetric; target_value: number; period: ReadingGoalPeriod;
  starts_on: string; ends_on: string | null; timezone: string;
}
export interface ReadingReminderWriteDTO {
  child_id?: string; remind_at?: string; weekdays?: number[]; timezone?: string; is_active?: boolean;
}
