import type { BookListItemDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type { ISODateTime, UUID } from "@/types/profile";
import type { HistorySessionSummaryDTO } from "@/types/reading";

export type DifficultWordPracticeStatus =
  "NOT_PRACTICED" | "IN_PROGRESS" | "NEEDS_MORE_PRACTICE" | "COMPLETED";

export type DifficultWordAssessmentStatus =
  "CORRECT" | "INCORRECT" | "UNCERTAIN" | "NO_CLEAR_AUDIO" | "ENGINE_ERROR";

export type DifficultWordRecognitionSource =
  | "SERVER_STT"
  | "SERVER_STT_KEYTERM"
  | "BROWSER_SPEECH"
  | "AUDIO_QUALITY_GATE"
  | "ENGINE_ERROR";

export interface DifficultWordSourceDTO {
  readonly book_id?: UUID | null;
  readonly visibility_scope?:
    "PUBLIC_CATALOG" | "PARENT_PRIVATE" | string | null;
  readonly is_private_book?: boolean | null;
  readonly book_title?: string | null;
  readonly book_author?: string | null;
  readonly min_grade?: number | null;
  readonly max_grade?: number | null;
  readonly book_cover_url?: string | null;
  readonly session_id?: UUID | null;
  readonly page_id?: UUID | null;
  readonly page_revision_id?: UUID | null;
  readonly page_number?: number | null;
  readonly word_id?: UUID | null;
  readonly context_phrase?: string | null;
  readonly last_seen_at: ISODateTime;
}

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
  readonly mispronunciation_count?: number;
  readonly encounter_count?: number;
  readonly practice_status?: DifficultWordPracticeStatus;
  readonly practice_attempts_count?: number;
  readonly practice_correct_count?: number;
  readonly practice_incorrect_count?: number;
  readonly practice_uncertain_count?: number;
  readonly consecutive_correct_count?: number;
  readonly last_practiced_at?: ISODateTime | null;
  readonly last_practice_status?: DifficultWordAssessmentStatus | null;
  readonly sources?: readonly DifficultWordSourceDTO[];
}

export interface DifficultWordEvaluateDirectInput {
  readonly request_id: UUID;
  readonly normalized_word: string;
  readonly display_text?: string;
  readonly context_phrase?: string | null;
  readonly audio?: Blob | null;
  readonly filename?: string;
  readonly audio_duration_ms?: number | null;
  readonly audio_quality_status?: string | null;
  readonly browser_transcript?: string | null;
  readonly browser_confidence?: number | null;
  readonly book_id?: UUID | null;
  readonly session_id?: UUID | null;
  readonly page_id?: UUID | null;
  readonly page_revision_id?: UUID | null;
  readonly word_id?: UUID | null;
  readonly evidence_word_ids?: readonly UUID[];
}

export interface DifficultWordBookGroup {
  readonly key: string;
  readonly bookId: UUID | null;
  readonly bookTitle: string;
  readonly bookAuthor: string | null;
  readonly bookCoverUrl: string | null;
  readonly minGrade: number | null;
  readonly maxGrade: number | null;
  readonly words: readonly DifficultWordDTO[];
  readonly totalWords: number;
  readonly completedWords: number;
  readonly progressPercent: number;
  readonly latestSeenAt: ISODateTime;
}

export interface DifficultWordPracticeStartInput {
  readonly request_id: UUID;
  readonly normalized_word: string;
  readonly display_text?: string;
  readonly evidence_word_ids?: readonly UUID[];
}

export interface DifficultWordPracticeCompleteInput {
  readonly completion_request_id: UUID;
  readonly assessment_status: DifficultWordAssessmentStatus;
  readonly recognition_source: DifficultWordRecognitionSource;
  readonly spoken_transcript?: string | null;
  readonly confidence?: number | null;
  readonly audio_duration_ms?: number | null;
}

export interface DifficultWordEvaluateAudioInput {
  readonly completion_request_id: UUID;
  readonly audio: Blob;
  readonly filename?: string;
  readonly audio_duration_ms?: number | null;
  readonly audio_quality_status?: string | null;
  readonly browser_transcript?: string | null;
  readonly browser_confidence?: number | null;
}

