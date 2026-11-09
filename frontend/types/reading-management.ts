export type ReadingGoalMetric = "MINUTES" | "SESSIONS";
export type ReadingGoalPeriod = "DAILY" | "WEEKLY";
export type ReadingGoalStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "ENDED";
export type ReadingPlanStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "ENDED";
export type ReadingReminderEmailStatus =
  "NOT_REQUESTED" | "PENDING" | "SENDING" | "RETRY" | "SENT" | "FAILED";
export type BookCollectionType = "FAVORITE" | "WANT_TO_READ";
/** Derived from dates and status by the backend (not stored). */
export type ReadingItemPhase = "UPCOMING" | "RUNNING" | "EXPIRED" | "FINISHED";

export interface ReadingGoalDTO {
  id: string;
  child_id: string;
  metric: ReadingGoalMetric;
  target_value: number;
  period: ReadingGoalPeriod;
  starts_on: string;
  ends_on: string | null;
  timezone: string;
  status: ReadingGoalStatus;
  current_value: number;
  progress_percent: number;
  completed_value?: number | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
  phase?: ReadingItemPhase;
  streak_cycles?: number;
  cycle_starts_on?: string | null;
  cycle_ends_on?: string | null;
}
export interface ReadingPlanDTO {
  id: string;
  child_id: string;
  book_id: string | null;
  book_title: string | null;
  title: string;
  target_minutes: number;
  weekdays: number[];
  starts_on: string;
  ends_on: string | null;
  timezone: string;
  status: ReadingPlanStatus;
  scheduled_days_this_week: number;
  completed_days_this_week: number;
  progress_percent: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  phase?: ReadingItemPhase;
  next_scheduled_date?: string | null;
  is_scheduled_today?: boolean;
  minutes_today?: number;
}
export interface BookSummaryDTO {
  id: string;
  title: string;
  author: string | null;
  min_grade: number;
  max_grade: number;
  lifecycle_status: "ACTIVE" | "RETIRED";
  available_to_read: boolean;
}
export interface ChildBookCollectionDTO {
  id: string;
  child_id: string;
  book_id: string;
  collection_type: BookCollectionType;
  created_at: string;
  book: BookSummaryDTO;
}
export interface ReadingReminderDTO {
  id: string;
  child_id: string;
  remind_at: string;
  weekdays: number[];
  timezone: string;
  is_active: boolean;
  email_enabled: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface ReadingReminderOccurrenceDTO {
  id: string;
  reminder_id: string;
  scheduled_local_date: string;
  scheduled_for: string;
  status: "PENDING" | "ACKNOWLEDGED";
  acknowledged_at: string | null;
  email_status: ReadingReminderEmailStatus;
  email_attempts: number;
  email_sent_at: string | null;
  email_error_code: string | null;
  reminder: ReadingReminderDTO | null;
}
export interface ReadingGoalCreateDTO {
  child_id: string;
  metric: ReadingGoalMetric;
  target_value: number;
  period: ReadingGoalPeriod;
  starts_on: string;
  ends_on: string | null;
  timezone: string;
}
export interface ReadingPlanCreateDTO {
  child_id: string;
  book_id: string | null;
  title: string;
  target_minutes: number;
  weekdays: number[];
  starts_on: string;
  ends_on: string | null;
  timezone: string;
}
export interface ReadingPlanUpdateDTO {
  book_id?: string | null;
  title?: string;
  target_minutes?: number;
  weekdays?: number[];
  ends_on?: string | null;
  timezone?: string;
}
export interface ReadingReminderWriteDTO {
  child_id?: string;
  remind_at?: string;
  weekdays?: number[];
  timezone?: string;
  is_active?: boolean;
  email_enabled?: boolean;
}
