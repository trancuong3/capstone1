import type { BookPagePreviewDTO } from "@/types/book";
import type { ISODateTime, UUID } from "@/types/profile";

export type ReadingSessionState =
  | "CREATED"
  | "PAGE_READY"
  | "LISTENING"
  | "PAUSED"
  | "RECONNECTING"
  | "QUESTIONING"
  | "FINISHED"
  | "ABORTED";

export interface ReadingSessionSummaryDTO {
  readonly id: UUID;
  readonly child_id: UUID;
  readonly book_id: UUID;
  readonly state: ReadingSessionState;
  readonly started_at: ISODateTime;
  readonly ended_at: ISODateTime | null;
  readonly duration_ms: number | null;
}

export interface HistorySessionSummaryDTO extends Omit<
  ReadingSessionSummaryDTO,
  "state"
> {
  readonly state: ReadingSessionState | "IN_PROGRESS";
}

export type ReadingSession = ReadingSessionSummaryDTO;

export interface ReadingSessionCreateDTO {
  readonly child_id: UUID;
  readonly book_id: UUID;
  readonly mode: "realtime";
  readonly selected_page_id?: UUID;
  readonly selected_page_revision_id?: UUID;
  /** Last page selected for this session; omitted requests remain one-page sessions. */
  readonly end_page_id?: UUID;
}

export type ReadingSessionPageStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED";

export interface ReadingSessionPageProgressItemDTO {
  readonly page_id: UUID;
  readonly page_revision_id: UUID;
  readonly page_number: number;
  readonly page_order: number;
  readonly status: ReadingSessionPageStatus;
  readonly started_at: ISODateTime | null;
  readonly completed_at: ISODateTime | null;
}

export interface ReadingSessionPageProgressDTO {
  readonly session_id: UUID;
  readonly persisted: boolean;
  readonly start_page_id: UUID;
  readonly end_page_id: UUID;
  readonly current_page_id: UUID;
  readonly start_page_number: number;
  readonly end_page_number: number;
  readonly current_page_number: number;
  readonly current_index: number;
  readonly total_pages: number;
  readonly completed_pages: number;
  readonly pages: readonly ReadingSessionPageProgressItemDTO[];
}

export interface ReadingSessionCreateResponseDTO {
  readonly session_id: UUID;
  readonly state: "PAGE_READY";
  readonly selected_page_id: UUID;
  readonly selected_page_revision_id: UUID;
  readonly started_at: ISODateTime;
}

export type WordBoundingBox = readonly [
  x: number,
  y: number,
  width: number,
  height: number,
];

export interface ReadingPageWordDTO {
  readonly word_id: UUID;
  readonly word_index: number;
  readonly text: string;
  readonly bbox: WordBoundingBox;
  /** Optional for compatibility with older cached/API fixtures. */
  readonly line_index?: number;
}

export interface ReadingPageDTO {
  readonly page_id: UUID;
  readonly page_revision_id: UUID;
  readonly page_number: number;
  readonly confidence: number | null;
  readonly width: number;
  readonly height: number;
  readonly image_url?: string | null;
  readonly text?: string;
  readonly words: readonly ReadingPageWordDTO[];
  /** Zero-based line indices that begin a new paragraph. */
  readonly paragraph_start_line_indices?: readonly number[];
  /** Zero-based line indices with image-derived first-line indentation. */
  readonly indented_line_indices?: readonly number[];
}

export type ReadingPage = ReadingPageDTO;
export type PageRevisionWord = ReadingPageWordDTO;
export type PageMatchResult = ReadingPageDTO;

export type PageRevisionVerificationStatus =
  "PROCESSING" | "NEEDS_REVIEW" | "VERIFIED";

export interface PageRevision {
  readonly id: UUID;
  readonly page_id: UUID;
  readonly revision_no: number;
  readonly verification_status: PageRevisionVerificationStatus;
  readonly lifecycle_status: "ACTIVE" | "RETIRED";
}

export interface SourceSpanDTO {
  readonly start_word_index: number;
  readonly end_word_index_exclusive: number;
  readonly sentence_index: number | null;
}

export type ComprehensionQuestionType = "FACTUAL" | "CLOZE" | "VOCABULARY";

export interface ComprehensionQuestionDTO {
  readonly id: UUID;
  readonly type: ComprehensionQuestionType;
  readonly prompt: string;
  readonly page_revision_id: UUID;
  readonly source_span: SourceSpanDTO;
  readonly difficulty: number;
  readonly answered: boolean;
}

export type ComprehensionQuestion = ComprehensionQuestionDTO;

export interface ComprehensionAnswerResultDTO {
  readonly answer_id: UUID;
  readonly question_id: UUID;
  readonly submitted_answer: string;
  readonly is_correct: boolean | null;
  readonly score: number | null;
  readonly feedback_code: string | null;
}

export type AnswerResult = ComprehensionAnswerResultDTO;

export type TutorActionType =
  "NO_FEEDBACK" | "IMMEDIATE_FEEDBACK" | "DELAYED_FEEDBACK" | "READ_EXAMPLE";

export interface TutorAction {
  readonly action: TutorActionType;
  readonly page_revision_word_id?: UUID;
  readonly message_code?: string;
  readonly tts_text?: string;
  readonly action_id?: UUID;
}

