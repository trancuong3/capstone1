import {
  MOCK_CURRENT_CHILD_ID,
  MOCK_FOREIGN_CHILD_ID,
  MOCK_SECOND_CHILD_ID,
} from "@/lib/mock/mock-app-store";
import type {
  DifficultWordDTO,
  ProgressPeriodSummaryDTO,
  ProgressReportDTO,
} from "@/types/reports";
import type {
  ReadingEventDTO,
  ReadingSessionDetailDTO,
  ReadingSessionSummaryDTO,
} from "@/types/reading";

export const REPORT_DEMO_END_DATE = "2026-09-12";
export const MOCK_REPORT_SESSION_ID = "mock-session-001";
export const MOCK_FOREIGN_SESSION_ID = "79999999-9999-4999-8999-999999999999";

const CAT_BOOK_ID = "20000000-0000-4000-8000-000000000001";
const GARDEN_BOOK_ID = "20000000-0000-4000-8000-000000000002";
const TRAVEL_BOOK_ID = "20000000-0000-4000-8000-000000000003";
const STARFRUIT_BOOK_ID = "20000000-0000-4000-8000-000000000004";

const CURRENT_CHILD_SESSIONS: readonly ReadingSessionSummaryDTO[] = [
  {
    id: "70000000-0000-4000-8000-000000000001",
    child_id: MOCK_CURRENT_CHILD_ID,
    book_id: GARDEN_BOOK_ID,
    state: "FINISHED",
    started_at: "2026-09-10T12:00:00.000Z",
    ended_at: "2026-09-10T12:12:00.000Z",
    duration_ms: 720_000,
  },
  {
    id: "70000000-0000-4000-8000-000000000002",
    child_id: MOCK_CURRENT_CHILD_ID,
    book_id: CAT_BOOK_ID,
    state: "FINISHED",
    started_at: "2026-09-03T11:30:00.000Z",
    ended_at: "2026-09-03T11:40:00.000Z",
    duration_ms: 600_000,
  },
  {
    id: MOCK_REPORT_SESSION_ID,
    child_id: MOCK_CURRENT_CHILD_ID,
    book_id: CAT_BOOK_ID,
    state: "FINISHED",
    started_at: "2026-08-22T08:00:00.000Z",
    ended_at: "2026-08-22T08:08:00.000Z",
    duration_ms: 480_000,
  },
  {
    id: "70000000-0000-4000-8000-000000000004",
    child_id: MOCK_CURRENT_CHILD_ID,
    book_id: TRAVEL_BOOK_ID,
    state: "ABORTED",
    started_at: "2026-08-02T03:00:00.000Z",
    ended_at: "2026-08-02T03:04:00.000Z",
    duration_ms: 240_000,
  },
];

const SECOND_CHILD_SESSIONS: readonly ReadingSessionSummaryDTO[] = [
  {
    id: "70000000-0000-4000-8000-000000000101",
    child_id: MOCK_SECOND_CHILD_ID,
    book_id: STARFRUIT_BOOK_ID,
    state: "FINISHED",
    started_at: "2026-09-08T10:00:00.000Z",
    ended_at: "2026-09-08T10:15:00.000Z",
    duration_ms: 900_000,
  },
  {
    id: "70000000-0000-4000-8000-000000000102",
    child_id: MOCK_SECOND_CHILD_ID,
    book_id: TRAVEL_BOOK_ID,
    state: "PAUSED",
    started_at: "2026-09-01T09:00:00.000Z",
    ended_at: null,
    duration_ms: null,
  },
];

const FOREIGN_SESSION: ReadingSessionSummaryDTO = {
  id: MOCK_FOREIGN_SESSION_ID,
  child_id: MOCK_FOREIGN_CHILD_ID,
  book_id: CAT_BOOK_ID,
  state: "FINISHED",
  started_at: "2026-09-11T08:00:00.000Z",
  ended_at: "2026-09-11T08:10:00.000Z",
  duration_ms: 600_000,
};

const HISTORICAL_REVISION_ID = "40000000-0000-4000-8000-900000000014";
const HISTORICAL_WORD_ID = "50000000-0000-4000-8000-900000000403";

