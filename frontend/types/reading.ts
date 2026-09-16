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

export type ReadingSession = ReadingSessionSummaryDTO;

export interface ReadingSessionCreateDTO {
  readonly child_id: UUID;
  readonly book_id: UUID;
  readonly mode: "realtime";
}

export interface ReadingSessionCreateResponseDTO {
  readonly session_id: UUID;
  readonly state: "CREATED";
  readonly session_token: string;
  readonly expires_at: ISODateTime;
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
}

export interface ReadingPageDTO {
  readonly page_id: UUID;
  readonly page_revision_id: UUID;
  readonly page_number: number;
  readonly confidence: number;
  readonly width: number;
  readonly height: number;
  readonly words: readonly ReadingPageWordDTO[];
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
  readonly duration_minutes: number;
  readonly pages_explored: number;
  readonly practiced_words: number;
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

export interface ReadingSessionDetailDTO extends ReadingSessionSummaryDTO {
  readonly selected_page_revision_ids: readonly UUID[];
  readonly reference_page_revision_ids: readonly UUID[];
  readonly events: readonly ReadingEventDTO[];
  readonly fluency_assessment: FluencyAssessmentDTO | null;
  readonly comprehension: readonly SessionComprehensionResultDTO[];
  readonly report_id: UUID | null;
}

export interface SessionHistoryResponseDTO {
  readonly sessions: readonly ReadingSessionSummaryDTO[];
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