export type ReadingControlAction =
  "start" | "pause" | "resume" | "finish" | "abort";

// The lowercase values below are local presentation states, not API wire values.
export type ReadingUiState =
  | "ready"
  | "reading"
  | "camera-denied"
  | "microphone-denied"
  | "page-confidence-low"
  | "manual-page"
  | "paused"
  | "reconnecting"
  | "stt-error"
  | "tts-error"
  | "page-turn"
  | "question"
  | "complete";

export type ReadingConnectionState =
  "connected" | "reconnecting" | "recovered" | "timed-out";

export type ReadingReconnectDemoMode = "recover" | "timeout";
export type DeviceKind = "camera" | "microphone";
export type DevicePermissionUiState = "ready" | "denied";

export interface DevicePermissionSnapshotUI {
  readonly camera: DevicePermissionUiState;
  readonly microphone: DevicePermissionUiState;
}

export interface ReadingRealtimeSnapshotUI {
  readonly connection: ReadingConnectionState;
  readonly scoring_active: boolean;
  readonly evidence_valid: boolean;
  readonly child_error_events: readonly [];
}

export interface ReadingCompletionSummaryUI {
  readonly duration_minutes: number | null;
  readonly pages_explored: number | null;
  readonly selected_range_pages?: number | null;
  readonly practiced_words: number | null;
  readonly spoken_words?: readonly string[] | null;
  readonly transcripts?: readonly string[] | null;
  readonly correct_words?: readonly string[] | null;
  readonly mispronounced_words?: readonly string[] | null;
  readonly score?: number | null;
}

export type ReadingEventType =
  | "OMISSION"
  | "REPETITION"
  | "LONG_PAUSE"
  | "SUBSTITUTION"
  | "SELF_CORRECTION"
  | "READ_EXAMPLE";

export type ReadingEventStatus =
  "CANDIDATE" | "CONFIRMED" | "UNCERTAIN" | "DISMISSED";

export interface ReadingEventDTO {
  readonly id: UUID;
  readonly session_id: UUID;
  readonly page_id: UUID;
  readonly page_revision_id: UUID;
  readonly page_revision_word_id: UUID | null;
  readonly type: ReadingEventType;
  readonly start_ms: number;
  readonly end_ms: number | null;
  readonly confidence: number | null;
  readonly status: ReadingEventStatus;
  readonly metadata: Record<string, unknown>;
}

export interface FluencyComponentMetricsDTO {
  readonly active_reading_ms: number;
  readonly reference_words_attempted: number;
  readonly confirmed_error_words: number;
  readonly accuracy_percent: number | null;
  readonly reading_wpm: number | null;
  readonly repetition_rate: number | null;
  readonly long_pause_rate: number | null;
  readonly mean_pause_ms: number | null;
  readonly median_pause_ms: number | null;
}

export interface FluencyAssessmentDTO {
  readonly metrics: FluencyComponentMetricsDTO;
  readonly score: number | null;
  readonly uncertainty: number | null;
  readonly model_version: string;
}

export interface SessionComprehensionResultDTO {
  readonly question: ComprehensionQuestionDTO;
  readonly answer: ComprehensionAnswerResultDTO | null;
}

export interface HistoryEventDTO extends Omit<
  ReadingEventDTO,
  "type" | "status"
> {
  readonly type: ReadingEventType | "MISPRONUNCIATION";
  readonly status:
    ReadingEventStatus | "DETECTED" | "FEEDBACK_GIVEN" | "IGNORED_BY_GATE";
}

export interface HistoryComprehensionResultDTO {
  readonly question: Omit<
    ComprehensionQuestionDTO,
    "difficulty" | "source_span"
  > & {
    readonly difficulty: number | string | null;
    readonly source_span: SourceSpanDTO | null;
  };
  readonly answer: ComprehensionAnswerResultDTO | null;
}

export type HistorySectionStatus =
  "absent" | "available" | "partial" | "unsupported";

export interface HistoryFluencyAssessmentDTO extends Omit<
  FluencyAssessmentDTO,
  "metrics"
> {
  readonly metrics: FluencyComponentMetricsDTO | null;
}

export interface ReadingSessionDetailDTO extends HistorySessionSummaryDTO {
  readonly selected_range_pages?: number | null;
  readonly pages_completed?: number | null;
  readonly selected_page_revision_ids: readonly UUID[];
  readonly reference_page_revision_ids: readonly UUID[];
  readonly events: readonly HistoryEventDTO[];
  readonly fluency_assessment: HistoryFluencyAssessmentDTO | null;
  readonly comprehension: readonly HistoryComprehensionResultDTO[];
  readonly availability: {
    readonly events: HistorySectionStatus;
    readonly fluency: HistorySectionStatus;
    readonly comprehension: HistorySectionStatus;
  };
  readonly report_id: UUID | null;
}

export interface SessionHistoryResponseDTO {
  readonly sessions: readonly HistorySessionSummaryDTO[];
  readonly next_cursor: string | null;
}

export interface ComprehensionChoiceUI {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface ComprehensionQuestionViewModelUI {
  readonly question: ComprehensionQuestionDTO;
  readonly progress_label: string;
  readonly choices: readonly ComprehensionChoiceUI[];
}

export interface ManualPageOptionUI {
  readonly page: BookPagePreviewDTO;
  readonly book_id: UUID;
}