function readingEvent(
  id: string,
  sessionId: string,
  type: ReadingEventDTO["type"],
  status: ReadingEventDTO["status"],
  startMs: number,
  metadata: Record<string, unknown> = {},
): ReadingEventDTO {
  return {
    id,
    session_id: sessionId,
    page_id: "30000000-0000-4000-8000-000000000014",
    page_revision_id: HISTORICAL_REVISION_ID,
    page_revision_word_id: HISTORICAL_WORD_ID,
    type,
    start_ms: startMs,
    end_ms: startMs + 900,
    confidence: status === "CONFIRMED" ? 0.91 : 0.42,
    status,
    metadata: { ...metadata },
  };
}

function detailFromSummary(
  summary: ReadingSessionSummaryDTO,
): ReadingSessionDetailDTO {
  const events: ReadingEventDTO[] = [
    readingEvent(
      "71000000-0000-4000-8000-000000000001",
      summary.id,
      "OMISSION",
      "CONFIRMED",
      86_000,
    ),
    readingEvent(
      "71000000-0000-4000-8000-000000000002",
      summary.id,
      "READ_EXAMPLE",
      "CONFIRMED",
      104_000,
      {
        action_id: "72000000-0000-4000-8000-000000000001",
        trigger: "EXPLICIT_HELP",
        tts_status: "PLAYED",
      },
    ),
    readingEvent(
      "71000000-0000-4000-8000-000000000003",
      summary.id,
      "OMISSION",
      "UNCERTAIN",
      142_000,
      { evidence_valid: false, interruption: "PROVIDER_GAP" },
    ),
    readingEvent(
      "71000000-0000-4000-8000-000000000004",
      summary.id,
      "SELF_CORRECTION",
      "DISMISSED",
      171_000,
    ),
  ];

  return {
    ...summary,
    selected_page_revision_ids: [HISTORICAL_REVISION_ID],
    reference_page_revision_ids: [HISTORICAL_REVISION_ID],
    events,
    fluency_assessment:
      summary.state === "FINISHED"
        ? {
            metrics: {
              active_reading_ms: 420_000,
              reference_words_attempted: 385,
              confirmed_error_words: 6,
              accuracy_percent: 98.4,
              reading_wpm: 55,
              repetition_rate: 1.3,
              long_pause_rate: 0.8,
              mean_pause_ms: 780,
              median_pause_ms: 640,
            },
            score: null,
            uncertainty: 0.12,
            model_version: "mvp-components-v1",
          }
        : null,
    comprehension: [
      {
        question: {
          id: "73000000-0000-4000-8000-000000000001",
          type: "FACTUAL",
          prompt: "Chú mèo đang nằm ở đâu?",
          page_revision_id: HISTORICAL_REVISION_ID,
          source_span: {
            start_word_index: 0,
            end_word_index_exclusive: 8,
            sentence_index: 0,
          },
          difficulty: 1,
          answered: true,
        },
        answer: {
          answer_id: "74000000-0000-4000-8000-000000000001",
          question_id: "73000000-0000-4000-8000-000000000001",
          submitted_answer: "Bên cửa sổ",
          is_correct: true,
          score: 1,
          feedback_code: "CORRECT",
        },
      },
    ],
    report_id: "75000000-0000-4000-8000-000000000001",
  };
}

export const MOCK_SESSION_SUMMARIES: readonly ReadingSessionSummaryDTO[] = [
  ...CURRENT_CHILD_SESSIONS,
  ...SECOND_CHILD_SESSIONS,
  FOREIGN_SESSION,
];

export const MOCK_SESSION_DETAILS: readonly ReadingSessionDetailDTO[] =
  MOCK_SESSION_SUMMARIES.map(detailFromSummary);

