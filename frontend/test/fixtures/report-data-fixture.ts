import type { BookDetailDTO, BookPagePreviewDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type {
  ReadingSessionDetailDTO,
  ReadingSessionSummaryDTO,
} from "@/types/reading";
import type {
  DifficultWordDTO,
  ProgressReportDTO,
  ReportDateWindow,
} from "@/types/reports";

export const TEST_CHILD_ID = "11000000-0000-4000-8000-000000000001";
export const TEST_FOREIGN_CHILD_ID = "11000000-0000-4000-8000-000000000002";
export const TEST_SESSION_ID = "12000000-0000-4000-8000-000000000001";
export const TEST_BOOK_ID = "13000000-0000-4000-8000-000000000001";
export const TEST_REVISION_ID = "14000000-0000-4000-8000-000000000001";
export const TEST_PAGE_ID = "15000000-0000-4000-8000-000000000001";
export const TEST_WORD_ID = "16000000-0000-4000-8000-000000000001";

export const childFixture: ChildProfileDTO = {
  id: TEST_CHILD_ID,
  parent_id: "10000000-0000-4000-8000-000000000001",
  alias: "Bé kiểm thử",
  grade: 2,
  settings: {},
  created_at: "2026-10-01T00:00:00Z",
};
export const bookFixture: BookDetailDTO = {
  id: TEST_BOOK_ID,
  title: "Sách kiểm thử báo cáo",
  author: "Tác giả kiểm thử",
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "ACTIVE",
};
export const pagePreviewFixture: BookPagePreviewDTO = {
  page_id: TEST_PAGE_ID,
  page_number: 1,
  lifecycle_status: "ACTIVE",
  current_verified_revision_id: TEST_REVISION_ID,
  preview_url: "https://example.com/test-page.png",
};
export const sessionSummaryFixture: ReadingSessionSummaryDTO = {
  id: TEST_SESSION_ID,
  child_id: TEST_CHILD_ID,
  book_id: TEST_BOOK_ID,
  state: "FINISHED",
  started_at: "2026-10-01T00:00:00Z",
  ended_at: "2026-10-01T00:08:00Z",
  duration_ms: 480000,
};
export const sessionDetailFixture: ReadingSessionDetailDTO = {
  ...sessionSummaryFixture,
  selected_page_revision_ids: [TEST_REVISION_ID],
  reference_page_revision_ids: [TEST_REVISION_ID],
  events: [
    {
      id: "17000000-0000-4000-8000-000000000001",
      session_id: TEST_SESSION_ID,
      page_id: TEST_PAGE_ID,
      page_revision_id: TEST_REVISION_ID,
      page_revision_word_id: TEST_WORD_ID,
      type: "OMISSION",
      status: "CONFIRMED",
      start_ms: 1000,
      end_ms: 2000,
      confidence: 0.9,
      metadata: {},
    },
  ],
  fluency_assessment: null,
  comprehension: [],
  report_id: null,
};
export const difficultWordFixture: DifficultWordDTO = {
  normalized_word: "nghiêng",
  display_text: "nghiêng",
  difficulty_score: 3,
  omission_count: 2,
  repetition_count: 1,
  long_pause_count: 0,
  read_example_count: 0,
  session_count: 2,
  last_seen_at: "2026-10-01T00:08:00Z",
  evidence_word_ids: [TEST_WORD_ID],
};
export const reportWindowFixture: ReportDateWindow = {
  period_start: "2026-09-02",
  period_end: "2026-10-01",
  days: 30,
  timezone: "Asia/Ho_Chi_Minh",
};
export const progressReportFixture: ProgressReportDTO = {
  child_id: TEST_CHILD_ID,
  period_start: reportWindowFixture.period_start,
  period_end: reportWindowFixture.period_end,
  completed_sessions: 4,
  reading_duration_ms: 1200000,
  omission_count: 2,
  repetition_count: 1,
  long_pause_count: 0,
  omission_rate: null,
  repetition_rate: null,
  long_pause_rate: null,
  comprehension_accuracy: null,
  difficult_words: [difficultWordFixture],
  previous_period: null,
  trend_deltas: {
    completed_sessions: null,
    reading_duration_ms: null,
    omission_rate: null,
    repetition_rate: null,
    long_pause_rate: null,
    comprehension_accuracy: null,
  },
};
