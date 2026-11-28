import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

import {
  OPAQUE_COVER_ASSET_ID,
  OPAQUE_SUBMISSION_ID,
  createCluster1ApiHandler,
  createCluster1ApiState,
  createCluster2ApiHandler,
  createCluster2ApiState,
  makeAdminBookDetail,
  makeAdminCatalogItem,
  makeAdminOcrJob,
  makeAdminPageListItem,
  makeAdminQualityBookDetail,
  makeAdminRevisionDetail,
  makeAdminRevisionWord,
  makeAdminUserBookQueueItem,
  makeAdminUserBookSubmissionDetail,
  makeBookAssetsSummary,
  makeBookPresentationAsset,
  makeFlow2TriggerResponse,
  makePageOcrExtraction,
  makePrivateBookOcrContribution,
  type Cluster1ApiState,
  type Cluster2ApiState,
} from "./cluster1-2-data";
import {
  OPAQUE_C4_DIFFICULT_WORD_ATTEMPT_ID,
  OPAQUE_C4_EMAIL_DELIVERY_ID,
  OPAQUE_C4_KARAOKE_JOB_ID,
  OPAQUE_C4_KARAOKE_SONG_ID,
  OPAQUE_C4_KARAOKE_VERSION_ID,
  OPAQUE_C4_MEMORY_SESSION_ID,
  OPAQUE_C4_OCCURRENCE_ID,
  OPAQUE_C4_PICTURE_SESSION_ID,
  OPAQUE_C4_QUESTION_ID_1,
  OPAQUE_C4_QUESTION_ID_2,
  OPAQUE_C4_REMINDER_ID,
  OPAQUE_C4_SHOOTER_SESSION_ID,
  OPAQUE_C4_SHOOTER_TOKEN_1,
  OPAQUE_C4_SHOOTER_TOKEN_2,
  OPAQUE_PAGE_2_ID,
  OPAQUE_PRIVATE_BOOK_ID,
  OPAQUE_REV_2_ID,
  OPAQUE_WORD_1_ID,
  makeAdaptiveRecommendations,
  makeAdminKaraokeSongDetail,
  makeAdminKaraokeSongSummary,
  makeAdminProcessingCapabilities,
  makeChildProgressAssessment,
  makeCluster4AdminHealthSnapshot,
  makeKaraokeLyricsPayload,
  makeKaraokeMusicalProfile,
  makeKaraokePlayback,
  makeKaraokePracticeSession,
  makeKaraokeSongCard,
  makeMemoryThemes,
  makeParentLearningAnalytics,
  makePictureDescriptionCatalog,
  makePictureDescriptionEvaluateResponse,
  makePictureDescriptionSession,
  makeProgressPeriods,
  makeProgressReport,
  makeReadingCollection,
  makeReadingGoal,
  makeReadingPlan,
  makeReadingReminder,
  makeSentenceShooterBook,
  makeSentenceShooterSession,
  makeSentenceShooterShotResult,
  makeSessionReadingReports,
  makeSimpleImportResult,
  makeSimpleProcessingStatus,
  makeSupportFeedbackAccepted,
  makeTutorAnswerResponse,
  makeTutorNextQuestion,
  makeAdminAuditLogsPage,
  makeCluster3DefaultHandlers,
  type Cluster3HandlerState,
} from "./cluster3-4-data";
import {
  type ApiMockHandlers,
  type ApiMockRequestContext,
  type ApiMockResponse,
  type PageErrorCollector,
} from "./session";
import {
  OPAQUE_ADMIN_ID,
  OPAQUE_BOOK_ID,
  OPAQUE_CHILD_ID,
  OPAQUE_NOW_ISO,
  OPAQUE_PAGE_ID,
  OPAQUE_PARENT_ID,
  OPAQUE_REV_ID,
  OPAQUE_SESSION_ID,
  makeAssistantChatReply,
  makeAssistantContext,
  makeAssistantStatus,
  makeCatalogBook,
  makeCatalogPagePreview,
  makeCronDispatchResponse,
  makeMinimalPngBuffer,
  makeMinimalWavBuffer,
  makeOpaqueUuid,
  makeParentProfile,
  makeReadingHistoryList,
  makeReadingSessionDetail,
  type CatalogBookPayload,
} from "./test-data";

export function getProjectViewport(
  testInfo: TestInfo,
): { readonly width: number; readonly height: number } | undefined {
  return testInfo.project.name === "mobile-chromium"
    ? { width: 390, height: 844 }
    : undefined;
}

export async function fillHydrated(
  locator: Locator,
  value: string,
): Promise<void> {
  await expect(async () => {
    await locator.fill(value);
    await expect(locator).toHaveValue(value);
  }).toPass({ timeout: 10_000 });
}

export function assertNoUnexpectedPageErrors(
  errors: PageErrorCollector,
  options: { readonly allowFailedResourceStatuses?: readonly number[] } = {},
): void {
  expect(errors.pageErrors).toEqual([]);
  const allowed = options.allowFailedResourceStatuses ?? [];
  const unexpectedConsole = errors.consoleErrors.filter((entry) => {
    if (allowed.length === 0) return true;
    const isGenericResourceErr = entry.includes(
      "Failed to load resource: the server responded with a status of",
    );
    if (!isGenericResourceErr) return true;
    return !allowed.some((status) => entry.includes(String(status)));
  });
  expect(unexpectedConsole).toEqual([]);
}

export async function mockSupabaseStorageImages(page: Page): Promise<void> {
  const png = makeMinimalPngBuffer();
  await page.route("https://*.supabase.co/storage/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: png,
    });
  });
}

export function makeSupabaseJwt(
  userId: string,
  role: "parent" | "admin",
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      aud: "authenticated",
      exp: nowSec + 36_000,
      iat: nowSec - 60,
      role: "authenticated",
      sub: userId,
      user_metadata: { role },
    }),
    "utf8",
  ).toString("base64url");
  return `${header}.${payload}.opaque-tier34-sig`;
}

export async function mockSupabasePasswordAuth(
  page: Page,
  options: {
    userId: string;
    email: string;
    role: "parent" | "admin";
    active?: number;
    rejectSignIn?: boolean;
    onAuthorize?: (url: URL) => void;
  },
): Promise<void> {
  await page.route("https://*.supabase.co/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/auth/v1/authorize")) {
      options.onAuthorize?.(url);
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body>OAuth Mock</body></html>",
      });
      return;
    }

    if (url.pathname.startsWith("/auth/v1/token")) {
      if (options.rejectSignIn) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: "invalid_grant",
            error_code: "invalid_credentials",
            msg: "Invalid login credentials",
          }),
        });
        return;
      }
      const token = makeSupabaseJwt(options.userId, options.role);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          access_token: token,
          token_type: "bearer",
          expires_in: 36_000,
          refresh_token: "opaque-refresh",
          user: {
            id: options.userId,
            aud: "authenticated",
            role: "authenticated",
            email: options.email,
            user_metadata: { role: options.role },
            app_metadata: { provider: "email", providers: ["email"] },
            created_at: OPAQUE_NOW_ISO,
          },
        }),
      });
      return;
    }

    if (url.pathname.startsWith("/rest/v1/profiles")) {
      const accept = route.request().headers().accept ?? "";
      const row = {
        id: options.userId,
        role: options.role,
        active: options.active ?? 1,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          accept.includes("application/vnd.pgrst.object+json") ? row : [row],
        ),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: options.userId,
        aud: "authenticated",
        role: "authenticated",
        email: options.email,
        user_metadata: { role: options.role },
        app_metadata: { provider: "email", providers: ["email"] },
        created_at: OPAQUE_NOW_ISO,
      }),
    });
  });
}