export interface DifficultWordProgressSummaryDTO {
  readonly normalized_word: string;
  readonly practice_status: DifficultWordPracticeStatus;
  readonly practice_attempts_count: number;
  readonly practice_correct_count: number;
  readonly practice_incorrect_count: number;
  readonly practice_uncertain_count: number;
  readonly consecutive_correct_count: number;
  readonly required_consecutive_correct: number;
  readonly last_practiced_at: ISODateTime | null;
  readonly last_practice_status: DifficultWordAssessmentStatus | null;
}

export interface DifficultWordPracticeAttemptDTO {
  readonly attempt_id: UUID;
  readonly child_id: UUID;
  readonly normalized_word: string;
  readonly display_text: string;
  readonly attempt_number: number;
  readonly state: "STARTED" | "COMPLETED";
  readonly assessment_status: DifficultWordAssessmentStatus | null;
  readonly recognition_source: DifficultWordRecognitionSource | null;
  readonly spoken_transcript: string | null;
  readonly confidence: number | null;
  readonly audio_duration_ms: number | null;
  readonly assessment_version: number;
  readonly evidence_word_ids: readonly UUID[];
  readonly book_id?: UUID | null;
  readonly session_id?: UUID | null;
  readonly page_id?: UUID | null;
  readonly page_revision_id?: UUID | null;
  readonly word_id?: UUID | null;
  readonly resolved_in_session?: boolean;
  readonly persistence_backend?:
    "PRACTICE_TABLE_AND_EVENT" | "PRACTICE_TABLE" | "READING_EVENT" | null;
  readonly started_at: ISODateTime;
  readonly completed_at: ISODateTime | null;
  readonly feedback_message: string | null;
  readonly word_progress: DifficultWordProgressSummaryDTO;
  readonly next_recommended_word: string | null;
  readonly evidence_count_unchanged: true;
}

export interface DifficultWordPracticeHistoryItemDTO {
  readonly attempt_id: UUID;
  readonly normalized_word: string;
  readonly display_text: string;
  readonly attempt_number: number;
  readonly state: "STARTED" | "COMPLETED";
  readonly assessment_status: DifficultWordAssessmentStatus | null;
  readonly recognition_source: DifficultWordRecognitionSource | null;
  readonly spoken_transcript: string | null;
  readonly confidence: number | null;
  readonly audio_duration_ms: number | null;
  readonly assessment_version: number;
  readonly started_at: ISODateTime;
  readonly completed_at: ISODateTime | null;
}

export interface DifficultWordPracticeHistoryDTO {
  readonly storage_ready: boolean;
  readonly items: readonly DifficultWordPracticeHistoryItemDTO[];
}

export interface ProgressPeriodSummaryDTO {
  readonly completed_sessions: number | null;
  readonly reading_duration_ms: number | null;
  readonly omission_count: number | null;
  readonly repetition_count: number | null;
  readonly long_pause_count: number | null;
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
  readonly assessment?:
    import("@/types/reading").ReadingAssessmentMetricsDTO | null;
  readonly assessment_coverage?: {
    readonly assessed_sessions: number;
    readonly total_sessions: number;
  } | null;
  readonly id: UUID;
  readonly generated_at: ISODateTime;
  readonly child_id: UUID;
  readonly period_start: string;
  readonly period_end: string;
  readonly difficult_words: readonly DifficultWordDTO[] | null;
  readonly previous_period: ProgressPeriodSummaryDTO | null;
  readonly trend_deltas: ProgressTrendDeltasDTO | null;
  readonly legacy: {
    readonly avg_fluency: number | null;
    readonly total_books: number | null;
  } | null;
  readonly data_status: "complete" | "partial" | "unsupported";
  readonly availability: {
    readonly metrics: ProgressAvailability;
    readonly difficult_words: ProgressAvailability;
    readonly comparison: ProgressAvailability;
  };
}

export type ProgressAvailability =
  "available" | "absent" | "partial" | "unsupported";
export interface ProgressPeriodOptionDTO {
  readonly id: UUID;
  readonly child_id: UUID;
  readonly period_start: string;
  readonly period_end: string;
  readonly generated_at: ISODateTime;
}
export interface ProgressPeriodsDTO {
  readonly items: readonly ProgressPeriodOptionDTO[];
  readonly next_cursor: string | null;
}

export interface ReportDateWindow {
  readonly period_start: string;
  readonly period_end: string;
  readonly days: number;
  readonly timezone: "Asia/Ho_Chi_Minh";
}

export interface SessionHistoryItemViewModelUI {
  readonly session: HistorySessionSummaryDTO;
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
