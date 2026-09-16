import type { BookListItemDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type { ISODateTime, UUID } from "@/types/profile";
import type { ReadingSessionSummaryDTO } from "@/types/reading";

export interface DifficultWordDTO {
  readonly normalized_word: string;
  readonly display_text: string;
  readonly difficulty_score: number;
  readonly omission_count: number;
  readonly repetition_count: number;
  readonly long_pause_count: number;
  readonly read_example_count: number;
  readonly session_count: number;
  readonly last_seen_at: ISODateTime;
  readonly evidence_word_ids: readonly UUID[];
}

export interface ProgressPeriodSummaryDTO {
  readonly completed_sessions: number;
  readonly reading_duration_ms: number;
  readonly omission_count: number;
  readonly repetition_count: number;
  readonly long_pause_count: number;
  readonly omission_rate: number | null;
  readonly repetition_rate: number | null;
  readonly long_pause_rate: number | null;
  readonly comprehension_accuracy: number | null;
}

export interface ProgressTrendDeltasDTO {
  readonly completed_sessions: number | null;
  readonly reading_duration_ms: number | null;
  readonly omission_rate: number | null;
  readonly repetition_rate: number | null;
  readonly long_pause_rate: number | null;
  readonly comprehension_accuracy: number | null;
}

export interface ProgressReportDTO extends ProgressPeriodSummaryDTO {
  readonly child_id: UUID;
  readonly period_start: string;
  readonly period_end: string;
  readonly difficult_words: readonly DifficultWordDTO[];
  readonly previous_period: ProgressPeriodSummaryDTO | null;
  readonly trend_deltas: ProgressTrendDeltasDTO;
}

export interface ReportDateWindow {
  readonly period_start: string;
  readonly period_end: string;
  readonly days: number;
  readonly timezone: "Asia/Ho_Chi_Minh";
}

export interface SessionHistoryItemViewModelUI {
  readonly session: ReadingSessionSummaryDTO;
  readonly book: BookListItemDTO;
  readonly child: ChildProfileDTO;
  readonly started_label: string;
  readonly duration_label: string;
  readonly state_label: string;
}

export interface MetricViewModelUI {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly unavailable: boolean;
}

export interface DifficultWordPracticeResultUI {
  readonly normalized_word: string;
  readonly action_id: UUID;
  readonly message: string;
  readonly evidence_count_unchanged: true;
}

export type Group5DemoState =
  | "default"
  | "loading"
  | "empty"
  | "error"
  | "not-found"
  | "no-prior-period"
  | "incomplete"
  | "no-events"
  | "no-questions"
  | "insufficient-evidence";