export const MOCK_DIFFICULT_WORDS: readonly DifficultWordDTO[] = [
  {
    normalized_word: "nghiêng",
    display_text: "nghiêng",
    difficulty_score: 7,
    omission_count: 1,
    repetition_count: 1,
    long_pause_count: 0,
    read_example_count: 1,
    session_count: 2,
    last_seen_at: "2026-09-10T12:04:20.000Z",
    evidence_word_ids: [
      "76000000-0000-4000-8000-000000000001",
      "76000000-0000-4000-8000-000000000002",
      "76000000-0000-4000-8000-000000000003",
    ],
  },
  {
    normalized_word: "khẽ",
    display_text: "khẽ",
    difficulty_score: 4,
    omission_count: 0,
    repetition_count: 1,
    long_pause_count: 0,
    read_example_count: 1,
    session_count: 2,
    last_seen_at: "2026-09-03T11:35:10.000Z",
    evidence_word_ids: [
      "76000000-0000-4000-8000-000000000011",
      "76000000-0000-4000-8000-000000000012",
    ],
  },
  {
    normalized_word: "vươn",
    display_text: "vươn",
    difficulty_score: 3,
    omission_count: 1,
    repetition_count: 0,
    long_pause_count: 0,
    read_example_count: 0,
    session_count: 1,
    last_seen_at: "2026-08-22T09:12:30.000Z",
    evidence_word_ids: ["76000000-0000-4000-8000-000000000021"],
  },
];

const previousPeriod: ProgressPeriodSummaryDTO = {
  completed_sessions: 2,
  reading_duration_ms: 1_080_000,
  omission_count: 5,
  repetition_count: 4,
  long_pause_count: 3,
  omission_rate: 2.1,
  repetition_rate: 1.7,
  long_pause_rate: 1.3,
  comprehension_accuracy: 72.5,
};

export const MOCK_PROGRESS_REPORTS: readonly ProgressReportDTO[] = [
  {
    child_id: MOCK_CURRENT_CHILD_ID,
    period_start: "2026-08-14",
    period_end: REPORT_DEMO_END_DATE,
    completed_sessions: 3,
    reading_duration_ms: 1_800_000,
    omission_count: 4,
    repetition_count: 3,
    long_pause_count: 2,
    omission_rate: 1.4,
    repetition_rate: 1.1,
    long_pause_rate: 0.7,
    comprehension_accuracy: 80,
    difficult_words: MOCK_DIFFICULT_WORDS.slice(0, 2),
    previous_period: previousPeriod,
    trend_deltas: {
      completed_sessions: 1,
      reading_duration_ms: 720_000,
      omission_rate: -0.7,
      repetition_rate: -0.6,
      long_pause_rate: -0.6,
      comprehension_accuracy: 7.5,
    },
  },
  {
    child_id: MOCK_SECOND_CHILD_ID,
    period_start: "2026-08-14",
    period_end: REPORT_DEMO_END_DATE,
    completed_sessions: 1,
    reading_duration_ms: 900_000,
    omission_count: 1,
    repetition_count: 1,
    long_pause_count: 0,
    omission_rate: null,
    repetition_rate: null,
    long_pause_rate: null,
    comprehension_accuracy: null,
    difficult_words: [],
    previous_period: null,
    trend_deltas: {
      completed_sessions: null,
      reading_duration_ms: null,
      omission_rate: null,
      repetition_rate: null,
      long_pause_rate: null,
      comprehension_accuracy: null,
    },
  },
];

export function cloneSessionDetail(
  detail: ReadingSessionDetailDTO,
): ReadingSessionDetailDTO {
  return {
    ...detail,
    selected_page_revision_ids: [...detail.selected_page_revision_ids],
    reference_page_revision_ids: [...detail.reference_page_revision_ids],
    events: detail.events.map((event) => ({
      ...event,
      metadata: { ...event.metadata },
    })),
    fluency_assessment: detail.fluency_assessment
      ? {
          ...detail.fluency_assessment,
          metrics: { ...detail.fluency_assessment.metrics },
        }
      : null,
    comprehension: detail.comprehension.map((item) => ({
      question: {
        ...item.question,
        source_span: { ...item.question.source_span },
      },
      answer: item.answer ? { ...item.answer } : null,
    })),
  };
}

export function cloneDifficultWord(word: DifficultWordDTO): DifficultWordDTO {
  return { ...word, evidence_word_ids: [...word.evidence_word_ids] };
}

export function cloneProgressReport(
  report: ProgressReportDTO,
): ProgressReportDTO {
  return {
    ...report,
    difficult_words: report.difficult_words.map(cloneDifficultWord),
    previous_period: report.previous_period
      ? { ...report.previous_period }
      : null,
    trend_deltas: { ...report.trend_deltas },
  };
}

export function waitForReportMock(delay = 320): Promise<void> {
  if (process.env.NODE_ENV === "test") return Promise.resolve();
  return new Promise((resolve) => globalThis.setTimeout(resolve, delay));
}