export function makeMinimalMp3Buffer(): Buffer {
  // Valid MPEG1 Layer3 128kbps 44.1kHz frame header + zero padding
  const frameHeader = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const framePayload = Buffer.alloc(413, 0x00);
  const singleFrame = Buffer.concat([frameHeader, framePayload]);
  return Buffer.concat([singleFrame, singleFrame, singleFrame, singleFrame]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export interface Tier34DifficultWordItem {
  normalized_word: string;
  display_text: string;
  difficulty_score: number;
  omission_count: number;
  repetition_count: number;
  long_pause_count: number;
  read_example_count: number;
  session_count: number;
  last_seen_at: string;
  evidence_word_ids: string[];
  mispronunciation_count: number;
  encounter_count: number;
  practice_status:
    "NOT_PRACTICED" | "IN_PROGRESS" | "NEEDS_MORE_PRACTICE" | "COMPLETED";
  practice_attempts_count: number;
  practice_correct_count: number;
  practice_incorrect_count: number;
  practice_uncertain_count: number;
  consecutive_correct_count: number;
  last_practiced_at: string | null;
  last_practice_status:
    | "CORRECT"
    | "INCORRECT"
    | "UNCERTAIN"
    | "NO_CLEAR_AUDIO"
    | "ENGINE_ERROR"
    | null;
  sources: Array<{
    book_id: string;
    book_title: string;
    book_author: string;
    min_grade: number;
    max_grade: number;
    book_cover_url: string | null;
    session_id: string;
    page_id: string;
    page_revision_id: string;
    page_number: number;
    word_id: string;
    context_phrase: string;
    last_seen_at: string;
  }>;
}

export interface Tier34PracticeAttempt {
  attempt_id: string;
  child_id: string;
  normalized_word: string;
  display_text: string;
  attempt_number: number;
  state: "STARTED" | "COMPLETED";
  assessment_status:
    | "CORRECT"
    | "INCORRECT"
    | "UNCERTAIN"
    | "NO_CLEAR_AUDIO"
    | "ENGINE_ERROR"
    | null;
  recognition_source:
    | "SERVER_STT"
    | "SERVER_STT_KEYTERM"
    | "BROWSER_SPEECH"
    | "AUDIO_QUALITY_GATE"
    | "ENGINE_ERROR"
    | null;
  spoken_transcript: string | null;
  confidence: number | null;
  audio_duration_ms: number | null;
  assessment_version: number;
  evidence_word_ids: string[];
  book_id: string | null;
  session_id: string | null;
  page_id: string | null;
  page_revision_id: string | null;
  word_id: string | null;
  resolved_in_session: boolean;
  persistence_backend: "PRACTICE_TABLE_AND_EVENT";
  started_at: string;
  completed_at: string | null;
  feedback_message: string | null;
  word_progress: {
    normalized_word: string;
    practice_status:
      "NOT_PRACTICED" | "IN_PROGRESS" | "NEEDS_MORE_PRACTICE" | "COMPLETED";
    practice_attempts_count: number;
    practice_correct_count: number;
    practice_incorrect_count: number;
    practice_uncertain_count: number;
    consecutive_correct_count: number;
    required_consecutive_correct: number;
    last_practiced_at: string | null;
    last_practice_status:
      | "CORRECT"
      | "INCORRECT"
      | "UNCERTAIN"
      | "NO_CLEAR_AUDIO"
      | "ENGINE_ERROR"
      | null;
  };
  next_recommended_word: string | null;
  evidence_count_unchanged: true;
}

export interface Tier34TutorSessionState {
  generated: boolean;
  questions: Array<{
    id: string;
    type: "FACTUAL" | "CLOZE" | "VOCABULARY";
    prompt: string;
    page_revision_id: string;
    source_span: {
      start_word_index: number;
      end_word_index_exclusive: number;
      sentence_index: number | null;
    };
    difficulty: number;
    answered: boolean;
    expectedAnswer: string;
    choices: Array<{ id: string; label: string; value: string }>;
  }>;
  currentIndex: number;
}

export interface Tier34Flow2Candidate {
  id: string;
  book_id: string;
  book_title: string;
  source_type: string;
  submission_id: string;
  page_number: number;
  status: "PENDING" | "APPROVED" | "REJECTED" | "REVOKED";
  proposed_label: string;
  verified_label: string | null;
  crop_image_url: string;
  rights_confirmed: boolean;
  created_at: string;
  rejection_reason?: string | null;
  revoked_reason?: string | null;
}

export interface Tier34MemorySession {
  id: string;
  child_id: string;
  child_grade: number;
  theme_key:
    | "sunny_garden"
    | "happy_classroom"
    | "mid_autumn_yard"
    | "seaside_morning"
    | "countryside_pond"
    | "friendly_market";
  theme_name_vi: string;
  difficulty_level: number;
  scene_seed: number;
  timer_mode: "10S" | "20S" | "30S" | "60S" | "90S" | "120S" | "UNLIMITED";
  timer_seconds: number | null;
  recall_mode: "FREE_RECALL" | "GUIDED_RECALL";
  status: "OBSERVING" | "RECALLING" | "CREATIVE" | "COMPLETED";
  hints_used: number;
  peek_count: number;
  best_factual_score: number;
  best_creative_score: number;
  stars: number;
  attempts_count: number;
  scene_spec: Record<string, unknown>;
  attempts: Array<Record<string, unknown>>;
  created_at: string;
  updated_at: string;
}

export interface Tier34State {
  actorRole: "guest" | "parent" | "admin";
  cluster1: Cluster1ApiState;
  cluster2: Cluster2ApiState;
  cluster3: Cluster3HandlerState;
  suspendedPrivateBookIds: string[];
  flow2Candidates: Tier34Flow2Candidate[];
  readingSessionsById: Record<
    string,
    {
      id: string;
      child_id: string;
      book_id: string;
      selected_page_id: string;
      selected_page_revision_id: string;
      state: string;
      duration_ms: number | null;
    }
  >;
  readingEvents: Array<{
    id: string;
    session_id: string;
    page_id: string;
    page_revision_id: string;
    page_revision_word_id: string | null;
    type: string;
    status: string;
    start_ms: number;
    end_ms: number | null;
    confidence: number | null;
    metadata: Record<string, unknown>;
  }>;
  readingHistory: Array<
    ReturnType<typeof makeReadingHistoryList>["sessions"][number]
  >;
  tutorBySession: Record<string, Tier34TutorSessionState>;
  childProgressAssessment: Record<string, unknown>;
  difficultWords: Tier34DifficultWordItem[];
  difficultWordAttempts: Record<string, Tier34PracticeAttempt>;
  progressReport: Record<string, unknown>;
  progressPeriods: Record<string, unknown>;
  sessionReportsBySession: Record<string, Record<string, unknown>>;
  readingGoals: Array<Record<string, unknown>>;
  readingPlans: Array<Record<string, unknown>>;
  readingCollections: Array<Record<string, unknown>>;
  readingReminders: Array<Record<string, unknown>>;
  dueOccurrences: Array<Record<string, unknown>>;
  notificationPreferences: Record<string, unknown>;
  notificationHistory: Array<Record<string, unknown>>;
  adaptiveRecommendations: Record<string, unknown>;
  parentAnalytics: Record<string, unknown>;
  sentenceShooterBooks: Array<Record<string, unknown>>;
  sentenceShooterSessions: Record<string, Record<string, unknown>>;
  sentenceShooterShotsSeen: Record<string, Record<string, unknown>>;
  pictureCatalog: Record<string, unknown> | null;
  pictureSessions: Record<string, Record<string, unknown>>;
  memoryThemes: Record<string, unknown>;
  memorySessions: Record<string, Tier34MemorySession>;
  karaokeCapabilities: Record<string, unknown>;
  karaokeAdminSongs: Array<Record<string, unknown>>;
  karaokeCatalogSongs: Array<Record<string, unknown>>;
  karaokePlaybackBySong: Record<string, Record<string, unknown>>;
  karaokeMusicalProfileBySong: Record<string, Record<string, unknown>>;
  karaokePracticeSessions: Array<Record<string, unknown>>;
  adminHealthSnapshot: ReturnType<typeof makeCluster4AdminHealthSnapshot>;
  adminAuditLogs: ReturnType<typeof makeAdminAuditLogsPage>;
  supportSubmissions: Array<Record<string, unknown>>;
  seenLocaleHeaders: Array<{ path: string; locale: string | null }>;
  seenAssistantRequests: Array<{
    hasAuth: boolean;
    authorization: string | null;
    localeHeader: string | null;
    body: Record<string, unknown>;
  }>;
  seenRequests: Array<{
    method: string;
    pathname: string;
    headers: Record<string, string>;
    body: unknown;
  }>;
  assistantRateLimitRemaining?: number;
  assistantForceStatus?: number;
  faults: Record<string, ApiMockResponse>;
  nextId: number;
}

export function makeDifficultWordEntry(
  overrides: Partial<Tier34DifficultWordItem> = {},
): Tier34DifficultWordItem {
  return {
    normalized_word: "lấp lánh",
    display_text: "lấp lánh",
    difficulty_score: 0.85,
    omission_count: 1,
    repetition_count: 1,
    long_pause_count: 1,
    read_example_count: 0,
    session_count: 1,
    last_seen_at: OPAQUE_NOW_ISO,
    evidence_word_ids: [OPAQUE_WORD_1_ID],
    mispronunciation_count: 2,
    encounter_count: 3,
    practice_status: "NEEDS_MORE_PRACTICE",
    practice_attempts_count: 1,
    practice_correct_count: 0,
    practice_incorrect_count: 1,
    practice_uncertain_count: 0,
    consecutive_correct_count: 0,
    last_practiced_at: OPAQUE_NOW_ISO,
    last_practice_status: "INCORRECT",
    sources: [
      {
        book_id: OPAQUE_BOOK_ID,
        book_title: "Chú Mèo Đi Hia",
        book_author: "ViRead",
        min_grade: 1,
        max_grade: 3,
        book_cover_url: null,
        session_id: OPAQUE_SESSION_ID,
        page_id: OPAQUE_PAGE_ID,
        page_revision_id: OPAQUE_REV_ID,
        page_number: 1,
        word_id: OPAQUE_WORD_1_ID,
        context_phrase: "Ánh nắng lấp lánh trên mặt hồ.",
        last_seen_at: OPAQUE_NOW_ISO,
      },
    ],
    ...overrides,
  };
}

export function makeTier34MemorySession(
  overrides: Partial<Tier34MemorySession> = {},
): Tier34MemorySession {
  return {
    id: OPAQUE_C4_MEMORY_SESSION_ID,
    child_id: OPAQUE_CHILD_ID,
    child_grade: 2,
    theme_key: "sunny_garden",
    theme_name_vi: "Khu vườn nắng mai",
    difficulty_level: 1,
    scene_seed: 12,
    timer_mode: "30S",
    timer_seconds: 30,
    recall_mode: "FREE_RECALL",
    status: "OBSERVING",
    hints_used: 0,
    peek_count: 0,
    best_factual_score: 0,
    best_creative_score: 0,
    stars: 0,
    attempts_count: 0,
    scene_spec: {
      schema_version: "1.0",
      theme_key: "sunny_garden",
      theme_name_vi: "Khu vườn nắng mai",
      child_grade: 2,
      difficulty_level: 1,
      scene_seed: 12,
      canvas_width: 800,
      canvas_height: 500,
      backdrop: {
        theme_key: "sunny_garden",
        sky_top_hex: "#DBEAFE",
        sky_bottom_hex: "#EFF6FF",
        horizon_hex: "#BBF7D0",
        ground_hex: "#86EFAC",
        accent_hex: "#2563EB",
        mood_vi: "Nắng nhẹ buổi sáng",
      },
      objects: [
        {
          id: "obj-ball",
          sprite_key: "ball",
          name_vi: "quả bóng",
          category_vi: "Đồ chơi",
          aliases_vi: ["bóng"],
          color_vi: "đỏ",
          color_hex: "#EF4444",
          color_stroke_hex: "#991B1B",
          color_light_hex: "#FEE2E2",
          shape_cue: "circle",
          count: 1,
          position_zone: "giữa",
          bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
          action_vi: "nằm trên cỏ",
          hint_tiers: {
            tier_1: "Có một đồ vật tròn ở giữa vườn.",
            tier_2: "Đồ vật này có màu đỏ.",
            tier_3: "Đó là quả bóng đỏ ở giữa.",
          },
          is_focus_word: true,
        },
      ],
      observation_tips_vi: ["Nhớ vị trí và màu sắc của đồ vật."],
      guided_questions_vi: ["Quả bóng màu gì?"],
      creative_prompt_vi: "Hãy kể tiếp câu chuyện về quả bóng đỏ trong vườn.",
      matched_focus_words: ["quả bóng"],
    },
    attempts: [],
    created_at: OPAQUE_NOW_ISO,
    updated_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export function createTier34State(
  overrides: Partial<Tier34State> = {},
): Tier34State {
  const actorRole = overrides.actorRole ?? "parent";
  const cluster1 = createCluster1ApiState();
  const cluster2 = createCluster2ApiState({
    role: actorRole === "admin" ? "admin" : "parent",
  });
  const cluster3: Cluster3HandlerState = {
    currentPageNumber: 1,
    completedPageIds: [],
    presenceEmailEnabled: false,
    presenceAlertsById: {},
    presenceAlertsByEpisode: {},
    scanJobs: [],
    ttsCacheCounts: {},
  };

  return {
    actorRole,
    cluster1,
    cluster2,
    cluster3,
    suspendedPrivateBookIds: [],
    flow2Candidates: [],
    readingSessionsById: {
      [OPAQUE_SESSION_ID]: {
        id: OPAQUE_SESSION_ID,
        child_id: OPAQUE_CHILD_ID,
        book_id: OPAQUE_BOOK_ID,
        selected_page_id: OPAQUE_PAGE_ID,
        selected_page_revision_id: OPAQUE_REV_ID,
        state: "LISTENING",
        duration_ms: null,
      },
    },
    readingEvents: [],
    readingHistory: makeReadingHistoryList().sessions,
    tutorBySession: {},
    childProgressAssessment: makeChildProgressAssessment(),
    difficultWords: [
      makeDifficultWordEntry(),
      makeDifficultWordEntry({
        normalized_word: "rì rào",
        display_text: "rì rào",
        difficulty_score: 0.72,
        omission_count: 1,
        repetition_count: 0,
        long_pause_count: 1,
        mispronunciation_count: 1,
        encounter_count: 2,
        practice_status: "NOT_PRACTICED",
        practice_attempts_count: 0,
        practice_incorrect_count: 0,
        consecutive_correct_count: 0,
        last_practiced_at: null,
        last_practice_status: null,
      }),
    ],
    difficultWordAttempts: {},
    progressReport: makeProgressReport({
      difficult_words: [makeDifficultWordEntry()],
    }),
    progressPeriods: makeProgressPeriods(),
    sessionReportsBySession: {
      [OPAQUE_SESSION_ID]: makeSessionReadingReports(),
    },
    readingGoals: [makeReadingGoal()],
    readingPlans: [makeReadingPlan()],
    readingCollections: [makeReadingCollection()],
    readingReminders: [makeReadingReminder()],
    dueOccurrences: [
      {
        id: OPAQUE_C4_OCCURRENCE_ID,
        reminder_id: OPAQUE_C4_REMINDER_ID,
        scheduled_local_date: "2026-11-21",
        scheduled_for: OPAQUE_NOW_ISO,
        status: "PENDING",
        acknowledged_at: null,
        email_status: "NOT_REQUESTED",
        email_attempts: 0,
        email_sent_at: null,
        email_error_code: null,
        reminder: makeReadingReminder(),
      },
    ],
    notificationPreferences: {
      weekly_digest_enabled: true,
      inactivity_alert_enabled: true,
      inactivity_days: 3,
      milestone_enabled: true,
      digest_weekday: 6,
      timezone: "Asia/Ho_Chi_Minh",
      quiet_hours_start: 22,
      quiet_hours_end: 7,
      max_emails_per_week: 5,
      delivery_configured: true,
      delivery_provider: "resend",
      updated_at: OPAQUE_NOW_ISO,
    },
    notificationHistory: [
      {
        id: OPAQUE_C4_EMAIL_DELIVERY_ID,
        category: "TEST_EMAIL",
        status: "SENT",
        subject: "Email thử nghiệm từ ViRead",
        sent_at: OPAQUE_NOW_ISO,
        created_at: OPAQUE_NOW_ISO,
        error_code: null,
      },
    ],
    adaptiveRecommendations: makeAdaptiveRecommendations(),
    parentAnalytics: makeParentLearningAnalytics(),
    sentenceShooterBooks: [makeSentenceShooterBook()],
    sentenceShooterSessions: {},
    sentenceShooterShotsSeen: {},
    pictureCatalog: null,
    pictureSessions: {},
    memoryThemes: makeMemoryThemes({
      timer_options: [
        {
          mode: "10S",
          seconds: 10,
          label_vi: "10 giây",
          recommended_for_vi: "Nhanh",
        },
        {
          mode: "30S",
          seconds: 30,
          label_vi: "30 giây",
          recommended_for_vi: "Tiêu chuẩn",
        },
        {
          mode: "UNLIMITED",
          seconds: null,
          label_vi: "Không giới hạn",
          recommended_for_vi: "Thư giãn",
        },
      ],
      grade_recommendations: [
        {
          grade: 1,
          min_objects: 2,
          max_objects: 3,
          recommended_timer: "10S",
          recommended_recall_mode: "FREE_RECALL",
          recommended_difficulty: 1,
          note_vi: "Lớp 1 gợi ý 10 giây.",
        },
        {
          grade: 2,
          min_objects: 2,
          max_objects: 4,
          recommended_timer: "30S",
          recommended_recall_mode: "FREE_RECALL",
          recommended_difficulty: 1,
          note_vi: "Lớp 2 gợi ý 30 giây.",
        },
        {
          grade: 5,
          min_objects: 4,
          max_objects: 6,
          recommended_timer: "30S",
          recommended_recall_mode: "GUIDED_RECALL",
          recommended_difficulty: 3,
          note_vi: "Lớp 5 gợi ý nhớ chi tiết nâng cao.",
        },
      ],
    }),
    memorySessions: {},
    karaokeCapabilities: makeAdminProcessingCapabilities(),
    karaokeAdminSongs: [makeAdminKaraokeSongDetail()],
    karaokeCatalogSongs: [makeKaraokeSongCard()],
    karaokePlaybackBySong: {},
    karaokeMusicalProfileBySong: {},
    karaokePracticeSessions: [],
    adminHealthSnapshot: makeCluster4AdminHealthSnapshot(),
    adminAuditLogs: makeAdminAuditLogsPage(),
    supportSubmissions: [],
    seenLocaleHeaders: [],
    seenAssistantRequests: [],
    seenRequests: [],
    faults: {},
    nextId: 700,
    ...overrides,
  };
}

function makeDefaultTutorQuestions(): Tier34TutorSessionState {
  return {
    generated: true,
    currentIndex: 0,
    questions: [
      {
        id: OPAQUE_C4_QUESTION_ID_1,
        type: "FACTUAL",
        prompt: "Bạn Thỏ đã tìm thấy gì bên bờ suối?",
        page_revision_id: OPAQUE_REV_ID,
        source_span: {
          start_word_index: 0,
          end_word_index_exclusive: 4,
          sentence_index: 0,
        },
        difficulty: 1,
        answered: false,
        expectedAnswer: "Một giỏ dâu rừng đỏ mọng",
        choices: [
          {
            id: "choice-a",
            label: "Một giỏ dâu rừng đỏ mọng",
            value: "Một giỏ dâu rừng đỏ mọng",
          },
          {
            id: "choice-b",
            label: "Một chiếc lá vàng",
            value: "Một chiếc lá vàng",
          },
          {
            id: "choice-c",
            label: "Một viên sỏi trắng",
            value: "Một viên sỏi trắng",
          },
        ],
      },
      {
        id: OPAQUE_C4_QUESTION_ID_2,
        type: "VOCABULARY",
        prompt: "Từ nào chỉ ánh sáng dịu nhẹ?",
        page_revision_id: OPAQUE_REV_ID,
        source_span: {
          start_word_index: 1,
          end_word_index_exclusive: 3,
          sentence_index: 0,
        },
        difficulty: 1,
        answered: false,
        expectedAnswer: "lấp lánh",
        choices: [
          { id: "choice-2a", label: "lấp lánh", value: "lấp lánh" },
          { id: "choice-2b", label: "ồn ào", value: "ồn ào" },
          { id: "choice-2c", label: "nặng trĩu", value: "nặng trĩu" },
        ],
      },
    ],
  };
}

function buildShooterResultPayload(
  session: Record<string, unknown>,
  status: "IN_PROGRESS" | "COMPLETED" | "ABANDONED",
): Record<string, unknown> {
  return {
    session_id: session.session_id,
    book: session.book,
    difficulty: session.difficulty,
    learning_mode: session.learning_mode ?? "WORD_ORDER",
    status,
    total_rounds: session.total_rounds ?? 2,
    completed_rounds: session.completed_rounds ?? 2,
    correct_count: 2,
    mistakes_total: 0,
    hint_count: 0,
    total_stars: session.total_stars ?? 6,
    duration_seconds: 18,
    started_at: OPAQUE_NOW_ISO,
    completed_at: status === "COMPLETED" ? OPAQUE_NOW_ISO : null,
    practiced_difficult_words: session.practiced_difficult_words ?? [
      "lấp lánh",
    ],
  };
}

export function createTier34ApiHandler(
  state: Tier34State,
  options: { readonly roleOverride?: "guest" | "parent" | "admin" } = {},
): ApiMockHandlers {
  const cluster1Handler = createCluster1ApiHandler(state.cluster1);
  const cluster2Handler = createCluster2ApiHandler(state.cluster2);
  const cluster3Handler = makeCluster3DefaultHandlers(state.cluster3);

  return async (
    ctx: ApiMockRequestContext,
  ): Promise<ApiMockResponse | null | undefined> => {
    const callerRole = options.roleOverride ?? state.actorRole;
    const faultKey = `${ctx.method} ${ctx.pathname}`;
    if (state.faults[faultKey]) return state.faults[faultKey];
    if (state.faults[ctx.pathname]) return state.faults[ctx.pathname];

    state.seenRequests.push({
      method: ctx.method,
      pathname: ctx.pathname,
      headers: ctx.headers,
      body: ctx.postDataJson,
    });

    const localeHeader = ctx.headers["x-viread-locale"] ?? null;
    if (localeHeader !== null) {
      state.seenLocaleHeaders.push({
        path: ctx.pathname,
        locale: localeHeader,
      });
    }

    // Deactivated parent fail-closed enforcement (F-04 -> F-01/F-10/F-22)
    if (
      callerRole === "parent" &&
      state.cluster1.deactivatedParentIds.includes(OPAQUE_PARENT_ID)
    ) {
      if (
        ctx.pathname === "/profiles/me" ||
        ctx.pathname.startsWith("/voice/") ||
        ctx.pathname === "/support/feedback" ||
        ctx.pathname === "/profiles/dashboard-summary"
      ) {
        return {
          status: 403,
          body: { detail: "ACCOUNT_INACTIVE" },
        };
      }
    }

    // Static test media served from mock API origin
    if (ctx.method === "GET" && ctx.pathname === "/media/karaoke-test.wav") {
      return {
        status: 200,
        contentType: "audio/wav",
        headers: { "cache-control": "no-store" },
        body: makeMinimalWavBuffer(2200),
      };
    }
    if (ctx.method === "GET" && ctx.pathname === "/media/picture-sample.png") {
      return {
        status: 200,
        contentType: "image/png",
        headers: { "cache-control": "no-store" },
        body: makeMinimalPngBuffer(),
      };
    }

    // -----------------------------------------------------------------------
    // Cross-cluster overrides for F-03 -> F-14, F-06 -> F-07/F-18/F-20,
    // F-18 -> F-19 -> F-05, F-07 -> F-11/F-12/F-13
    // -----------------------------------------------------------------------

    // Child CRUD updates recommendations & analytics grade (F-03 x F-14)
    if (
      (ctx.method === "POST" && ctx.pathname === "/profiles/children") ||
      (ctx.method === "PUT" &&
        /^\/profiles\/children\/[^/]+$/u.test(ctx.pathname))
    ) {
      const res =
        typeof cluster1Handler === "function"
          ? await cluster1Handler(ctx)
          : undefined;
      if (res && res.status && res.status < 300 && isRecord(res.body)) {
        state.adaptiveRecommendations = {
          ...state.adaptiveRecommendations,
          child_id: res.body.id ?? state.adaptiveRecommendations.child_id,
          child_alias:
            res.body.alias ?? state.adaptiveRecommendations.child_alias,
          child_grade:
            res.body.grade ?? state.adaptiveRecommendations.child_grade,
        };
        state.parentAnalytics = {
          ...state.parentAnalytics,
          child_id: res.body.id ?? state.parentAnalytics.child_id,
          child_alias: res.body.alias ?? state.parentAnalytics.child_alias,
          child_grade: res.body.grade ?? state.parentAnalytics.child_grade,
        };
      }
      return res;
    }

    // Profile role resolution for /profiles/me
    if (ctx.method === "GET" && ctx.pathname === "/profiles/me") {
      if (callerRole === "admin") {
        return {
          status: 200,
          body: makeParentProfile({
            id: OPAQUE_ADMIN_ID,
            role: "admin",
            display_name: "Quản trị viên ViRead",
            email: "admin@viread.local",
            children: [],
          }),
        };
      }
      return { status: 200, body: state.cluster1.profile };
    }

    // F-18 Admin Book Creation + Quality Hub registration
    if (ctx.method === "POST" && ctx.pathname === "/books/admin/catalog") {
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const bid = makeOpaqueUuid((state.nextId += 1), "82000000");
      const title =
        typeof body.title === "string" ? body.title : "Sách kiểm thử mới";
      const author = typeof body.author === "string" ? body.author : "ViRead";
      const minGrade = typeof body.min_grade === "number" ? body.min_grade : 1;
      const maxGrade = typeof body.max_grade === "number" ? body.max_grade : 3;
      const created = makeAdminBookDetail({
        id: bid,
        name: typeof body.name === "string" ? body.name : "sach-kiem-thu-moi",
        title,
        author,
        min_grade: minGrade,
        max_grade: maxGrade,
      });
      state.cluster2.adminCatalog.unshift(
        makeAdminCatalogItem({
          book: created,
          page_count: 0,
          verified_count: 0,
          parent_catalog_eligible: false,
        }),
      );
      state.cluster2.adminPagesByBook[bid] = [];
      state.cluster2.qualityBooks.unshift(
        makeAdminQualityBookDetail({
          book_id: bid,
          book_title: title,
          assessment: {
            ...makeAdminQualityBookDetail().assessment,
            book_id: bid,
            status: "PENDING_ADMIN_REVIEW",
            rights_confirmed: false,
            copyright_status: "UNREVIEWED",
            admin_approved_at: null,
            admin_approved_by: null,
          },
        }),
      );
      state.cluster2.assetsByBook[bid] = makeBookAssetsSummary({
        book_id: bid,
        active_cover: null,
        effective_cover_source: "METADATA_RENDER",
      });
      return { status: 201, body: created };
    }

    // F-18 Admin Page Upload registers page + NEEDS_REVIEW revision + extraction
    const adminPagesJobsMatch =
      /^\/books\/admin\/catalog\/([^/]+)\/pages\/jobs$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && adminPagesJobsMatch) {
      const bid = decodeURIComponent(adminPagesJobsMatch[1] ?? "");
      const pid = makeOpaqueUuid((state.nextId += 1), "83000000");
      const rid = makeOpaqueUuid((state.nextId += 1), "84000000");
      const pages = state.cluster2.adminPagesByBook[bid] ?? [];
      const pageNum = pages.length + 1;
      pages.push(
        makeAdminPageListItem({
          book_id: bid,
          page_number: pageNum,
          processing: {
            page_id: pid,
            page_revision_id: rid,
            verification_status: "NEEDS_REVIEW",
            current_verified_revision_id: null,
          },
        }),
      );
      state.cluster2.adminPagesByBook[bid] = pages;
      state.cluster2.adminRevisionsByPage[pid] = makeAdminRevisionDetail({
        page_id: pid,
        page_revision_id: rid,
        verification_status: "NEEDS_REVIEW",
        draft_text: "Trang sách mới tải lên.",
      });
      state.cluster2.extractionsByPage[pid] = makePageOcrExtraction({
        book_page_id: pid,
        page_revision_id: rid,
        canonical_text: "Chú thỏ trắng chạy qua đồng cỏ xanh.",
      });
      const catItem = state.cluster2.adminCatalog.find(
        (c) => c.book.id === bid,
      );
      if (catItem) {
        catItem.page_count = pages.length;
        catItem.needs_review_count += 1;
      }
      return {
        status: 200,
        body: makeAdminOcrJob({
          book_id: bid,
          page_id: pid,
          revision_id: rid,
          status: "SUCCEEDED",
        }),
      };
    }

    // F-18 Admin Catalog PATCH (retire/activate book)
    const adminCatalogPatchMatch = /^\/books\/admin\/catalog\/([^/]+)$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "PATCH" && adminCatalogPatchMatch) {
      const bid = decodeURIComponent(adminCatalogPatchMatch[1] ?? "");
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const nextStatus =
        body.lifecycle_status === "RETIRED" ? "RETIRED" : "ACTIVE";
      const adminItem = state.cluster2.adminCatalog.find(
        (item) => item.book.id === bid,
      );
      if (adminItem) {
        adminItem.book = { ...adminItem.book, lifecycle_status: nextStatus };
        adminItem.parent_catalog_eligible = nextStatus === "ACTIVE";
      }
      if (nextStatus === "RETIRED") {
        state.cluster2.catalogBooks = state.cluster2.catalogBooks.filter(
          (b) => b.id !== bid,
        );
      }
      return {
        status: 200,
        body: makeAdminBookDetail({
          ...(adminItem?.book ?? { id: bid }),
          lifecycle_status: nextStatus,
        }),
      };
    }

    // F-19 Studio Cover Upload updates catalog cover_url too (F-05 x F-19)
    const studioCoverUploadMatch =
      /^\/studio\/books\/([^/]+)\/cover\/upload$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && studioCoverUploadMatch) {
      const bid = decodeURIComponent(studioCoverUploadMatch[1] ?? "");
      const coverId = OPAQUE_COVER_ASSET_ID;
      const mediaUrl = `${ctx.url.origin}/studio/assets/${coverId}/media`;
      const cover = makeBookPresentationAsset({
        id: coverId,
        book_id: bid,
        book_page_id: null,
        source_revision_id: null,
        asset_role: "COVER",
        source_type: "USER_UPLOAD",
        media_url: mediaUrl,
        moderation_status: "APPROVED",
      });
      const existingAssets =
        state.cluster2.assetsByBook[bid] ??
        makeBookAssetsSummary({ book_id: bid });
      state.cluster2.assetsByBook[bid] = {
        ...existingAssets,
        active_cover: cover,
        effective_cover_source: "USER_UPLOAD",
      };
      const catIdx = state.cluster2.catalogBooks.findIndex((b) => b.id === bid);
      if (catIdx >= 0) {
        state.cluster2.catalogBooks[catIdx] = {
          ...state.cluster2.catalogBooks[catIdx]!,
          cover_url: mediaUrl,
          cover_source_type: "USER_UPLOAD",
        };
      }
      const adminIdx = state.cluster2.adminCatalog.findIndex(
        (item) => item.book.id === bid,
      );
      if (adminIdx >= 0) {
        state.cluster2.adminCatalog[adminIdx]!.book = {
          ...state.cluster2.adminCatalog[adminIdx]!.book,
          cover_url: mediaUrl,
          cover_source_type: "USER_UPLOAD",
        };
      }
      return { status: 200, body: cover };
    }

    // F-19 Apply OCR extraction to Admin revision draft (F-18 x F-19)
    const studioApplyDraftMatch =
      /^\/studio\/pages\/([^/]+)\/ocr-extraction\/apply-to-draft$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && studioApplyDraftMatch) {
      const pid = decodeURIComponent(studioApplyDraftMatch[1] ?? "");
      const extraction =
        state.cluster2.extractionsByPage[pid] ??
        makePageOcrExtraction({ book_page_id: pid });
      const existingRev =
        state.cluster2.adminRevisionsByPage[pid] ??
        makeAdminRevisionDetail({ page_id: pid });
      const nextWords = extraction.canonical_text
        .split(/\s+/u)
        .filter(Boolean)
        .map((token, idx) => makeAdminRevisionWord(idx, token));
      state.cluster2.adminRevisionsByPage[pid] = {
        ...existingRev,
        draft_text: extraction.canonical_text,
        words: nextWords,
      };
      return {
        status: 200,
        body: {
          page_id: pid,
          revision_id: existingRev.page_revision_id,
          applied_word_count: nextWords.length,
          canonical_text: extraction.canonical_text,
          status: "APPLIED",
        },
      };
    }

    // F-18 Verify page updates catalog preview + admin catalog counts
    const adminVerifyMatch = /^\/books\/admin\/pages\/([^/]+)\/verify$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "POST" && adminVerifyMatch) {
      const pid = decodeURIComponent(adminVerifyMatch[1] ?? "");
      const res =
        typeof cluster2Handler === "function"
          ? await cluster2Handler(ctx)
          : undefined;
      for (const [bid, pages] of Object.entries(
        state.cluster2.adminPagesByBook,
      )) {
        const pageEntry = pages.find((p) => p.processing.page_id === pid);
        if (pageEntry) {
          const rev = state.cluster2.adminRevisionsByPage[pid];
          pageEntry.processing.current_verified_revision_id =
            rev?.page_revision_id ?? OPAQUE_REV_ID;
          pageEntry.processing.verification_status = "VERIFIED";
          const catItem = state.cluster2.adminCatalog.find(
            (c) => c.book.id === bid,
          );
          if (catItem) {
            catItem.verified_count = pages.filter(
              (p) => p.processing.current_verified_revision_id !== null,
            ).length;
            catItem.needs_review_count = Math.max(
              0,
              pages.length - catItem.verified_count,
            );
          }
          const previews = state.cluster2.previewsByBook[bid] ?? [];
          if (!previews.some((p) => p.page_id === pid)) {
            previews.push(
              makeCatalogPagePreview({
                page_id: pid,
                page_number: pageEntry.page_number,
                current_verified_revision_id:
                  rev?.page_revision_id ?? OPAQUE_REV_ID,
              }),
            );
            state.cluster2.previewsByBook[bid] = previews;
          }
        }
      }
      return res;
    }

    // F-18 Quality Hub book decision -> promotes/removes book in F-05 catalog
    const qualityBookDecisionMatch =
      /^\/books\/admin\/quality\/books\/([^/]+)\/decision$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && qualityBookDecisionMatch) {
      const bid = decodeURIComponent(qualityBookDecisionMatch[1] ?? "");
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const decision =
        typeof body.decision === "string" ? body.decision : "APPROVE";
      const res =
        typeof cluster2Handler === "function"
          ? await cluster2Handler(ctx)
          : undefined;
      if (decision === "APPROVE") {
        const adminItem = state.cluster2.adminCatalog.find(
          (c) => c.book.id === bid,
        );
        if (adminItem) {
          adminItem.parent_catalog_eligible = true;
          const assets = state.cluster2.assetsByBook[bid];
          const coverUrl =
            assets?.active_cover?.media_url ?? adminItem.book.cover_url;
          const catalogBook: CatalogBookPayload = makeCatalogBook({
            id: bid,
            title: adminItem.book.title,
            author: adminItem.book.author,
            min_grade: adminItem.book.min_grade,
            max_grade: adminItem.book.max_grade,
            lifecycle_status: "ACTIVE",
            visibility_scope: "CATALOG",
            cover_url: coverUrl,
            cover_source_type: adminItem.book.cover_source_type,
          });
          const existingIdx = state.cluster2.catalogBooks.findIndex(
            (b) => b.id === bid,
          );
          if (existingIdx >= 0) {
            state.cluster2.catalogBooks[existingIdx] = catalogBook;
          } else {
            state.cluster2.catalogBooks.unshift(catalogBook);
          }
          if (!state.cluster2.previewsByBook[bid]?.length) {
            state.cluster2.previewsByBook[bid] = [
              makeCatalogPagePreview({
                page_id: OPAQUE_PAGE_ID,
                page_number: 1,
                current_verified_revision_id: OPAQUE_REV_ID,
              }),
            ];
          }
        }
      } else if (decision === "REJECT") {
        state.cluster2.catalogBooks = state.cluster2.catalogBooks.filter(
          (b) => b.id !== bid,
        );
      }
      return res;
    }

    // F-18 Report resolution syncs both qualityReports and parentReports + validation
    const qualityReportStatusMatch =
      /^\/books\/admin\/quality\/reports\/([^/]+)\/status$/u.exec(ctx.pathname);
    if (ctx.method === "PATCH" && qualityReportStatusMatch) {
      const rid = decodeURIComponent(qualityReportStatusMatch[1] ?? "");
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const resolutionNote =
        typeof body.resolution_note === "string"
          ? body.resolution_note.trim()
          : "";
      if (body.status === "RESOLVED" && !resolutionNote) {
        return {
          status: 422,
          body: { detail: "RESOLUTION_NOTE_REQUIRED" },
        };
      }
      const res =
        typeof cluster2Handler === "function"
          ? await cluster2Handler(ctx)
          : undefined;
      if (res && res.status === 200 && isRecord(res.body)) {
        const updated = {
          ...res.body,
          resolved_at: OPAQUE_NOW_ISO,
          admin_resolution_note: resolutionNote || null,
        };
        const pIdx = state.cluster2.parentReports.findIndex(
          (r) => r.id === rid,
        );
        if (pIdx >= 0) {
          state.cluster2.parentReports[pIdx] =
            updated as (typeof state.cluster2.parentReports)[number];
        }
        return { status: 200, body: updated };
      }
      return res;
    }

    // F-06 Private Book request-admin-review -> User Books Quality Queue (F-06 x F-18)
    const privateReqReviewMatch =
      /^\/books\/my-books\/([^/]+)\/submissions\/([^/]+)\/request-admin-review$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && privateReqReviewMatch) {
      const bid = decodeURIComponent(privateReqReviewMatch[1] ?? "");
      const sid = decodeURIComponent(privateReqReviewMatch[2] ?? "");
      const detail = state.cluster2.privateBooks.find((d) => d.book.id === bid);
      const subIdx = detail?.submissions.findIndex((s) => s.id === sid) ?? -1;
      if (!detail || subIdx === -1) {
        return { status: 404, body: { detail: "SUBMISSION_NOT_FOUND" } };
      }
      detail.submissions[subIdx] = {
        ...detail.submissions[subIdx]!,
        workflow_status: "PENDING_ADMIN",
      };
      const submission = detail.submissions[subIdx]!;
      const sourceType =
        submission.source_type ?? detail.book.ocr_contribution.rights_basis;
      const queueItem = makeAdminUserBookQueueItem({
        book_id: bid,
        book_title: detail.book.title,
        book_author: detail.book.author ?? "",
        owner_label:
          state.cluster1.profile.display_name ?? "Phụ huynh Kiểm thử",
        moderation_status: detail.book.moderation_status,
        queue_status: "PENDING_ADMIN",
        pending_count: 1,
        flagged_count: 0,
        failed_count: 0,
        committed_page_count: detail.pages.length,
        latest_submission_id: sid,
        latest_submission_version: submission.submission_version,
        latest_submitted_at: OPAQUE_NOW_ISO,
        policy_blocked: false,
      });
      const qIdx = state.cluster2.userBookQueue.findIndex(
        (q) => q.book_id === bid || q.latest_submission_id === sid,
      );
      if (qIdx >= 0) {
        state.cluster2.userBookQueue[qIdx] = queueItem;
      } else {
        state.cluster2.userBookQueue.unshift(queueItem);
      }
      state.cluster2.userBookSubmissions[sid] =
        makeAdminUserBookSubmissionDetail({
          submission_id: sid,
          book_id: bid,
          book_title: detail.book.title,
          book_author: detail.book.author ?? "",
          book_moderation_status: detail.book.moderation_status,
          owner_label:
            state.cluster1.profile.display_name ?? "Phụ huynh Kiểm thử",
          source_file_name: submission.source_file_name,
          source_page_number:
            submission.target_page_number ?? submission.source_page_number,
          submission_version: submission.submission_version,
          workflow_status: "PENDING_ADMIN",
          image_url: submission.image_url,
          tool_check_findings: [],
          history: [],
          source_type: sourceType,
        });
      return { status: 200, body: detail.submissions[subIdx] };
    }

    // F-18 User Books Admin Decision -> updates parent submission so addPage unlocks
    const userBookDecisionMatch =
      /^\/books\/admin\/quality\/user-books\/submissions\/([^/]+)\/decision$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && userBookDecisionMatch) {
      const sid = decodeURIComponent(userBookDecisionMatch[1] ?? "");
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const decision =
        typeof body.decision === "string" ? body.decision : "APPROVE";
      const res =
        typeof cluster2Handler === "function"
          ? await cluster2Handler(ctx)
          : undefined;
      for (const detail of state.cluster2.privateBooks) {
        const subIdx = detail.submissions.findIndex((s) => s.id === sid);
        if (subIdx >= 0) {
          detail.submissions[subIdx] = {
            ...detail.submissions[subIdx]!,
            workflow_status:
              decision === "APPROVE" ? "APPROVED_READY_TO_ADD" : "REJECTED",
            can_add_to_book: decision === "APPROVE",
          };
        }
      }
      return res;
    }

    // F-06/F-18 Suspend private user book -> blocks reading (F-06 x F-07)
    const userBookSuspendMatch =
      /^\/books\/admin\/quality\/user-books\/([^/]+)\/suspend$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && userBookSuspendMatch) {
      const bid = decodeURIComponent(userBookSuspendMatch[1] ?? "");
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const reason =
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : "Tạm đình chỉ để kiểm tra";
      if (!state.suspendedPrivateBookIds.includes(bid)) {
        state.suspendedPrivateBookIds.push(bid);
      }
      const priv = state.cluster2.privateBooks.find((d) => d.book.id === bid);
      if (priv) {
        priv.book = {
          ...priv.book,
          moderation_status: "SUSPENDED",
          readable_for_children: false,
        };
      }
      return {
        status: 200,
        body: {
          book_id: bid,
          moderation_status: "SUSPENDED",
          suspended_at: OPAQUE_NOW_ISO,
          reason,
          audit_log_id: makeOpaqueUuid((state.nextId += 1), "87000000"),
        },
      };
    }

    // F-06 Flow 2 OCR contribution opt-in -> adds candidate to Flow 2 panel (F-06 x F-20)
    const privateContribMatch =
      /^\/books\/my-books\/([^/]+)\/ocr-contribution$/u.exec(ctx.pathname);
    if (privateContribMatch) {
      const bid = decodeURIComponent(privateContribMatch[1] ?? "");
      const detail = state.cluster2.privateBooks.find((d) => d.book.id === bid);
      if (!detail) return { status: 404, body: { detail: "BOOK_NOT_FOUND" } };
      if (ctx.method === "PUT") {
        const sourceType =
          detail.submissions[0]?.source_type ??
          detail.book.ocr_contribution.rights_basis;
        if (sourceType !== "SELF_AUTHORED") {
          return {
            status: 422,
            body: { detail: "OCR_CONTRIBUTION_NOT_ELIGIBLE" },
          };
        }
        const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
        const enabled = Boolean(body.enabled);
        const nextContrib = makePrivateBookOcrContribution({
          book_id: bid,
          enabled,
          status: enabled ? "OPTED_IN" : "REVOKED",
          consent_version: enabled ? 1 : 0,
          rights_confirmed: enabled,
          consented_at: enabled ? OPAQUE_NOW_ISO : null,
          revoked_at: enabled ? null : OPAQUE_NOW_ISO,
          status_notice: enabled
            ? "Đã bật đóng góp mẫu nhận diện."
            : "Đã ngừng đóng góp mẫu nhận diện.",
        });
        detail.book = { ...detail.book, ocr_contribution: nextContrib };
        if (enabled && !state.flow2Candidates.some((c) => c.book_id === bid)) {
          state.flow2Candidates.unshift({
            id: makeOpaqueUuid((state.nextId += 1), "87200000"),
            book_id: bid,
            book_title: detail.book.title,
            source_type: sourceType,
            submission_id: detail.submissions[0]?.id ?? OPAQUE_SUBMISSION_ID,
            page_number: 1,
            status: "PENDING",
            proposed_label: "Chú mèo con chạy trên cỏ xanh",
            verified_label: null,
            crop_image_url: `${ctx.url.origin}/media/picture-sample.png`,
            rights_confirmed: true,
            created_at: OPAQUE_NOW_ISO,
          });
        }
        return { status: 200, body: nextContrib };
      }
      return { status: 200, body: detail.book.ocr_contribution };
    }

    // F-06 add-page also makes private book visible in catalog/reading if readable
    const privateAddPageMatch =
      /^\/books\/my-books\/([^/]+)\/submissions\/([^/]+)\/add-page$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && privateAddPageMatch) {
      const bid = decodeURIComponent(privateAddPageMatch[1] ?? "");
      const res =
        typeof cluster2Handler === "function"
          ? await cluster2Handler(ctx)
          : undefined;
      const detail = state.cluster2.privateBooks.find((d) => d.book.id === bid);
      if (detail && res?.status === 200 && isRecord(res.body)) {
        const pageId = String(res.body.page_id ?? OPAQUE_PAGE_ID);
        const revId = String(res.body.revision_id ?? OPAQUE_REV_ID);
        const existingCat = state.cluster2.catalogBooks.find(
          (b) => b.id === bid,
        );
        if (!existingCat) {
          state.cluster2.catalogBooks.push(
            makeCatalogBook({
              id: bid,
              title: detail.book.title,
              author: detail.book.author,
              min_grade: detail.book.min_grade,
              max_grade: detail.book.max_grade,
              visibility_scope: "PARENT_PRIVATE",
              lifecycle_status: "ACTIVE",
            }),
          );
        }
        state.cluster2.previewsByBook[bid] = [
          makeCatalogPagePreview({
            page_id: pageId,
            page_number: 1,
            current_verified_revision_id: revId,
          }),
        ];
      }
      return res;
    }

    // F-20 Flow 2 Candidates Admin Panel & Training Dataset Sync (F-06 x F-20)
    if (
      ctx.method === "GET" &&
      ctx.pathname === "/books/admin/quality/user-books/flow2-candidates"
    ) {
      const statusFilter = ctx.url.searchParams.get("status");
      const items = statusFilter
        ? state.flow2Candidates.filter((c) => c.status === statusFilter)
        : state.flow2Candidates;
      return {
        status: 200,
        body: {
          items,
          total: items.length,
          limit: 20,
          offset: 0,
          summary: {
            PENDING: state.flow2Candidates.filter((c) => c.status === "PENDING")
              .length,
            APPROVED: state.flow2Candidates.filter(
              (c) => c.status === "APPROVED",
            ).length,
            REJECTED: state.flow2Candidates.filter(
              (c) => c.status === "REJECTED",
            ).length,
            REVOKED: state.flow2Candidates.filter((c) => c.status === "REVOKED")
              .length,
          },
        },
      };
    }

    const flow2DecisionMatch =
      /^\/books\/admin\/quality\/user-books\/flow2-candidates\/([^/]+)\/decision$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && flow2DecisionMatch) {
      const cid = decodeURIComponent(flow2DecisionMatch[1] ?? "");
      const candidate = state.flow2Candidates.find((c) => c.id === cid);
      if (!candidate) {
        return { status: 404, body: { detail: "CANDIDATE_NOT_FOUND" } };
      }
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const decision = body.decision === "REJECT" ? "REJECTED" : "APPROVED";
      candidate.status = decision;
      if (decision === "APPROVED") {
        candidate.verified_label =
          typeof body.verified_label === "string"
            ? body.verified_label
            : candidate.proposed_label;
        const overview = state.cluster2.trainingOverview as {
          flow2_ready_count?: number;
        };
        overview.flow2_ready_count = (overview.flow2_ready_count ?? 0) + 1;
      } else {
        candidate.rejection_reason =
          typeof body.rejection_reason === "string"
            ? body.rejection_reason
            : "REJECTED";
      }
      return { status: 200, body: candidate };
    }

    if (
      ctx.method === "GET" &&
      ctx.pathname ===
        "/books/admin/viread-training/datasets/flow2-admin-verified"
    ) {
      const approved = state.flow2Candidates.filter(
        (c) => c.status === "APPROVED",
      );
      return {
        status: 200,
        body: {
          dataset_kind: "flow2-admin-verified",
          total: approved.length,
          samples: approved,
        },
      };
    }

    if (
      ctx.method === "POST" &&
      ctx.pathname === "/books/admin/viread-training/flow2/trigger"
    ) {
      const approvedCount = state.flow2Candidates.filter(
        (c) => c.status === "APPROVED",
      ).length;
      return {
        status: 200,
        body: {
          ...makeFlow2TriggerResponse(),
          sample_count: Math.max(1, approvedCount),
        },
      };
    }

    // F-05 Catalog detail & preview honoring retired/suspended state (F-05 x F-07)
    const catalogDetailMatch = /^\/books\/catalog\/([^/]+)$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && catalogDetailMatch) {
      const bid = decodeURIComponent(catalogDetailMatch[1] ?? "");
      if (state.suspendedPrivateBookIds.includes(bid)) {
        return {
          status: 403,
          body: { detail: { code: "BOOK_BLOCKED_BY_CHILD_SAFETY" } },
        };
      }
      if (bid === OPAQUE_PRIVATE_BOOK_ID) {
        return {
          status: 200,
          body: makeCatalogBook({
            id: OPAQUE_PRIVATE_BOOK_ID,
            visibility_scope: "PARENT_PRIVATE",
            title: "Sách riêng của bé",
          }),
        };
      }
      const found = state.cluster2.catalogBooks.find((b) => b.id === bid);
      if (!found) {
        return { status: 404, body: { detail: "BOOK_NOT_FOUND" } };
      }
      return { status: 200, body: found };
    }

    const catalogPreviewMatch = /^\/books\/catalog\/([^/]+)\/preview$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && catalogPreviewMatch) {
      const bid = decodeURIComponent(catalogPreviewMatch[1] ?? "");
      if (state.cluster2.previewsByBook[bid]) {
        return { status: 200, body: state.cluster2.previewsByBook[bid] };
      }
      return {
        status: 200,
        body: [
          makeCatalogPagePreview({
            page_id: OPAQUE_PAGE_ID,
            page_number: 1,
            current_verified_revision_id: OPAQUE_REV_ID,
          }),
          makeCatalogPagePreview({
            page_id: OPAQUE_PAGE_2_ID,
            page_number: 2,
            current_verified_revision_id: OPAQUE_REV_2_ID,
          }),
        ],
      };
    }

    // -----------------------------------------------------------------------
    // F-07 Reading Session Creation / Events / Finish (shared state bridges)
    // -----------------------------------------------------------------------
    if (ctx.method === "POST" && ctx.pathname === "/reading/sessions") {
      const payload = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const childId =
        typeof payload.child_id === "string"
          ? payload.child_id
          : OPAQUE_CHILD_ID;
      const bookId =
        typeof payload.book_id === "string" ? payload.book_id : OPAQUE_BOOK_ID;
      const selectedPageId =
        typeof payload.selected_page_id === "string"
          ? payload.selected_page_id
          : OPAQUE_PAGE_ID;
      const selectedRevisionId =
        typeof payload.selected_page_revision_id === "string"
          ? payload.selected_page_revision_id
          : OPAQUE_REV_ID;

      if (!state.cluster1.children.some((c) => c.id === childId)) {
        return { status: 404, body: { detail: "CHILD_NOT_FOUND" } };
      }
      if (state.suspendedPrivateBookIds.includes(bookId)) {
        return {
          status: 403,
          body: { detail: { code: "BOOK_BLOCKED_BY_CHILD_SAFETY" } },
        };
      }
      const catalogExists =
        bookId === OPAQUE_PRIVATE_BOOK_ID ||
        state.cluster2.catalogBooks.some(
          (b) => b.id === bookId && b.lifecycle_status === "ACTIVE",
        );
      if (!catalogExists) {
        return { status: 409, body: { detail: "BOOK_UNAVAILABLE" } };
      }

      const sid = OPAQUE_SESSION_ID;
      state.readingSessionsById[sid] = {
        id: sid,
        child_id: childId,
        book_id: bookId,
        selected_page_id: selectedPageId,
        selected_page_revision_id: selectedRevisionId,
        state: "IN_PROGRESS",
        duration_ms: null,
      };
      if (selectedPageId === OPAQUE_PAGE_2_ID) {
        state.cluster3.currentPageNumber = 2;
      } else {
        state.cluster3.currentPageNumber = 1;
      }
      return {
        status: 201,
        body: {
          Id: sid,
          State: "IN_PROGRESS",
          SelectedPageId: selectedPageId,
          SelectedPageRevisionId: selectedRevisionId,
          StartedAt: OPAQUE_NOW_ISO,
        },
      };
    }

    if (ctx.method === "POST" && ctx.pathname === "/reading/events") {
      const payload = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const sid =
        typeof payload.SessionId === "string"
          ? payload.SessionId
          : OPAQUE_SESSION_ID;
      const eventId = makeOpaqueUuid((state.nextId += 1), "87100000");
      const wordText =
        isRecord(payload.Metadata) && typeof payload.Metadata.word === "string"
          ? payload.Metadata.word
          : "lấp lánh";
      const ev = {
        id: eventId,
        session_id: sid,
        page_id:
          typeof payload.PageId === "string" ? payload.PageId : OPAQUE_PAGE_ID,
        page_revision_id:
          typeof payload.PageRevisionId === "string"
            ? payload.PageRevisionId
            : OPAQUE_REV_ID,
        page_revision_word_id:
          typeof payload.WordId === "string"
            ? payload.WordId
            : OPAQUE_WORD_1_ID,
        type: typeof payload.Type === "string" ? payload.Type : "WORD_RETRY",
        status:
          typeof payload.Status === "string" ? payload.Status : "CONFIRMED",
        start_ms: typeof payload.StartMs === "number" ? payload.StartMs : 0,
        end_ms: typeof payload.EndMs === "number" ? payload.EndMs : null,
        confidence: null,
        metadata: isRecord(payload.Metadata) ? payload.Metadata : {},
      };
      state.readingEvents.push(ev);
      if (
        !state.difficultWords.some(
          (w) => w.normalized_word === wordText.toLowerCase(),
        )
      ) {
        state.difficultWords.unshift(
          makeDifficultWordEntry({
            normalized_word: wordText.toLowerCase(),
            display_text: wordText,
            practice_status: "NOT_PRACTICED",
          }),
        );
      }
      return {
        status: 201,
        body: {
          Id: eventId,
          SessionId: ev.session_id,
          PageId: ev.page_id,
          PageRevisionId: ev.page_revision_id,
          WordId: ev.page_revision_word_id,
          Type: ev.type,
          StartMs: ev.start_ms,
          EndMs: ev.end_ms,
          Confidence: null,
          Status: ev.status,
          Metadata: ev.metadata,
          CreatedAt: OPAQUE_NOW_ISO,
        },
      };
    }

    const sessionFinishMatch = /^\/reading\/sessions\/([^/]+)\/finish$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "POST" && sessionFinishMatch) {
      const sid = decodeURIComponent(
        sessionFinishMatch[1] ?? OPAQUE_SESSION_ID,
      );
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const durationMs =
        typeof body.duration_ms === "number" ? body.duration_ms : 900_000;
      const existing = state.readingSessionsById[sid];
      if (existing) {
        existing.state = "FINISHED";
        existing.duration_ms = durationMs;
      }
      const addedMinutes = Math.max(1, Math.round(durationMs / 60_000));
      state.readingGoals = state.readingGoals.map((g) => {
        const cur = Number(g.current_value ?? 0) + addedMinutes;
        const target = Math.max(1, Number(g.target_value ?? 20));
        return {
          ...g,
          current_value: cur,
          progress_percent: Math.min(100, Math.round((cur / target) * 100)),
        };
      });
      state.readingPlans = state.readingPlans.map((p) => ({
        ...p,
        minutes_today: Number(p.minutes_today ?? 0) + addedMinutes,
        completed_days_this_week: Math.min(
          Number(p.scheduled_days_this_week ?? 3),
          Number(p.completed_days_this_week ?? 0) + 1,
        ),
      }));
      return {
        status: 200,
        body: {
          id: sid,
          child_id: existing?.child_id ?? OPAQUE_CHILD_ID,
          book_id: existing?.book_id ?? OPAQUE_BOOK_ID,
          state: "FINISHED",
          started_at: "2026-11-21T09:50:00Z",
          ended_at: OPAQUE_NOW_ISO,
          duration_ms: durationMs,
        },
      };
    }

    if (ctx.method === "GET" && ctx.pathname === "/reading/history") {
      return {
        status: 200,
        body: {
          sessions: state.readingHistory,
          next_cursor: null,
        },
      };
    }

    const historyDetailMatch = /^\/reading\/history\/([^/]+)$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && historyDetailMatch) {
      const sid = decodeURIComponent(
        historyDetailMatch[1] ?? OPAQUE_SESSION_ID,
      );
      const sess = state.readingSessionsById[sid];
      return {
        status: 200,
        body: makeReadingSessionDetail({
          id: sid,
          child_id: sess?.child_id ?? OPAQUE_CHILD_ID,
          book_id: sess?.book_id ?? OPAQUE_BOOK_ID,
          duration_ms: sess?.duration_ms ?? 900_000,
          events: state.readingEvents as ReturnType<
            typeof makeReadingSessionDetail
          >["events"],
        }),
      };
    }

    const historyBookMatch = /^\/reading\/history\/([^/]+)\/book$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && historyBookMatch) {
      return {
        status: 200,
        body: state.cluster2.catalogBooks[0] ?? makeCatalogBook(),
      };
    }

    // -----------------------------------------------------------------------
    // F-11 Tutor Comprehension Questions & Progress Assessment
    // -----------------------------------------------------------------------
    const tutorGenMatch =
      /^\/tutor\/sessions\/([^/]+)\/questions\/generate$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && tutorGenMatch) {
      const sid = decodeURIComponent(tutorGenMatch[1] ?? OPAQUE_SESSION_ID);
      if (!state.tutorBySession[sid]) {
        state.tutorBySession[sid] = makeDefaultTutorQuestions();
      }
      const tState = state.tutorBySession[sid]!;
      return {
        status: 200,
        body: {
          session_id: sid,
          total: tState.questions.length,
          source: "AI",
          created: true,
        },
      };
    }

    const tutorNextMatch =
      /^\/tutor\/sessions\/([^/]+)\/questions\/next$/u.exec(ctx.pathname);
    if (ctx.method === "GET" && tutorNextMatch) {
      const sid = decodeURIComponent(tutorNextMatch[1] ?? OPAQUE_SESSION_ID);
      const tState =
        state.tutorBySession[sid] ??
        (state.tutorBySession[sid] = makeDefaultTutorQuestions());
      const q = tState.questions[tState.currentIndex] ?? null;
      if (!q || tState.currentIndex >= tState.questions.length) {
        return {
          status: 200,
          body: {
            question: null,
            choices: [],
            progress_label: `${tState.questions.length}/${tState.questions.length}`,
            position: tState.questions.length,
            total: tState.questions.length,
            completed: true,
          },
        };
      }
      // Security contract: NEVER expose expectedAnswer / ExpectedAnswer
      return {
        status: 200,
        body: makeTutorNextQuestion({
          question: {
            id: q.id,
            type: q.type,
            prompt: q.prompt,
            page_revision_id: q.page_revision_id,
            source_span: q.source_span,
            difficulty: q.difficulty,
            answered: q.answered,
          },
          choices: q.choices,
          progress_label: `Câu ${tState.currentIndex + 1}/${tState.questions.length}`,
          position: tState.currentIndex + 1,
          total: tState.questions.length,
          completed: false,
        }),
      };
    }

    const tutorAnswerMatch =
      /^\/tutor\/sessions\/([^/]+)\/questions\/([^/]+)\/answer$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && tutorAnswerMatch) {
      const sid = decodeURIComponent(tutorAnswerMatch[1] ?? OPAQUE_SESSION_ID);
      const qid = decodeURIComponent(tutorAnswerMatch[2] ?? "");
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const submitted = typeof body.answer === "string" ? body.answer : "";
      const tState =
        state.tutorBySession[sid] ??
        (state.tutorBySession[sid] = makeDefaultTutorQuestions());
      const q = tState.questions.find((item) => item.id === qid);
      const isCorrect = q ? submitted === q.expectedAnswer : true;
      if (isCorrect && q) {
        q.answered = true;
        tState.currentIndex = Math.min(
          tState.questions.length,
          tState.currentIndex + 1,
        );
      }
      return {
        status: 200,
        body: makeTutorAnswerResponse({
          answer_id: makeOpaqueUuid((state.nextId += 1), "f1100003"),
          question_id: qid,
          submitted_answer: submitted,
          is_correct: isCorrect,
          score: isCorrect ? 100 : 0,
          feedback_code: isCorrect ? "CORRECT" : "TRY_AGAIN",
          story_hint: isCorrect
            ? null
            : "Bé đọc lại đoạn đầu câu chuyện để nhớ chi tiết nhé.",
        }),
      };
    }

    const tutorProgressMatch =
      /^\/tutor\/children\/([^/]+)\/progress-assessment$/u.exec(ctx.pathname);
    if (tutorProgressMatch) {
      return { status: 200, body: state.childProgressAssessment };
    }

    // -----------------------------------------------------------------------
    // F-12 Reports & Difficult Words (Zod-exact arrays & attempt schemas)
    // -----------------------------------------------------------------------
    if (ctx.method === "GET" && ctx.pathname === "/system/reports") {
      return { status: 200, body: [state.progressReport] };
    }
    if (ctx.method === "POST" && ctx.pathname === "/system/reports") {
      return { status: 201, body: state.progressReport };
    }
    const progressPeriodsMatch = /^\/system\/progress\/([^/]+)\/periods$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && progressPeriodsMatch) {
      return { status: 200, body: state.progressPeriods };
    }
    const progressChildMatch = /^\/system\/progress\/([^/]+)$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && progressChildMatch) {
      return { status: 200, body: state.progressReport };
    }

    const sessionReportsMatch = /^\/reading\/sessions\/([^/]+)\/reports$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && sessionReportsMatch) {
      const sid = decodeURIComponent(
        sessionReportsMatch[1] ?? OPAQUE_SESSION_ID,
      );
      return {
        status: 200,
        body: state.sessionReportsBySession[sid] ?? makeSessionReadingReports(),
      };
    }

    const difficultListMatch = /^\/system\/difficult-words\/([^/]+)$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && difficultListMatch) {
      const statusFilter = ctx.url.searchParams.get("status_filter");
      const items = statusFilter
        ? state.difficultWords.filter((w) => w.practice_status === statusFilter)
        : state.difficultWords;
      return { status: 200, body: items };
    }

    const difficultHistoryMatch =
      /^\/system\/difficult-words\/([^/]+)\/practice\/history$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "GET" && difficultHistoryMatch) {
      const items = Object.values(state.difficultWordAttempts).map((a) => ({
        attempt_id: a.attempt_id,
        normalized_word: a.normalized_word,
        display_text: a.display_text,
        attempt_number: a.attempt_number,
        state: a.state,
        assessment_status: a.assessment_status,
        recognition_source: a.recognition_source,
        spoken_transcript: a.spoken_transcript,
        confidence: a.confidence,
        audio_duration_ms: a.audio_duration_ms,
        assessment_version: a.assessment_version,
        started_at: a.started_at,
        completed_at: a.completed_at,
      }));
      return {
        status: 200,
        body: { storage_ready: true, items },
      };
    }

    const difficultStartMatch =
      /^\/system\/difficult-words\/([^/]+)\/practice\/start$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && difficultStartMatch) {
      const cid = decodeURIComponent(difficultStartMatch[1] ?? OPAQUE_CHILD_ID);
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const normalized =
        typeof body.normalized_word === "string"
          ? body.normalized_word
          : "lấp lánh";
      const displayText =
        typeof body.display_text === "string" ? body.display_text : normalized;
      const attemptId =
        Object.keys(state.difficultWordAttempts).length === 0
          ? OPAQUE_C4_DIFFICULT_WORD_ATTEMPT_ID
          : makeOpaqueUuid((state.nextId += 1), "f1200001");
      const wordItem = state.difficultWords.find(
        (w) => w.normalized_word === normalized,
      );
      const attempt: Tier34PracticeAttempt = {
        attempt_id: attemptId,
        child_id: cid,
        normalized_word: normalized,
        display_text: displayText,
        attempt_number: (wordItem?.practice_attempts_count ?? 0) + 1,
        state: "STARTED",
        assessment_status: null,
        recognition_source: null,
        spoken_transcript: null,
        confidence: null,
        audio_duration_ms: null,
        assessment_version: 1,
        evidence_word_ids: wordItem?.evidence_word_ids ?? [OPAQUE_WORD_1_ID],
        book_id: OPAQUE_BOOK_ID,
        session_id: OPAQUE_SESSION_ID,
        page_id: OPAQUE_PAGE_ID,
        page_revision_id: OPAQUE_REV_ID,
        word_id: OPAQUE_WORD_1_ID,
        resolved_in_session: false,
        persistence_backend: "PRACTICE_TABLE_AND_EVENT",
        started_at: OPAQUE_NOW_ISO,
        completed_at: null,
        feedback_message: null,
        word_progress: {
          normalized_word: normalized,
          practice_status: "IN_PROGRESS",
          practice_attempts_count: wordItem?.practice_attempts_count ?? 0,
          practice_correct_count: wordItem?.practice_correct_count ?? 0,
          practice_incorrect_count: wordItem?.practice_incorrect_count ?? 0,
          practice_uncertain_count: wordItem?.practice_uncertain_count ?? 0,
          consecutive_correct_count: wordItem?.consecutive_correct_count ?? 0,
          required_consecutive_correct: 2,
          last_practiced_at: OPAQUE_NOW_ISO,
          last_practice_status: wordItem?.last_practice_status ?? null,
        },
        next_recommended_word: "rì rào",
        evidence_count_unchanged: true,
      };
      state.difficultWordAttempts[attemptId] = attempt;
      return { status: 200, body: attempt };
    }

    const difficultEvalAudioMatch =
      /^\/system\/difficult-words\/([^/]+)\/practice\/([^/]+)\/evaluate-audio$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && difficultEvalAudioMatch) {
      const aid = decodeURIComponent(difficultEvalAudioMatch[2] ?? "");
      const attempt = state.difficultWordAttempts[aid];
      if (!attempt) {
        return { status: 404, body: { detail: "ATTEMPT_NOT_FOUND" } };
      }
      const updated: Tier34PracticeAttempt = {
        ...attempt,
        assessment_status: "CORRECT",
        recognition_source: "SERVER_STT",
        spoken_transcript: attempt.display_text,
        confidence: 0.94,
        audio_duration_ms: 820,
        feedback_message: `Con đọc rõ từ ${attempt.display_text} rồi!`,
      };
      state.difficultWordAttempts[aid] = updated;
      return { status: 200, body: updated };
    }

    const difficultCompleteMatch =
      /^\/system\/difficult-words\/([^/]+)\/practice\/([^/]+)\/complete$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && difficultCompleteMatch) {
      const aid = decodeURIComponent(difficultCompleteMatch[2] ?? "");
      const attempt = state.difficultWordAttempts[aid];
      if (!attempt) {
        return { status: 404, body: { detail: "ATTEMPT_NOT_FOUND" } };
      }
      if (attempt.state === "COMPLETED") {
        return {
          status: 409,
          body: {
            detail: { code: "DIFFICULT_WORD_ATTEMPT_ALREADY_COMPLETED" },
          },
        };
      }
      const wordItem = state.difficultWords.find(
        (w) => w.normalized_word === attempt.normalized_word,
      );
      if (wordItem) {
        wordItem.practice_status = "COMPLETED";
        wordItem.practice_attempts_count += 1;
        wordItem.practice_correct_count += 1;
        wordItem.consecutive_correct_count += 1;
        wordItem.last_practiced_at = OPAQUE_NOW_ISO;
        wordItem.last_practice_status = "CORRECT";
      }
      const completed: Tier34PracticeAttempt = {
        ...attempt,
        state: "COMPLETED",
        assessment_status: attempt.assessment_status ?? "CORRECT",
        recognition_source: attempt.recognition_source ?? "SERVER_STT",
        spoken_transcript: attempt.spoken_transcript ?? attempt.display_text,
        confidence: attempt.confidence ?? 0.95,
        audio_duration_ms: attempt.audio_duration_ms ?? 850,
        completed_at: OPAQUE_NOW_ISO,
        feedback_message: `Con đọc rất tốt từ ${attempt.display_text}!`,
        word_progress: {
          normalized_word: attempt.normalized_word,
          practice_status: "COMPLETED",
          practice_attempts_count: wordItem?.practice_attempts_count ?? 1,
          practice_correct_count: wordItem?.practice_correct_count ?? 1,
          practice_incorrect_count: wordItem?.practice_incorrect_count ?? 0,
          practice_uncertain_count: wordItem?.practice_uncertain_count ?? 0,
          consecutive_correct_count: wordItem?.consecutive_correct_count ?? 1,
          required_consecutive_correct: 2,
          last_practiced_at: OPAQUE_NOW_ISO,
          last_practice_status: "CORRECT",
        },
      };
      state.difficultWordAttempts[aid] = completed;
      return { status: 200, body: completed };
    }

    // -----------------------------------------------------------------------
    // F-13 Reading Management & Parent Notifications (top-level arrays!)
    // -----------------------------------------------------------------------
    if (ctx.pathname === "/reading-management/goals") {
      if (ctx.method === "GET") {
        return { status: 200, body: state.readingGoals };
      }
      if (ctx.method === "POST") {
        const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
        const created = makeReadingGoal({
          id: makeOpaqueUuid((state.nextId += 1), "f1300001"),
          child_id:
            typeof body.child_id === "string" ? body.child_id : OPAQUE_CHILD_ID,
          metric: body.metric === "SESSIONS" ? "SESSIONS" : "MINUTES",
          target_value:
            typeof body.target_value === "number" ? body.target_value : 15,
          period: body.period === "WEEKLY" ? "WEEKLY" : "DAILY",
          current_value: 0,
          progress_percent: 0,
        });
        state.readingGoals.push(created);
        return { status: 201, body: created };
      }
    }

    if (ctx.pathname === "/reading-management/plans") {
      if (ctx.method === "GET") {
        return { status: 200, body: state.readingPlans };
      }
      if (ctx.method === "POST") {
        const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
        const created = makeReadingPlan({
          id: makeOpaqueUuid((state.nextId += 1), "f1300002"),
          child_id:
            typeof body.child_id === "string" ? body.child_id : OPAQUE_CHILD_ID,
          title:
            typeof body.title === "string" ? body.title : "Kế hoạch đọc mới",
          target_minutes:
            typeof body.target_minutes === "number" ? body.target_minutes : 15,
          minutes_today: 0,
          completed_days_this_week: 0,
          progress_percent: 0,
        });
        state.readingPlans.push(created);
        return { status: 201, body: created };
      }
    }

    if (
      ctx.method === "GET" &&
      ctx.pathname === "/reading-management/collections"
    ) {
      return { status: 200, body: state.readingCollections };
    }
    const collectionMatch =
      /^\/reading-management\/collections\/([^/]+)$/u.exec(ctx.pathname);
    if (collectionMatch) {
      const bookId = decodeURIComponent(collectionMatch[1] ?? OPAQUE_BOOK_ID);
      if (ctx.method === "PUT") {
        const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
        const created = makeReadingCollection({
          id: makeOpaqueUuid((state.nextId += 1), "f1300003"),
          child_id:
            typeof body.child_id === "string" ? body.child_id : OPAQUE_CHILD_ID,
          book_id: bookId,
          collection_type:
            body.collection_type === "WANT_TO_READ"
              ? "WANT_TO_READ"
              : "FAVORITE",
        });
        state.readingCollections.push(created);
        return { status: 200, body: created };
      }
      if (ctx.method === "DELETE") {
        state.readingCollections = state.readingCollections.filter(
          (c) => c.book_id !== bookId,
        );
        return { status: 200, body: { deleted: true } };
      }
    }

    if (ctx.pathname === "/reading-management/reminders") {
      if (ctx.method === "GET") {
        return { status: 200, body: state.readingReminders };
      }
      if (ctx.method === "POST") {
        const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
        const created = makeReadingReminder({
          id: makeOpaqueUuid((state.nextId += 1), "f1300004"),
          child_id:
            typeof body.child_id === "string" ? body.child_id : OPAQUE_CHILD_ID,
          remind_at:
            typeof body.remind_at === "string" ? body.remind_at : "20:00",
        });
        state.readingReminders.push(created);
        return { status: 201, body: created };
      }
    }

    if (
      ctx.method === "GET" &&
      ctx.pathname === "/reading-management/reminders/due"
    ) {
      return { status: 200, body: state.dueOccurrences };
    }

    const ackOccurrenceMatch =
      /^\/reading-management\/reminders\/occurrences\/([^/]+)\/acknowledge$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && ackOccurrenceMatch) {
      const oid = decodeURIComponent(
        ackOccurrenceMatch[1] ?? OPAQUE_C4_OCCURRENCE_ID,
      );
      const idx = state.dueOccurrences.findIndex((o) => o.id === oid);
      const current =
        idx >= 0 ? state.dueOccurrences[idx]! : state.dueOccurrences[0]!;
      const updated = {
        ...current,
        status: "ACKNOWLEDGED",
        acknowledged_at: OPAQUE_NOW_ISO,
      };
      if (idx >= 0) {
        state.dueOccurrences[idx] = updated;
      }
      return { status: 200, body: updated };
    }

    if (ctx.pathname === "/parent-notifications/preferences") {
      if (ctx.method === "GET") {
        return { status: 200, body: state.notificationPreferences };
      }
      if (ctx.method === "PUT") {
        const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
        state.notificationPreferences = {
          ...state.notificationPreferences,
          ...body,
          updated_at: OPAQUE_NOW_ISO,
        };
        return { status: 200, body: state.notificationPreferences };
      }
    }

    if (
      ctx.method === "GET" &&
      ctx.pathname === "/parent-notifications/history"
    ) {
      return { status: 200, body: state.notificationHistory };
    }

    if (
      ctx.method === "POST" &&
      ctx.pathname === "/parent-notifications/test-email"
    ) {
      const deliveryId = makeOpaqueUuid((state.nextId += 1), "f1300006");
      state.notificationHistory.unshift({
        id: deliveryId,
        category: "TEST_EMAIL",
        status: "SENT",
        subject: "Email kiểm tra ViRead",
        sent_at: OPAQUE_NOW_ISO,
        created_at: OPAQUE_NOW_ISO,
        error_code: null,
      });
      return {
        status: 200,
        body: {
          status: "SENT",
          delivery_id: deliveryId,
          provider: "resend",
          error_code: null,
          message: "Đã gửi email thử nghiệm.",
        },
      };
    }

    if (
      ctx.method === "POST" &&
      ctx.pathname === "/parent-notifications/cron/dispatch"
    ) {
      const scopeRaw = ctx.url.searchParams.get("scope") ?? "all";
      const scope =
        scopeRaw === "presence" ||
        scopeRaw === "reminders" ||
        scopeRaw === "engagement"
          ? scopeRaw
          : "all";
      const activeAlerts = Object.values(
        state.cluster3.presenceAlertsById ?? {},
      ).filter((a) => a.status !== "CANCELLED").length;
      return {
        status: 200,
        body: makeCronDispatchResponse({
          scope,
          presence_sent:
            scope === "presence" || scope === "all" ? activeAlerts : 0,
        }),
      };
    }

    // -----------------------------------------------------------------------
    // F-14 Adaptive Learning & Entertainment V4 Games
    // -----------------------------------------------------------------------
    const learningRecsMatch =
      /^\/learning\/children\/([^/]+)\/recommendations$/u.exec(ctx.pathname);
    if (ctx.method === "GET" && learningRecsMatch) {
      const cid = decodeURIComponent(learningRecsMatch[1] ?? OPAQUE_CHILD_ID);
      const child = state.cluster1.children.find((c) => c.id === cid);
      return {
        status: 200,
        body: {
          ...state.adaptiveRecommendations,
          child_id: cid,
          child_alias:
            child?.alias ?? state.adaptiveRecommendations.child_alias,
          child_grade:
            child?.grade ?? state.adaptiveRecommendations.child_grade,
          focus_difficult_words: state.difficultWords
            .filter((w) => w.practice_status !== "COMPLETED")
            .map((w) => w.display_text),
        },
      };
    }

    const learningAnalyticsMatch =
      /^\/learning\/children\/([^/]+)\/parent-analytics$/u.exec(ctx.pathname);
    if (ctx.method === "GET" && learningAnalyticsMatch) {
      const cid = decodeURIComponent(
        learningAnalyticsMatch[1] ?? OPAQUE_CHILD_ID,
      );
      const child = state.cluster1.children.find((c) => c.id === cid);
      return {
        status: 200,
        body: {
          ...state.parentAnalytics,
          child_id: cid,
          child_alias: child?.alias ?? state.parentAnalytics.child_alias,
          child_grade: child?.grade ?? state.parentAnalytics.child_grade,
        },
      };
    }

    if (
      ctx.method === "GET" &&
      ctx.pathname === "/games/sentence-shooter/books"
    ) {
      return { status: 200, body: state.sentenceShooterBooks };
    }

    if (
      ctx.method === "POST" &&
      ctx.pathname === "/games/sentence-shooter/sessions"
    ) {
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const focusWords = Array.isArray(body.focus_words)
        ? body.focus_words.filter((w): w is string => typeof w === "string")
        : ["lấp lánh"];
      const session = makeSentenceShooterSession({
        session_id: OPAQUE_C4_SHOOTER_SESSION_ID,
        total_rounds: 1,
        practiced_difficult_words: focusWords,
      });
      state.sentenceShooterSessions[OPAQUE_C4_SHOOTER_SESSION_ID] = session;
      return { status: 201, body: session };
    }

    const shooterHintMatch =
      /^\/games\/sentence-shooter\/sessions\/([^/]+)\/hints$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && shooterHintMatch) {
      return {
        status: 200,
        body: {
          target_token_id: OPAQUE_C4_SHOOTER_TOKEN_1,
          hint_count: 1,
          message: "Chọn cụm từ mở đầu câu nhé.",
        },
      };
    }

    const shooterShotMatch =
      /^\/games\/sentence-shooter\/sessions\/([^/]+)\/shots$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && shooterShotMatch) {
      const sid = decodeURIComponent(
        shooterShotMatch[1] ?? OPAQUE_C4_SHOOTER_SESSION_ID,
      );
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const clientShotId =
        typeof body.client_shot_id === "string" ? body.client_shot_id : null;
      if (clientShotId && state.sentenceShooterShotsSeen[clientShotId]) {
        return {
          status: 200,
          body: state.sentenceShooterShotsSeen[clientShotId],
        };
      }
      const tokenId = typeof body.token_id === "string" ? body.token_id : "";
      const isSecondToken = tokenId === OPAQUE_C4_SHOOTER_TOKEN_2;
      const result = makeSentenceShooterShotResult({
        is_correct: true,
        correct_count: isSecondToken ? 2 : 1,
        token_count: 2,
        completed_rounds: isSecondToken ? 1 : 0,
        total_stars: isSecondToken ? 3 : 0,
        round_completed: isSecondToken,
        session_completed: isSecondToken,
        next_expected_position: isSecondToken ? 2 : 1,
        stars_awarded: isSecondToken ? 3 : 0,
        completed_sentence: isSecondToken ? "Ánh nắng lấp lánh" : null,
        client_shot_id: clientShotId,
      });
      if (clientShotId) {
        state.sentenceShooterShotsSeen[clientShotId] = result;
      }
      if (isSecondToken) {
        const practiced = Array.isArray(
          state.parentAnalytics.practiced_difficult_words,
        )
          ? (state.parentAnalytics.practiced_difficult_words as Array<
              Record<string, unknown>
            >)
          : [];
        const existingWord = practiced.find(
          (w) => w.normalized_word === "lấp lánh",
        );
        if (existingWord) {
          existingWord.practice_count =
            Number(existingWord.practice_count ?? 1) + 1;
        }
      }
      const sess = state.sentenceShooterSessions[sid];
      if (sess && isSecondToken) {
        sess.completed_rounds = 1;
        sess.total_stars = 3;
      }
      return { status: 200, body: result };
    }

    const shooterResultMatch =
      /^\/games\/sentence-shooter\/sessions\/([^/]+)\/result$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "GET" && shooterResultMatch) {
      const sid = decodeURIComponent(
        shooterResultMatch[1] ?? OPAQUE_C4_SHOOTER_SESSION_ID,
      );
      const sess =
        state.sentenceShooterSessions[sid] ?? makeSentenceShooterSession();
      return {
        status: 200,
        body: buildShooterResultPayload(sess, "COMPLETED"),
      };
    }

    if (
      ctx.method === "GET" &&
      ctx.pathname === "/games/picture-description/catalog"
    ) {
      return {
        status: 200,
        body:
          state.pictureCatalog ?? makePictureDescriptionCatalog(ctx.url.origin),
      };
    }
    if (
      ctx.method === "GET" &&
      ctx.pathname === "/games/picture-description/sessions"
    ) {
      return { status: 200, body: [] };
    }
    if (
      ctx.method === "POST" &&
      ctx.pathname === "/games/picture-description/sessions"
    ) {
      const rawText = ctx.postDataText ?? "";
      if (rawText.includes("unsafe")) {
        return {
          status: 422,
          body: { detail: { code: "UNSAFE_PICTURE" } },
        };
      }
      const session = makePictureDescriptionSession(ctx.url.origin);
      state.pictureSessions[OPAQUE_C4_PICTURE_SESSION_ID] = session;
      return { status: 201, body: session };
    }
    const pictureEvalMatch =
      /^\/games\/picture-description\/sessions\/([^/]+)\/evaluate$/u.exec(
        ctx.pathname,
      );
    if (ctx.method === "POST" && pictureEvalMatch) {
      return {
        status: 200,
        body: makePictureDescriptionEvaluateResponse(ctx.url.origin),
      };
    }

    // Memory Game (Zod-exact schema!)
    if (ctx.method === "GET" && ctx.pathname === "/games/memory/themes") {
      return { status: 200, body: state.memoryThemes };
    }
    if (ctx.pathname === "/games/memory/sessions") {
      if (ctx.method === "GET") {
        return { status: 200, body: [] };
      }
      if (ctx.method === "POST") {
        const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
        const child = state.cluster1.children[0];
        const session = makeTier34MemorySession({
          child_id:
            typeof body.child_id === "string" ? body.child_id : OPAQUE_CHILD_ID,
          child_grade: child?.grade ?? 2,
          timer_mode:
            typeof body.timer_mode === "string"
              ? (body.timer_mode as Tier34MemorySession["timer_mode"])
              : "30S",
        });
        state.memorySessions[session.id] = session;
        return { status: 201, body: session };
      }
    }
    const memoryPeekMatch = /^\/games\/memory\/sessions\/([^/]+)\/peek$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "POST" && memoryPeekMatch) {
      const sid = decodeURIComponent(
        memoryPeekMatch[1] ?? OPAQUE_C4_MEMORY_SESSION_ID,
      );
      const sess = state.memorySessions[sid];
      if (sess) sess.peek_count += 1;
      return {
        status: 200,
        body: {
          session_id: sid,
          peek_count: sess?.peek_count ?? 1,
          peek_duration_seconds: 3,
          message_vi: "Xem nhanh lại bức tranh nhé!",
        },
      };
    }
    const memoryHintMatch = /^\/games\/memory\/sessions\/([^/]+)\/hint$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "POST" && memoryHintMatch) {
      const sid = decodeURIComponent(
        memoryHintMatch[1] ?? OPAQUE_C4_MEMORY_SESSION_ID,
      );
      const sess = state.memorySessions[sid];
      if (sess) sess.hints_used += 1;
      return {
        status: 200,
        body: {
          session_id: sid,
          hints_used: sess?.hints_used ?? 1,
          object_id: "obj-ball",
          tier: 1,
          hint_text_vi: "Có một đồ vật tròn ở giữa vườn.",
          remaining_unmentioned_count: 1,
          has_more_tiers: true,
        },
      };
    }
    const memoryAttemptsMatch =
      /^\/games\/memory\/sessions\/([^/]+)\/attempts$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && memoryAttemptsMatch) {
      const sid = decodeURIComponent(
        memoryAttemptsMatch[1] ?? OPAQUE_C4_MEMORY_SESSION_ID,
      );
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const stage = body.stage === "CREATIVE" ? "CREATIVE" : "RECALL";
      const responseText =
        typeof body.response_text === "string"
          ? body.response_text
          : "Quả bóng đỏ ở giữa.";
      const sess =
        state.memorySessions[sid] ?? makeTier34MemorySession({ id: sid });
      const evaluation = {
        stage,
        factual_score: 90,
        creative_score: stage === "CREATIVE" ? 95 : 40,
        stars: 3,
        matched_facts: [
          {
            object_id: "obj-ball",
            sprite_key: "ball",
            name_vi: "quả bóng",
            color_vi: "đỏ",
            count: 1,
            position_zone: "giữa",
            matched_attributes: ["màu đỏ", "ở giữa"],
            detail_vi: "1 quả bóng đỏ ở giữa",
            bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
          },
        ],
        missed_facts: [],
        creative_highlights: ["Câu chuyện giàu trí tưởng tượng"],
        story_anchors: ["quả bóng đỏ"],
        praise_message_vi:
          stage === "CREATIVE"
            ? "Câu chuyện của con rất sáng tạo!"
            : "Con nhớ rất chính xác!",
        story_praise_vi: "Ý tưởng rất hay!",
        next_tip_vi: "Thử thêm một nhân vật mới nhé.",
        creative_followup_vi: "Ai sẽ chơi cùng quả bóng đỏ?",
        support_summary_vi: null,
        used_focus_words: ["quả bóng"],
        ai_provider: "CURATED",
      };
      const attempt = {
        id: makeOpaqueUuid((state.nextId += 1), "f1400009"),
        session_id: sid,
        attempt_number: sess.attempts.length + 1,
        stage,
        input_mode: body.input_mode === "VOICE" ? "VOICE" : "TEXT",
        response_text: responseText,
        factual_score: 90,
        creative_score: evaluation.creative_score,
        stars: 3,
        evaluation,
        ai_provider: "CURATED",
        created_at: OPAQUE_NOW_ISO,
      };
      sess.status = stage === "CREATIVE" ? "COMPLETED" : "RECALLING";
      sess.best_factual_score = 90;
      sess.best_creative_score = evaluation.creative_score;
      sess.stars = 3;
      sess.attempts_count = sess.attempts.length + 1;
      sess.attempts.push(attempt);
      state.memorySessions[sid] = sess;
      return {
        status: 200,
        body: { attempt, session: sess },
      };
    }

    // -----------------------------------------------------------------------
    // F-15 Karaoke Ecosystem (Simple Import -> Publish -> Parent Practice -> F-14)
    // -----------------------------------------------------------------------
    if (
      ctx.method === "GET" &&
      ctx.pathname === "/karaoke/admin/processing-capabilities"
    ) {
      return { status: 200, body: state.karaokeCapabilities };
    }

    if (
      ctx.method === "POST" &&
      ctx.pathname === "/karaoke/admin/songs/simple-import"
    ) {
      const songId = makeOpaqueUuid((state.nextId += 1), "f1500001");
      const draftVersionId = makeOpaqueUuid((state.nextId += 1), "f1500002");
      const songDetail = makeAdminKaraokeSongDetail({
        song_id: songId,
        status: "DRAFT",
        revision: 1,
        published: null,
        draft: {
          ...(makeAdminKaraokeSongDetail().draft as Record<string, unknown>),
          id: draftVersionId,
          title: "Bài hát Mới Tinh",
          author: "Tác giả ViRead",
        },
      });
      state.karaokeAdminSongs.unshift(songDetail);
      return {
        status: 201,
        body: makeSimpleImportResult({
          song_id: songId,
          version_id: draftVersionId,
          revision: 1,
          title: "Bài hát Mới Tinh",
          author: "Tác giả ViRead",
          song: songDetail,
        }),
      };
    }

    const karaokeSimpleProcMatch =
      /^\/karaoke\/admin\/songs\/([^/]+)\/simple-processing$/u.exec(
        ctx.pathname,
      );
    if (karaokeSimpleProcMatch) {
      const sid = decodeURIComponent(
        karaokeSimpleProcMatch[1] ?? OPAQUE_C4_KARAOKE_SONG_ID,
      );
      return {
        status: 200,
        body: makeSimpleProcessingStatus({
          song_id: sid,
          job_id: OPAQUE_C4_KARAOKE_JOB_ID,
        }),
      };
    }

    const karaokeSimplePublishMatch =
      /^\/karaoke\/admin\/songs\/([^/]+)\/simple-publish$/u.exec(ctx.pathname);
    if (ctx.method === "POST" && karaokeSimplePublishMatch) {
      const sid = decodeURIComponent(
        karaokeSimplePublishMatch[1] ?? OPAQUE_C4_KARAOKE_SONG_ID,
      );
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const songIdx = state.karaokeAdminSongs.findIndex(
        (s) => s.song_id === sid,
      );
      const current =
        songIdx >= 0
          ? state.karaokeAdminSongs[songIdx]!
          : makeAdminKaraokeSongDetail({ song_id: sid, status: "DRAFT" });
      const currentRev = Number(current.revision ?? 1);
      if (
        typeof body.expected_revision === "number" &&
        body.expected_revision !== currentRev
      ) {
        return {
          status: 409,
          body: { detail: "KARAOKE_REVISION_CONFLICT" },
        };
      }
      const nextRev = currentRev + 1;
      const versionId =
        typeof body.draft_version_id === "string"
          ? body.draft_version_id
          : OPAQUE_C4_KARAOKE_VERSION_ID;
      const draftObj = isRecord(current.draft) ? current.draft : {};
      const title =
        typeof body.title === "string"
          ? body.title
          : String(draftObj.title ?? "Bài hát Mới Tinh");
      const author =
        typeof body.author === "string"
          ? body.author
          : String(draftObj.author ?? "Tác giả ViRead");
      const publishedVersion = {
        ...draftObj,
        id: versionId,
        title,
        author,
        state: "PUBLISHED",
        published_at: OPAQUE_NOW_ISO,
        lyrics: makeKaraokeLyricsPayload(),
      };
      const updated = {
        ...current,
        status: "PUBLISHED",
        revision: nextRev,
        published: publishedVersion,
      };
      if (songIdx >= 0) {
        state.karaokeAdminSongs[songIdx] = updated;
      }
      if (!state.karaokeCatalogSongs.some((c) => c.song_id === sid)) {
        state.karaokeCatalogSongs.unshift(
          makeKaraokeSongCard({
            song_id: sid,
            version_id: versionId,
            title,
            author,
          }),
        );
      }
      state.karaokePlaybackBySong[sid] = makeKaraokePlayback(ctx.url.origin, {
        song_id: sid,
        version_id: versionId,
        title,
        author,
      });
      state.karaokeMusicalProfileBySong[sid] = makeKaraokeMusicalProfile({
        song_id: sid,
        song_version_id: versionId,
      });
      return { status: 200, body: updated };
    }

    if (ctx.method === "GET" && ctx.pathname === "/karaoke/admin/songs") {
      return {
        status: 200,
        body: {
          items: state.karaokeAdminSongs.map((s) =>
            makeAdminKaraokeSongSummary({
              song_id: s.song_id,
              status: s.status,
              revision: s.revision,
            }),
          ),
          total: state.karaokeAdminSongs.length,
          limit: 20,
          offset: 0,
        },
      };
    }

    if (ctx.method === "GET" && ctx.pathname === "/karaoke/songs") {
      return {
        status: 200,
        body: {
          items: state.karaokeCatalogSongs,
          total: state.karaokeCatalogSongs.length,
          limit: 12,
          offset: 0,
        },
      };
    }

    const karaokePlaybackMatch = /^\/karaoke\/songs\/([^/]+)\/playback$/u.exec(
      ctx.pathname,
    );
    if (ctx.method === "GET" && karaokePlaybackMatch) {
      const sid = decodeURIComponent(
        karaokePlaybackMatch[1] ?? OPAQUE_C4_KARAOKE_SONG_ID,
      );
      return {
        status: 200,
        body:
          state.karaokePlaybackBySong[sid] ??
          makeKaraokePlayback(ctx.url.origin, { song_id: sid }),
      };
    }

    const karaokeProfileMatch =
      /^\/karaoke\/songs\/([^/]+)\/musical-profile$/u.exec(ctx.pathname);
    if (ctx.method === "GET" && karaokeProfileMatch) {
      const sid = decodeURIComponent(
        karaokeProfileMatch[1] ?? OPAQUE_C4_KARAOKE_SONG_ID,
      );
      return {
        status: 200,
        body:
          state.karaokeMusicalProfileBySong[sid] ??
          makeKaraokeMusicalProfile({ song_id: sid }),
      };
    }

    if (ctx.pathname === "/karaoke/practice-sessions") {
      if (ctx.method === "GET") {
        const songId = ctx.url.searchParams.get("song_id");
        const items = songId
          ? state.karaokePracticeSessions.filter((p) => p.song_id === songId)
          : state.karaokePracticeSessions;
        return {
          status: 200,
          body: {
            child_id: OPAQUE_CHILD_ID,
            song_id: songId ?? null,
            best_full_song_score: items.length > 0 ? 88 : null,
            best_full_song_stars: items.length > 0 ? 3 : 0,
            total_sessions: items.length,
            items,
            storage_ready: true,
          },
        };
      }
      if (ctx.method === "POST") {
        const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
        const created = makeKaraokePracticeSession({
          id: makeOpaqueUuid((state.nextId += 1), "f150000a"),
          child_id:
            typeof body.child_id === "string" ? body.child_id : OPAQUE_CHILD_ID,
          song_id:
            typeof body.song_id === "string"
              ? body.song_id
              : OPAQUE_C4_KARAOKE_SONG_ID,
          song_version_id:
            typeof body.song_version_id === "string"
              ? body.song_version_id
              : OPAQUE_C4_KARAOKE_VERSION_ID,
          overall_score:
            typeof body.overall_score === "number" ? body.overall_score : 88,
          stars: typeof body.stars === "number" ? body.stars : 3,
        });
        state.karaokePracticeSessions.unshift(created);
        // Feed Adaptive Learning (F-15 x F-14)
        const existingModules = Array.isArray(
          state.parentAnalytics.module_activities,
        )
          ? (state.parentAnalytics.module_activities as Array<
              Record<string, unknown>
            >)
          : [];
        const kIdx = existingModules.findIndex((m) => m.game_key === "KARAOKE");
        const karaokeModule = {
          game_key: "KARAOKE",
          title_vi: "Karaoke thiếu nhi",
          sessions_count: state.karaokePracticeSessions.length,
          recent_average_pct: 88,
          highlight_vi: "Hoàn thành bài hát thiếu nhi đúng nhịp.",
        };
        if (kIdx >= 0) {
          existingModules[kIdx] = karaokeModule;
        } else {
          existingModules.push(karaokeModule);
        }
        state.parentAnalytics.module_activities = existingModules;
        state.parentAnalytics.karaoke_weak_segments = [
          {
            song_id: created.song_id,
            line_text: "bé bé",
            start_ms: 1000,
            end_ms: 1900,
            tip_vi: "Chú ý giữ nhịp ở câu thứ hai nhé.",
          },
        ];
        const skills = Array.isArray(state.parentAnalytics.skills)
          ? (state.parentAnalytics.skills as Array<Record<string, unknown>>)
          : [];
        const musicSkill = skills.find((s) => s.domain === "MUSIC_RHYTHM");
        if (musicSkill) {
          musicSkill.status = "OBSERVED";
          musicSkill.mastery_pct = 88;
          musicSkill.evidence_count =
            Number(musicSkill.evidence_count ?? 0) + 1;
        }
        return { status: 201, body: created };
      }
    }

    // -----------------------------------------------------------------------
    // F-16 AI Assistant & F-21 Health & F-22 Support
    // -----------------------------------------------------------------------
    if (ctx.method === "GET" && ctx.pathname === "/assistant/status") {
      return { status: 200, body: makeAssistantStatus() };
    }
    if (ctx.method === "GET" && ctx.pathname === "/assistant/context") {
      const currentPath =
        ctx.url.searchParams.get("current_path") ?? "/dashboard";
      return {
        status: 200,
        body: makeAssistantContext({ current_path: currentPath }),
      };
    }
    if (ctx.method === "POST" && ctx.pathname === "/assistant/chat") {
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const authHeader = ctx.headers.authorization ?? null;
      state.seenAssistantRequests.push({
        hasAuth: Boolean(authHeader),
        authorization: authHeader,
        localeHeader: ctx.headers["x-viread-locale"] ?? null,
        body,
      });

      if (state.assistantForceStatus && state.assistantForceStatus >= 400) {
        return {
          status: state.assistantForceStatus,
          headers:
            state.assistantForceStatus === 429
              ? { "Retry-After": "30" }
              : undefined,
          body: { detail: "ASSISTANT_FAULT" },
        };
      }

      if (
        typeof state.assistantRateLimitRemaining === "number" &&
        state.assistantRateLimitRemaining <= 0
      ) {
        return {
          status: 429,
          headers: { "Retry-After": "15" },
          body: { detail: "RATE_LIMITED" },
        };
      }
      if (typeof state.assistantRateLimitRemaining === "number") {
        state.assistantRateLimitRemaining -= 1;
      }

      const message =
        typeof body.message === "string" ? body.message : "Xin chào";
      const reqLocale = typeof body.locale === "string" ? body.locale : "vi";
      const isInactiveParent =
        callerRole === "parent" &&
        state.cluster1.deactivatedParentIds.includes(OPAQUE_PARENT_ID);

      const resolvedScope: "public" | "parent" | "admin" =
        !authHeader || callerRole === "guest" || isInactiveParent
          ? "public"
          : callerRole === "admin"
            ? "admin"
            : "parent";

      const quickActions =
        resolvedScope === "admin"
          ? [{ label: "Kho sách quản trị", href: "/admin/books" }]
          : resolvedScope === "parent"
            ? [{ label: "Mở tủ sách", href: "/books" }]
            : [{ label: "Đăng nhập", href: "/login" }];

      const replyPrefix =
        reqLocale === "ar"
          ? "مرحبًا! رد مساعد في ريد"
          : `Gợi ý (${resolvedScope})`;

      return {
        status: 200,
        body: makeAssistantChatReply({
          reply: `${replyPrefix}: ${message}`,
          role_scope: resolvedScope,
          quick_actions: quickActions,
        }),
      };
    }

    if (ctx.method === "GET" && ctx.pathname === "/system/admin/health") {
      return { status: 200, body: state.adminHealthSnapshot };
    }
    if (ctx.method === "GET" && ctx.pathname === "/system/admin/audit-logs") {
      return { status: 200, body: state.adminAuditLogs };
    }
    if (ctx.method === "POST" && ctx.pathname === "/support/feedback") {
      const body = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      state.supportSubmissions.push(body);
      return { status: 202, body: makeSupportFeedbackAccepted() };
    }

    // -----------------------------------------------------------------------
    // Delegate remaining routes to Cluster 1 -> Cluster 2 -> Cluster 3
    // -----------------------------------------------------------------------
    if (typeof cluster1Handler === "function") {
      const r1 = await cluster1Handler(ctx);
      if (r1) return r1;
    }
    if (typeof cluster2Handler === "function") {
      const r2 = await cluster2Handler(ctx);
      if (r2) return r2;
    }
    const r3 = await cluster3Handler(ctx);
    if (r3) return r3;

    return undefined;
  };
}
