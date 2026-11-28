import { expect, type Page } from "@playwright/test";

import {
  installApiMock,
  type ApiMockHandle,
  type ApiMockRequestContext,
  type ApiMockResponse,
  type ApiRouteHandler,
  type PageErrorCollector,
} from "./session";
import {
  OPAQUE_ADMIN_ID,
  OPAQUE_BOOK_ID,
  OPAQUE_CHILD_ID,
  OPAQUE_NOW_ISO,
  OPAQUE_PAGE_ID,
  OPAQUE_REPORT_ID,
  OPAQUE_REV_ID,
  OPAQUE_SESSION_ID,
  makeAdminHealthSnapshot,
  makeAssistantChatReply,
  makeAssistantContext,
  makeAssistantStatus,
  makeCatalogBook,
  makeCatalogPagePreview,
  makeChildProfile,
  makeHealthPayload,
  makeMinimalPngBuffer,
  makeMinimalWavBuffer,
  makeOpaqueUuid,
  makeParentProfile,
  makeReadingHistoryList,
  makeReadingSessionDetail,
  type AdminHealthSnapshotPayload,
  type HealthPayload,
} from "./test-data";

// ============================================================================
// Shared Cluster 3 & 4 Constants
// ============================================================================

export const OPAQUE_PAGE_2_ID = makeOpaqueUuid(12, "83000000");
export const OPAQUE_PAGE_3_ID = makeOpaqueUuid(13, "83000000");
export const OPAQUE_REV_2_ID = makeOpaqueUuid(12, "84000000");
export const OPAQUE_REV_3_ID = makeOpaqueUuid(13, "84000000");

export const OPAQUE_WORD_1_ID = makeOpaqueUuid(1, "87000000");
export const OPAQUE_WORD_2_ID = makeOpaqueUuid(2, "87000000");
export const OPAQUE_WORD_3_ID = makeOpaqueUuid(3, "87000000");
export const OPAQUE_WORD_4_ID = makeOpaqueUuid(4, "87000000");
export const OPAQUE_WORD_5_ID = makeOpaqueUuid(5, "87000000");
export const OPAQUE_WORD_6_ID = makeOpaqueUuid(6, "87000000");
export const OPAQUE_WORD_7_ID = makeOpaqueUuid(7, "87000000");
export const OPAQUE_WORD_8_ID = makeOpaqueUuid(8, "87000000");

export const OPAQUE_SCAN_JOB_ID = makeOpaqueUuid(1, "88100000");
export const OPAQUE_SCAN_JOB_2_ID = makeOpaqueUuid(2, "88100000");
export const OPAQUE_SCAN_REQUEST_ID = makeOpaqueUuid(3, "88100000");

export const OPAQUE_ALERT_ID = makeOpaqueUuid(1, "89000000");
export const OPAQUE_EPISODE_ID = makeOpaqueUuid(2, "89000000");
export const OPAQUE_FOREIGN_ALERT_ID = makeOpaqueUuid(99, "89000000");
export const OPAQUE_FOREIGN_SESSION_ID = makeOpaqueUuid(99, "72000000");

export const OPAQUE_PRIVATE_BOOK_ID = makeOpaqueUuid(20, "82000000");

export const OPAQUE_VOICE_NORTH_ID = "local_north_truc_ly";
export const OPAQUE_VOICE_NORTH_MALE_ID = "local_north_minh_quan";
export const OPAQUE_VOICE_CENTRAL_ID = "local_central_ngoc_tran";
export const OPAQUE_VOICE_SOUTH_ID = "local_south_thuc_doan";
export const OPAQUE_TTS_MODEL_VERSION = "vieneu-v3-turbo-onnx-fp32-3.8.5";

// ============================================================================
// Cluster 3: F-07..F-10 DTO Factories (Zod v4 Contract-Compliant)
// ============================================================================

export interface ReadingSessionCreateResponsePayload {
  Id: string;
  State: "IN_PROGRESS";
  SelectedPageId: string;
  SelectedPageRevisionId: string;
  StartedAt: string;
}

export function makeReadingSessionCreateResponse(
  overrides: Partial<ReadingSessionCreateResponsePayload> = {},
): ReadingSessionCreateResponsePayload {
  return {
    Id: OPAQUE_SESSION_ID,
    State: "IN_PROGRESS",
    SelectedPageId: OPAQUE_PAGE_ID,
    SelectedPageRevisionId: OPAQUE_REV_ID,
    StartedAt: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export interface ReadingSessionSummaryPayload {
  id: string;
  child_id: string;
  book_id: string;
  state:
    | "CREATED"
    | "PAGE_READY"
    | "LISTENING"
    | "PAUSED"
    | "RECONNECTING"
    | "QUESTIONING"
    | "FINISHED"
    | "ABORTED";
  started_at: string;
  ended_at?: string | null;
  duration_ms?: number | null;
}

export function makeReadingSessionSummary(
  overrides: Partial<ReadingSessionSummaryPayload> = {},
): ReadingSessionSummaryPayload {
  return {
    id: OPAQUE_SESSION_ID,
    child_id: OPAQUE_CHILD_ID,
    book_id: OPAQUE_BOOK_ID,
    state: "PAGE_READY",
    started_at: OPAQUE_NOW_ISO,
    ended_at: null,
    duration_ms: null,
    ...overrides,
  };
}

export interface ReadingWordDtoPayload {
  word_id: string;
  word_index: number;
  text: string;
  bbox: [number, number, number, number];
  line_index?: number;
}

export interface ReadingPageDtoPayload {
  page_id: string;
  page_revision_id: string;
  page_number: number;
  confidence: number | null;
  width: number;
  height: number;
  image_url?: string | null;
  tts_audio_url?: string | null;
  tts_word_timings?: Array<{
    index: number;
    start: number;
    end: number;
  }> | null;
  tts_voice_id?: string | null;
  tts_cached_speed?: number | null;
  image_overlay_safe?: boolean;
  illustration_url?: string | null;
  illustration_text_free?: boolean;
  text?: string;
  words: ReadingWordDtoPayload[];
  paragraph_start_line_indices?: number[];
  indented_line_indices?: number[];
}

export function makeReadingPageDto(
  overrides: Partial<ReadingPageDtoPayload> = {},
): ReadingPageDtoPayload {
  const defaultWords: ReadingWordDtoPayload[] = [
    {
      word_id: OPAQUE_WORD_1_ID,
      word_index: 0,
      text: "mốt",
      bbox: [40, 80, 120, 125],
      line_index: 0,
    },
    {
      word_id: OPAQUE_WORD_2_ID,
      word_index: 1,
      text: "Mèo",
      bbox: [132, 80, 212, 125],
      line_index: 0,
    },
    {
      word_id: OPAQUE_WORD_3_ID,
      word_index: 2,
      text: "con",
      bbox: [224, 80, 296, 125],
      line_index: 0,
    },
    {
      word_id: OPAQUE_WORD_4_ID,
      word_index: 3,
      text: "đi",
      bbox: [308, 80, 360, 125],
      line_index: 0,
    },
  ];
  return {
    page_id: OPAQUE_PAGE_ID,
    page_revision_id: OPAQUE_REV_ID,
    page_number: 1,
    confidence: 0.96,
    width: 800,
    height: 1100,
    image_url: null,
    tts_audio_url: null,
    tts_word_timings: null,
    tts_voice_id: null,
    tts_cached_speed: null,
    image_overlay_safe: true,
    illustration_url: null,
    illustration_text_free: false,
    text: "mốt Mèo con đi",
    words: defaultWords,
    paragraph_start_line_indices: [0],
    indented_line_indices: [],
    ...overrides,
  };
}

export function makeReadingPage2Dto(
  overrides: Partial<ReadingPageDtoPayload> = {},
): ReadingPageDtoPayload {
  return makeReadingPageDto({
    page_id: OPAQUE_PAGE_2_ID,
    page_revision_id: OPAQUE_REV_2_ID,
    page_number: 2,
    text: "Trời nắng đẹp quá",
    words: [
      {
        word_id: OPAQUE_WORD_5_ID,
        word_index: 0,
        text: "Trời",
        bbox: [40, 80, 120, 125],
        line_index: 0,
      },
      {
        word_id: OPAQUE_WORD_6_ID,
        word_index: 1,
        text: "nắng",
        bbox: [132, 80, 224, 125],
        line_index: 0,
      },
      {
        word_id: OPAQUE_WORD_7_ID,
        word_index: 2,
        text: "đẹp",
        bbox: [236, 80, 312, 125],
        line_index: 0,
      },
      {
        word_id: OPAQUE_WORD_8_ID,
        word_index: 3,
        text: "quá",
        bbox: [324, 80, 398, 125],
        line_index: 0,
      },
    ],
    ...overrides,
  });
}

export interface ReadingSessionProgressPagePayload {
  page_id: string;
  page_revision_id: string;
  page_number: number;
  page_order: number;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED";
  started_at: string | null;
  completed_at: string | null;
}

export interface ReadingSessionProgressPayload {
  session_id: string;
  persisted: boolean;
  start_page_id: string;
  end_page_id: string;
  current_page_id: string;
  start_page_number: number;
  end_page_number: number;
  current_page_number: number;
  current_index: number;
  total_pages: number;
  completed_pages: number;
  pages: ReadingSessionProgressPagePayload[];
}

export function makeReadingSessionProgress(
  overrides: Partial<ReadingSessionProgressPayload> = {},
): ReadingSessionProgressPayload {
  return {
    session_id: OPAQUE_SESSION_ID,
    persisted: true,
    start_page_id: OPAQUE_PAGE_ID,
    end_page_id: OPAQUE_PAGE_2_ID,
    current_page_id: OPAQUE_PAGE_ID,
    start_page_number: 1,
    end_page_number: 2,
    current_page_number: 1,
    current_index: 0,
    total_pages: 2,
    completed_pages: 0,
    pages: [
      {
        page_id: OPAQUE_PAGE_ID,
        page_revision_id: OPAQUE_REV_ID,
        page_number: 1,
        page_order: 0,
        status: "IN_PROGRESS",
        started_at: OPAQUE_NOW_ISO,
        completed_at: null,
      },
      {
        page_id: OPAQUE_PAGE_2_ID,
        page_revision_id: OPAQUE_REV_2_ID,
        page_number: 2,
        page_order: 1,
        status: "PENDING",
        started_at: null,
        completed_at: null,
      },
    ],
    ...overrides,
  };
}

export interface ReadingCompletionSummaryPayload {
  assessment?: null;
  duration_minutes: number | null;
  pages_explored: number | null;
  selected_range_pages?: number | null;
  practiced_words: number | null;
  spoken_words?: string[] | null;
  transcripts?: string[] | null;
  correct_words?: string[] | null;
  mispronounced_words?: string[] | null;
  skipped_words?: string[] | null;
  score?: number | null;
}

export function makeReadingCompletionSummary(
  overrides: Partial<ReadingCompletionSummaryPayload> = {},
): ReadingCompletionSummaryPayload {
  return {
    assessment: null,
    duration_minutes: 4,
    pages_explored: 2,
    selected_range_pages: 2,
    practiced_words: 4,
    spoken_words: ["mốt", "Mèo", "con", "đi"],
    transcripts: ["mốt Mèo con đi"],
    correct_words: ["mốt", "Mèo", "con", "đi"],
    mispronounced_words: [],
    skipped_words: [],
    score: 100,
    ...overrides,
  };
}

export interface ReadingPracticeStatePayload {
  session_id: string;
  legacy_evidence_present: boolean;
  pages: never[];
  words: never[];
}

export function makeReadingPracticeState(
  sessionId = OPAQUE_SESSION_ID,
): ReadingPracticeStatePayload {
  return {
    session_id: sessionId,
    legacy_evidence_present: false,
    pages: [],
    words: [],
  };
}

export interface SessionReportsPayload {
  assessment: null;
  session_id: string;
  total: number;
  reports: never[];
}

export function makeSessionReportsResponse(
  sessionId = OPAQUE_SESSION_ID,
): SessionReportsPayload {
  return {
    assessment: null,
    session_id: sessionId,
    total: 0,
    reports: [],
  };
}

export interface TutorGeneratePayload {
  session_id: string;
  total: number;
  source: "AI" | "RULE_BASED" | null;
  created: boolean;
}

export function makeTutorGenerateResponse(
  sessionId = OPAQUE_SESSION_ID,
): TutorGeneratePayload {
  return {
    session_id: sessionId,
    total: 0,
    source: null,
    created: false,
  };
}

export interface PresenceSettingsPayload {
  email_enabled: boolean;
}

export function makePresenceSettings(
  emailEnabled = false,
): PresenceSettingsPayload {
  return { email_enabled: emailEnabled };
}

export interface PresenceAlertPayload {
  id: string;
  session_id: string;
  episode_id: string;
  status: "PENDING" | "SENDING" | "SENT" | "CANCELLED" | "EXPIRED" | "FAILED";
  due_at: string;
  expires_at: string;
  cancel_reason: string | null;
}

export function makePresenceAlert(
  overrides: Partial<PresenceAlertPayload> = {},
): PresenceAlertPayload {
  return {
    id: OPAQUE_ALERT_ID,
    session_id: OPAQUE_SESSION_ID,
    episode_id: OPAQUE_EPISODE_ID,
    status: "PENDING",
    due_at: "2026-11-21T10:02:00Z",
    expires_at: "2026-11-21T10:15:00Z",
    cancel_reason: null,
    ...overrides,
  };
}

export interface CameraPageMatchPayload {
  framing_valid: boolean;
  matched: boolean;
  book_id?: string | null;
  status_code:
    | "INVALID_IMAGE"
    | "TOO_DARK"
    | "TOO_BLURRY"
    | "OUT_OF_FRAME"
    | "FRAME_OK"
    | "MATCHED"
    | "LOW_CONFIDENCE";
  message: string;
  confidence: number;
  matched_page: ReadingPageDtoPayload | null;
}

export function makeCameraPageMatchResponse(
  overrides: Partial<CameraPageMatchPayload> = {},
): CameraPageMatchPayload {
  return {
    framing_valid: true,
    matched: true,
    book_id: OPAQUE_BOOK_ID,
    status_code: "MATCHED",
    message: "Đã nhận diện Trang 1.",
    confidence: 0.94,
    matched_page: makeReadingPageDto(),
    ...overrides,
  };
}

export interface LocalOcrPageScanPayload {
  scan_job_id: string;
  request_id: string;
  idempotency_key: string | null;
  status: "SUCCEEDED";
  ocr_text: string;
  word_count: number;
  words: Array<{
    word_index: number;
    line_index: number;
    text: string;
    normalized_text: string;
    bbox: [number, number, number, number];
    ocr_confidence: number | null;
  }>;
  provenance: {
    engine: string;
    device: "cuda" | "cpu" | "unknown";
    engine_statuses: Record<string, string>;
    model_profile: string | null;
    checkpoint_sha256: string | null;
    model_load_status: string | null;
    cloud_ocr_used: boolean;
    elapsed_ms: number;
  };
  matched: boolean;
  matched_book_id: string | null;
  matched_book_title: string | null;
  match_confidence: number;
  matched_page: ReadingPageDtoPayload | null;
  message: string;
}

export function makeLocalOcrPageScan(
  overrides: Partial<LocalOcrPageScanPayload> = {},
): LocalOcrPageScanPayload {
  return {
    scan_job_id: OPAQUE_SCAN_JOB_ID,
    request_id: OPAQUE_SCAN_REQUEST_ID,
    idempotency_key: null,
    status: "SUCCEEDED",
    ocr_text: "mốt Mèo con đi",
    word_count: 4,
    words: [
      {
        word_index: 0,
        line_index: 0,
        text: "mốt",
        normalized_text: "mốt",
        bbox: [40, 80, 120, 125],
        ocr_confidence: 0.97,
      },
      {
        word_index: 1,
        line_index: 0,
        text: "Mèo",
        normalized_text: "Mèo",
        bbox: [132, 80, 212, 125],
        ocr_confidence: 0.96,
      },
      {
        word_index: 2,
        line_index: 0,
        text: "con",
        normalized_text: "con",
        bbox: [224, 80, 296, 125],
        ocr_confidence: 0.98,
      },
      {
        word_index: 3,
        line_index: 0,
        text: "đi",
        normalized_text: "đi",
        bbox: [308, 80, 360, 125],
        ocr_confidence: 0.95,
      },
    ],
    provenance: {
      engine: "paddleocr+vietocr",
      device: "cpu",
      engine_statuses: { paddleocr: "ready", vietocr: "ready" },
      model_profile: "vietocr-v2",
      checkpoint_sha256: null,
      model_load_status: "loaded",
      cloud_ocr_used: false,
      elapsed_ms: 140,
    },
    matched: true,
    matched_book_id: OPAQUE_BOOK_ID,
    matched_book_title: "Chú Mèo Đi Hia",
    match_confidence: 0.95,
    matched_page: makeReadingPageDto(),
    message: "Đã nhận diện và khớp Trang 1.",
    ...overrides,
  };
}

export interface LocalOcrScanJobPayload {
  job_id: string;
  status:
    | "QUEUED"
    | "CLAIMED"
    | "RUNNING"
    | "FAILED_RETRYABLE"
    | "SUCCEEDED"
    | "DEAD_LETTER"
    | "CANCELLED";
  worker_online: boolean;
  created_at: string;
  updated_at: string;
  file_name: string | null;
  queue_position: number | null;
  error_code: string | null;
  error_message: string | null;
  result: LocalOcrPageScanPayload | null;
}

export function makeLocalOcrScanJob(
  overrides: Partial<LocalOcrScanJobPayload> = {},
): LocalOcrScanJobPayload {
  return {
    job_id: OPAQUE_SCAN_JOB_ID,
    status: "SUCCEEDED",
    worker_online: true,
    created_at: OPAQUE_NOW_ISO,
    updated_at: OPAQUE_NOW_ISO,
    file_name: "page-1.png",
    queue_position: null,
    error_code: null,
    error_message: null,
    result: makeLocalOcrPageScan(),
    ...overrides,
  };
}

export interface VoiceStatusPayload {
  default_mode: "local_only" | "local_with_google_fallback";
  default_voice_id: string;
  local: {
    configured?: boolean;
    mode?: string;
    available: boolean;
    stt_ready: boolean;
    tts_ready: boolean;
    error_code?: string | null;
    stt_error_code?: string | null;
    tts_error_code?: string | null;
    stt_model_version?: string | null;
    tts_model_version?: string | null;
  };
  google: {
    stt_configured: boolean;
    tts_configured: boolean;
    stt_cooldown: boolean;
    tts_cooldown: boolean;
  };
}

export function makeVoiceStatusPayload(
  overrides: Partial<VoiceStatusPayload> = {},
): VoiceStatusPayload {
  return {
    default_mode: "local_only",
    default_voice_id: OPAQUE_VOICE_NORTH_ID,
    local: {
      configured: true,
      mode: "http",
      available: true,
      stt_ready: true,
      tts_ready: true,
      error_code: null,
      stt_error_code: null,
      tts_error_code: null,
      stt_model_version: "sherpa-zipformer-vi-1.0",
      tts_model_version: OPAQUE_TTS_MODEL_VERSION,
    },
    google: {
      stt_configured: true,
      tts_configured: true,
      stt_cooldown: false,
      tts_cooldown: false,
    },
    ...overrides,
  };
}

export interface VoiceOptionPayload {
  voice_id: string;
  name: string;
  provider?: string | null;
  region?: string | null;
  region_label?: string | null;
  model_version?: string | null;
  category?: string | null;
  gender?: string | null;
  accent?: string | null;
  age?: string | null;
  use_case?: string | null;
  description?: string | null;
  preview_url?: string | null;
  is_default?: boolean;
}

export interface VoiceListPayload {
  voices: VoiceOptionPayload[];
  default_voice_id: string;
  local_worker_ready?: boolean;
  google_tts_available?: boolean;
  cached_voice_ids?: string[];
}

export function makeVoiceListPayload(
  overrides: Partial<VoiceListPayload> = {},
): VoiceListPayload {
  return {
    voices: [
      {
        voice_id: OPAQUE_VOICE_NORTH_ID,
        name: "Trúc Ly - Giọng đọc chuẩn miền Bắc",
        provider: "local",
        region: "north",
        region_label: "Miền Bắc",
        model_version: OPAQUE_TTS_MODEL_VERSION,
        gender: "female",
        accent: "northern",
        age: "young",
        is_default: true,
      },
      {
        voice_id: OPAQUE_VOICE_NORTH_MALE_ID,
        name: "Minh Quân - Giọng nam miền Bắc",
        provider: "local",
        region: "north",
        region_label: "Miền Bắc",
        model_version: OPAQUE_TTS_MODEL_VERSION,
        gender: "male",
        accent: "northern",
        age: "young",
        is_default: false,
      },
      {
        voice_id: OPAQUE_VOICE_CENTRAL_ID,
        name: "Ngọc Trân - Giọng đọc miền Trung",
        provider: "local",
        region: "central",
        region_label: "Miền Trung",
        model_version: OPAQUE_TTS_MODEL_VERSION,
        gender: "female",
        accent: "central",
        age: "young",
        is_default: false,
      },
      {
        voice_id: OPAQUE_VOICE_SOUTH_ID,
        name: "Thục Đoan - Giọng đọc miền Nam",
        provider: "local",
        region: "south",
        region_label: "Miền Nam",
        model_version: OPAQUE_TTS_MODEL_VERSION,
        gender: "female",
        accent: "southern",
        age: "young",
        is_default: false,
      },
    ],
    default_voice_id: OPAQUE_VOICE_NORTH_ID,
    local_worker_ready: true,
    google_tts_available: true,
    cached_voice_ids: [OPAQUE_VOICE_NORTH_ID],
    ...overrides,
  };
}

export interface TimedSpeechPayload {
  audio_base64: string;
  content_type: string;
  duration_seconds: number;
  words: Array<{ index: number; start: number; end: number }>;
  provider?: string;
  resolved_voice_id?: string | null;
  region?: string | null;
  model_version?: string | null;
  used_fallback_voice?: boolean;
  cached_speed?: number | null;
}

export function makeTimedSpeechPayload(
  words: readonly string[],
  overrides: Partial<TimedSpeechPayload> = {},
): TimedSpeechPayload {
  const stepDuration = 0.12;
  const durationSeconds = Math.max(0.25, words.length * stepDuration);
  const timings = words.map((_, index) => ({
    index,
    start: Number((index * stepDuration).toFixed(3)),
    end: Number(((index + 1) * stepDuration).toFixed(3)),
  }));
  return {
    audio_base64: makeMinimalWavBuffer(280).toString("base64"),
    content_type: "audio/wav",
    duration_seconds: durationSeconds,
    words: timings,
    provider: "local",
    resolved_voice_id: OPAQUE_VOICE_NORTH_ID,
    region: "north",
    model_version: OPAQUE_TTS_MODEL_VERSION,
    used_fallback_voice: false,
    cached_speed: 1.0,
    ...overrides,
  };
}

export interface PhonicsSpeechPayload {
  audio_base64: string;
  content_type: string;
  duration_seconds: number;
  step_timings: Array<{
    id: string;
    index: number;
    start: number;
    end: number;
  }>;
  provider?: string;
  resolved_voice_id: string;
  region?: string;
  model_version: string;
  cached_speed?: number | null;
}

export function makePhonicsSpeechPayload(
  steps: readonly { readonly id: string }[],
  overrides: Partial<PhonicsSpeechPayload> = {},
): PhonicsSpeechPayload {
  const stepDuration = 0.14;
  const durationSeconds = Math.max(0.4, steps.length * stepDuration);
  return {
    audio_base64: makeMinimalWavBuffer(320).toString("base64"),
    content_type: "audio/wav",
    duration_seconds: durationSeconds,
    step_timings: steps.map((step, index) => ({
      id: step.id,
      index,
      start: Number((index * stepDuration).toFixed(3)),
      end: Number(((index + 1) * stepDuration).toFixed(3)),
    })),
    provider: "local",
    resolved_voice_id: OPAQUE_VOICE_NORTH_ID,
    region: "north",
    model_version: OPAQUE_TTS_MODEL_VERSION,
    cached_speed: 1.0,
    ...overrides,
  };
}

export interface SttTranscriptionPayload {
  text: string;
  language_code: string | null;
  language_probability: number | null;
  words: Array<{
    text: string;
    start: number;
    end: number;
    type?: string;
    logprob?: number | null;
  }> | null;
}

export function makeSttTranscriptionPayload(
  text = "mốt Mèo con đi",
  overrides: Partial<SttTranscriptionPayload> = {},
): SttTranscriptionPayload {
  const tokens = text.split(/\s+/u).filter(Boolean);
  return {
    text,
    language_code: "vi-VN",
    language_probability: 0.98,
    words: tokens.map((token, index) => ({
      text: token,
      start: Number((index * 0.25).toFixed(2)),
      end: Number(((index + 1) * 0.25).toFixed(2)),
      type: "word",
      logprob: -0.1,
    })),
    ...overrides,
  };
}

// ============================================================================
// Cluster 3: Default Route Handlers & Single-Call Mock Installer
// ============================================================================

export interface Cluster3HandlerState {
  healthPayload?: HealthPayload;
  sessionSummary?: Partial<ReadingSessionSummaryPayload>;
  page1?: ReadingPageDtoPayload;
  page2?: ReadingPageDtoPayload;
  currentPageNumber?: 1 | 2;
  completedPageIds?: string[];
  completionSummary?: Partial<ReadingCompletionSummaryPayload>;
  presenceEmailEnabled?: boolean;
  presenceAlertsById?: Record<string, PresenceAlertPayload>;
  presenceAlertsByEpisode?: Record<string, PresenceAlertPayload>;
  scanJobs?: LocalOcrScanJobPayload[];
  voiceStatus?: VoiceStatusPayload;
  voiceList?: VoiceListPayload;
  sessionVoiceLock?: { session_id: string; voice_id: string } | null;
  ttsCacheCounts?: Record<string, number>;
  onRequest?: (ctx: ApiMockRequestContext) => void;
  overrides?: Record<string, ApiRouteHandler>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function buildProgressFromState(
  sessionId: string,
  state: Cluster3HandlerState,
): ReadingSessionProgressPayload {
  const page1 = state.page1 ?? makeReadingPageDto();
  const page2 = state.page2 ?? makeReadingPage2Dto();
  const completed = new Set(state.completedPageIds ?? []);
  const currentNum = state.currentPageNumber ?? 1;
  const currentPage = currentNum === 2 ? page2 : page1;
  return makeReadingSessionProgress({
    session_id: sessionId,
    start_page_id: page1.page_id,
    end_page_id: page2.page_id,
    current_page_id: currentPage.page_id,
    start_page_number: page1.page_number,
    end_page_number: page2.page_number,
    current_page_number: currentPage.page_number,
    current_index: currentNum === 2 ? 1 : 0,
    total_pages: 2,
    completed_pages: completed.size,
    pages: [
      {
        page_id: page1.page_id,
        page_revision_id: page1.page_revision_id,
        page_number: page1.page_number,
        page_order: 0,
        status: completed.has(page1.page_id)
          ? "COMPLETED"
          : currentNum === 1
            ? "IN_PROGRESS"
            : "PENDING",
        started_at: OPAQUE_NOW_ISO,
        completed_at: completed.has(page1.page_id) ? OPAQUE_NOW_ISO : null,
      },
      {
        page_id: page2.page_id,
        page_revision_id: page2.page_revision_id,
        page_number: page2.page_number,
        page_order: 1,
        status: completed.has(page2.page_id)
          ? "COMPLETED"
          : currentNum === 2
            ? "IN_PROGRESS"
            : "PENDING",
        started_at: currentNum === 2 ? OPAQUE_NOW_ISO : null,
        completed_at: completed.has(page2.page_id) ? OPAQUE_NOW_ISO : null,
      },
    ],
  });
}

async function resolveOverride(
  entry: ApiRouteHandler | undefined,
  ctx: ApiMockRequestContext,
): Promise<ApiMockResponse | null | undefined> {
  if (!entry) return undefined;
  return typeof entry === "function" ? await entry(ctx) : entry;
}

export function makeCluster3DefaultHandlers(
  initialState: Cluster3HandlerState = {},
): (ctx: ApiMockRequestContext) => Promise<ApiMockResponse | null | undefined> {
  const state: Cluster3HandlerState = {
    currentPageNumber: 1,
    completedPageIds: [],
    presenceEmailEnabled: false,
    presenceAlertsById: {},
    presenceAlertsByEpisode: {},
    scanJobs: [],
    ttsCacheCounts: {},
    ...initialState,
  };

  return async (
    ctx: ApiMockRequestContext,
  ): Promise<ApiMockResponse | null | undefined> => {
    state.onRequest?.(ctx);
    const key = `${ctx.method} ${ctx.pathname}`;
    const override =
      state.overrides?.[key] ?? state.overrides?.[ctx.pathname] ?? undefined;
    if (override) {
      const resolved = await resolveOverride(override, ctx);
      if (resolved) return resolved;
    }

    // --- Core / Profile / Book Routes ---
    if (ctx.method === "GET" && ctx.pathname === "/health") {
      return { status: 200, body: state.healthPayload ?? makeHealthPayload() };
    }
    if (ctx.method === "GET" && ctx.pathname === "/profiles/me") {
      return { status: 200, body: makeParentProfile() };
    }
    if (ctx.method === "GET" && ctx.pathname === "/profiles/children") {
      return { status: 200, body: [makeChildProfile()] };
    }
    if (
      ctx.method === "GET" &&
      ctx.pathname.startsWith("/profiles/children/")
    ) {
      const childId = decodeURIComponent(
        ctx.pathname.slice("/profiles/children/".length),
      );
      return { status: 200, body: makeChildProfile({ id: childId }) };
    }
    if (
      ctx.method === "GET" &&
      ctx.pathname === `/books/catalog/${OPAQUE_BOOK_ID}/preview`
    ) {
      const page1 = state.page1 ?? makeReadingPageDto();
      const page2 = state.page2 ?? makeReadingPage2Dto();
      return {
        status: 200,
        body: [
          makeCatalogPagePreview({
            page_id: page1.page_id,
            page_number: page1.page_number,
            current_verified_revision_id: page1.page_revision_id,
          }),
          makeCatalogPagePreview({
            page_id: page2.page_id,
            page_number: page2.page_number,
            current_verified_revision_id: page2.page_revision_id,
            preview_url:
              "https://example.supabase.co/storage/v1/object/public/book-pages/page-2.png",
          }),
        ],
      };
    }
    if (ctx.method === "GET" && ctx.pathname.startsWith("/books/catalog/")) {
      const bookId = decodeURIComponent(
        ctx.pathname.slice("/books/catalog/".length),
      );
      if (bookId === OPAQUE_PRIVATE_BOOK_ID) {
        return {
          status: 200,
          body: makeCatalogBook({
            id: OPAQUE_PRIVATE_BOOK_ID,
            visibility_scope: "PARENT_PRIVATE",
            title: "Sách riêng của bé",
          }),
        };
      }
      return { status: 200, body: makeCatalogBook({ id: bookId }) };
    }

    // --- F-07: Reading Session Routes ---
    if (ctx.method === "POST" && ctx.pathname === "/reading/sessions") {
      const payload = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const selectedPageId =
        typeof payload.selected_page_id === "string"
          ? payload.selected_page_id
          : OPAQUE_PAGE_ID;
      const selectedRevisionId =
        typeof payload.selected_page_revision_id === "string"
          ? payload.selected_page_revision_id
          : OPAQUE_REV_ID;
      return {
        status: 201,
        body: makeReadingSessionCreateResponse({
          SelectedPageId: selectedPageId,
          SelectedPageRevisionId: selectedRevisionId,
        }),
      };
    }

    const sessionMatch = ctx.pathname.match(
      /^\/reading\/sessions\/([^/]+)(?:\/(.*))?$/,
    );
    if (sessionMatch) {
      const sessionId = decodeURIComponent(
        sessionMatch[1] ?? OPAQUE_SESSION_ID,
      );
      const rest = sessionMatch[2] ?? "";

      if (ctx.method === "GET" && rest === "") {
        return {
          status: 200,
          body: makeReadingSessionSummary({
            id: sessionId,
            ...(state.sessionSummary ?? {}),
          }),
        };
      }
      if (ctx.method === "GET" && rest === "page") {
        const page1 = state.page1 ?? makeReadingPageDto();
        const page2 = state.page2 ?? makeReadingPage2Dto();
        return {
          status: 200,
          body: state.currentPageNumber === 2 ? page2 : page1,
        };
      }
      if (ctx.method === "GET" && rest === "progress") {
        return {
          status: 200,
          body: buildProgressFromState(sessionId, state),
        };
      }
      if (ctx.method === "POST" && rest === "navigate") {
        const payload = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
        const targetId =
          typeof payload.target_page_id === "string"
            ? payload.target_page_id
            : "";
        const page1 = state.page1 ?? makeReadingPageDto();
        const page2 = state.page2 ?? makeReadingPage2Dto();
        if (targetId === page2.page_id) {
          state.currentPageNumber = 2;
        } else if (targetId === page1.page_id) {
          state.currentPageNumber = 1;
        }
        return {
          status: 200,
          body: buildProgressFromState(sessionId, state),
        };
      }
      const completeMatch = rest.match(/^pages\/([^/]+)\/complete$/);
      if (ctx.method === "POST" && completeMatch) {
        const pageId = decodeURIComponent(completeMatch[1] ?? "");
        const completed = new Set(state.completedPageIds ?? []);
        completed.add(pageId);
        state.completedPageIds = [...completed];
        return {
          status: 200,
          body: buildProgressFromState(sessionId, state),
        };
      }
      if (ctx.method === "GET" && rest === "completion-summary") {
        return {
          status: 200,
          body: makeReadingCompletionSummary(state.completionSummary),
        };
      }
      if (ctx.method === "GET" && rest === "practice-state") {
        return {
          status: 200,
          body: makeReadingPracticeState(sessionId),
        };
      }
      if (ctx.method === "POST" && rest === "finish") {
        return {
          status: 200,
          body: makeReadingSessionSummary({
            id: sessionId,
            state: "FINISHED",
            ended_at: OPAQUE_NOW_ISO,
            duration_ms: 120_000,
          }),
        };
      }
      if (ctx.method === "GET" && rest === "reports") {
        return {
          status: 200,
          body: makeSessionReportsResponse(sessionId),
        };
      }
    }

    if (ctx.method === "POST" && ctx.pathname === "/reading/events") {
      const payload = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      return {
        status: 201,
        body: {
          Id: makeOpaqueUuid(50, "87100000"),
          SessionId:
            typeof payload.SessionId === "string"
              ? payload.SessionId
              : OPAQUE_SESSION_ID,
          PageId:
            typeof payload.PageId === "string"
              ? payload.PageId
              : OPAQUE_PAGE_ID,
          PageRevisionId:
            typeof payload.PageRevisionId === "string"
              ? payload.PageRevisionId
              : OPAQUE_REV_ID,
          WordId: typeof payload.WordId === "string" ? payload.WordId : null,
          Type: typeof payload.Type === "string" ? payload.Type : "WORD_RETRY",
          StartMs: typeof payload.StartMs === "number" ? payload.StartMs : 0,
          EndMs: typeof payload.EndMs === "number" ? payload.EndMs : null,
          Confidence: null,
          Status:
            typeof payload.Status === "string" ? payload.Status : "CONFIRMED",
          Metadata: isRecord(payload.Metadata) ? payload.Metadata : {},
          CreatedAt: OPAQUE_NOW_ISO,
        },
      };
    }

    const tutorGenMatch = ctx.pathname.match(
      /^\/tutor\/sessions\/([^/]+)\/questions\/generate$/,
    );
    if (ctx.method === "POST" && tutorGenMatch) {
      const sessionId = decodeURIComponent(
        tutorGenMatch[1] ?? OPAQUE_SESSION_ID,
      );
      return { status: 200, body: makeTutorGenerateResponse(sessionId) };
    }

    // --- F-08: Reading Presence Routes ---
    if (ctx.method === "GET" && ctx.pathname === "/reading-presence/settings") {
      return {
        status: 200,
        body: makePresenceSettings(Boolean(state.presenceEmailEnabled)),
      };
    }
    if (ctx.method === "PUT" && ctx.pathname === "/reading-presence/settings") {
      const payload = ctx.postDataJson;
      if (!isRecord(payload) || typeof payload.email_enabled !== "boolean") {
        return {
          status: 422,
          body: { detail: [{ msg: "email_enabled boolean required" }] },
        };
      }
      const allowedKeys = new Set(["email_enabled"]);
      const extraKeys = Object.keys(payload).filter((k) => !allowedKeys.has(k));
      if (extraKeys.length > 0) {
        return {
          status: 422,
          body: {
            detail: extraKeys.map((field) => ({
              type: "extra_forbidden",
              loc: ["body", field],
              msg: "Extra inputs are not permitted",
            })),
          },
        };
      }
      state.presenceEmailEnabled = payload.email_enabled;
      return {
        status: 200,
        body: makePresenceSettings(state.presenceEmailEnabled),
      };
    }
    if (ctx.method === "POST" && ctx.pathname === "/reading-presence/alerts") {
      const payload = ctx.postDataJson;
      if (
        !isRecord(payload) ||
        typeof payload.session_id !== "string" ||
        !UUID_RE.test(payload.session_id) ||
        typeof payload.episode_id !== "string" ||
        !UUID_RE.test(payload.episode_id)
      ) {
        return {
          status: 422,
          body: {
            detail: [{ msg: "session_id and episode_id UUIDs required" }],
          },
        };
      }
      const allowedKeys = new Set(["session_id", "episode_id"]);
      const extraKeys = Object.keys(payload).filter((k) => !allowedKeys.has(k));
      if (extraKeys.length > 0) {
        return {
          status: 422,
          body: {
            detail: extraKeys.map((field) => ({
              type: "extra_forbidden",
              loc: ["body", field],
              msg: "Extra inputs are not permitted",
            })),
          },
        };
      }
      if (!state.presenceEmailEnabled) {
        return {
          status: 409,
          body: { detail: { code: "PRESENCE_ALERT_DISABLED" } },
        };
      }
      if (payload.session_id === OPAQUE_FOREIGN_SESSION_ID) {
        return { status: 404, body: { detail: "Resource not found" } };
      }
      const epKey = `${payload.session_id}:${payload.episode_id}`;
      const existing = state.presenceAlertsByEpisode?.[epKey];
      if (existing) {
        return { status: 201, body: existing };
      }
      const created = makePresenceAlert({
        id: OPAQUE_ALERT_ID,
        session_id: payload.session_id,
        episode_id: payload.episode_id,
        status: "PENDING",
      });
      if (state.presenceAlertsById) {
        state.presenceAlertsById[created.id] = created;
      }
      if (state.presenceAlertsByEpisode) {
        state.presenceAlertsByEpisode[epKey] = created;
      }
      return { status: 201, body: created };
    }
    const alertConfirmMatch = ctx.pathname.match(
      /^\/reading-presence\/alerts\/([^/]+)\/confirm$/,
    );
    if (ctx.method === "POST" && alertConfirmMatch) {
      const alertId = decodeURIComponent(alertConfirmMatch[1] ?? "");
      if (alertId === OPAQUE_FOREIGN_ALERT_ID) {
        return { status: 404, body: { detail: "Resource not found" } };
      }
      const alert =
        state.presenceAlertsById?.[alertId] ??
        makePresenceAlert({ id: alertId });
      return { status: 200, body: alert };
    }
    const alertCancelMatch = ctx.pathname.match(
      /^\/reading-presence\/alerts\/([^/]+)\/cancel$/,
    );
    if (ctx.method === "POST" && alertCancelMatch) {
      const alertId = decodeURIComponent(alertCancelMatch[1] ?? "");
      if (alertId === OPAQUE_FOREIGN_ALERT_ID) {
        return { status: 404, body: { detail: "Resource not found" } };
      }
      const payload = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const reason =
        typeof payload.reason === "string" ? payload.reason : "RETURNED";
      const existing =
        state.presenceAlertsById?.[alertId] ??
        makePresenceAlert({ id: alertId });
      const cancelled: PresenceAlertPayload = {
        ...existing,
        status: "CANCELLED",
        cancel_reason: reason,
      };
      if (state.presenceAlertsById) {
        state.presenceAlertsById[alertId] = cancelled;
      }
      return { status: 200, body: cancelled };
    }

    // --- F-09: Camera Page Match & Local OCR Scan Routes ---
    if (
      ctx.method === "GET" &&
      ctx.pathname === "/reading/scan-page-ocr/jobs"
    ) {
      const activeOnly = ctx.url.searchParams.get("active_only") !== "false";
      const workerOnline =
        state.healthPayload?.ocr.ready ??
        state.healthPayload?.ocr.workers.some((w) => w.online) ??
        true;
      const allJobs = state.scanJobs ?? [];
      const jobs = activeOnly
        ? allJobs.filter((j) =>
            ["QUEUED", "CLAIMED", "RUNNING", "FAILED_RETRYABLE"].includes(
              j.status,
            ),
          )
        : allJobs;
      return {
        status: 200,
        body: { worker_online: workerOnline, jobs },
      };
    }
    if (
      ctx.method === "POST" &&
      ctx.pathname === "/reading/scan-page-ocr/jobs"
    ) {
      const workerOnline = state.healthPayload?.ocr.ready ?? true;
      const job = makeLocalOcrScanJob({
        job_id: OPAQUE_SCAN_JOB_ID,
        status: "QUEUED",
        worker_online: workerOnline,
        queue_position: 1,
        result: null,
      });
      state.scanJobs = [job];
      return { status: 202, body: job };
    }
    const scanJobMatch = ctx.pathname.match(
      /^\/reading\/scan-page-ocr\/jobs\/([^/]+)$/,
    );
    if (scanJobMatch) {
      const jobId = decodeURIComponent(scanJobMatch[1] ?? OPAQUE_SCAN_JOB_ID);
      if (ctx.method === "GET") {
        const existing = state.scanJobs?.find((j) => j.job_id === jobId);
        if (existing) {
          return { status: 200, body: existing };
        }
        return {
          status: 200,
          body: makeLocalOcrScanJob({ job_id: jobId, status: "SUCCEEDED" }),
        };
      }
      if (ctx.method === "DELETE") {
        const cancelled = makeLocalOcrScanJob({
          job_id: jobId,
          status: "CANCELLED",
          result: null,
        });
        state.scanJobs = (state.scanJobs ?? []).filter(
          (j) => j.job_id !== jobId,
        );
        return { status: 200, body: cancelled };
      }
    }
    if (ctx.method === "POST" && ctx.pathname === "/reading/scan-page-ocr") {
      return { status: 200, body: makeLocalOcrPageScan() };
    }
    if (
      ctx.method === "POST" &&
      (ctx.pathname === "/reading/match-page" ||
        /^\/reading\/books\/[^/]+\/match-page$/.test(ctx.pathname))
    ) {
      return { status: 200, body: makeCameraPageMatchResponse() };
    }

    // --- F-10: AI Voice STT & TTS Routes ---
    if (ctx.method === "GET" && ctx.pathname === "/voice/status") {
      return {
        status: 200,
        body: state.voiceStatus ?? makeVoiceStatusPayload(),
      };
    }
    if (ctx.method === "GET" && ctx.pathname === "/voice/voices") {
      return {
        status: 200,
        body: state.voiceList ?? makeVoiceListPayload(),
      };
    }
    if (ctx.method === "PUT" && ctx.pathname === "/voice/session-lock") {
      const payload = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const sessionId =
        typeof payload.session_id === "string"
          ? payload.session_id
          : OPAQUE_SESSION_ID;
      const voiceId =
        typeof payload.voice_id === "string"
          ? payload.voice_id
          : OPAQUE_VOICE_NORTH_ID;
      state.sessionVoiceLock = { session_id: sessionId, voice_id: voiceId };
      return {
        status: 200,
        body: {
          session_id: sessionId,
          voice_id: voiceId,
          provider: voiceId.startsWith("google_") ? "google" : "local",
          region: voiceId.includes("south")
            ? "south"
            : voiceId.includes("central")
              ? "central"
              : "north",
          model_version: OPAQUE_TTS_MODEL_VERSION,
          locked_at: OPAQUE_NOW_ISO,
        },
      };
    }
    if (ctx.method === "POST" && ctx.pathname === "/voice/text-to-speech") {
      const payload = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const rawText = typeof payload.text === "string" ? payload.text : "";
      const trimmedText = rawText.normalize("NFC").trim();
      const speed = typeof payload.speed === "number" ? payload.speed : 1.0;
      if (
        !trimmedText ||
        !Number.isFinite(speed) ||
        speed < 0.7 ||
        speed > 1.2
      ) {
        return {
          status: 422,
          body: { detail: { code: "VALIDATION_ERROR" } },
        };
      }
      const bookId =
        typeof payload.book_id === "string" ? payload.book_id : null;
      const requestedScope =
        typeof payload.cache_scope === "string" ? payload.cache_scope : null;
      const scope =
        requestedScope === "PRIVATE" || bookId === OPAQUE_PRIVATE_BOOK_ID
          ? "PRIVATE"
          : requestedScope === "COACHING"
            ? "COACHING"
            : "CATALOG";
      const voiceId =
        typeof payload.voice_id === "string"
          ? payload.voice_id
          : OPAQUE_VOICE_NORTH_ID;
      const cacheKey = `${scope}:${bookId ?? ""}:${voiceId}:${speed.toFixed(2)}:${trimmedText}`;
      const seenCount = state.ttsCacheCounts?.[cacheKey] ?? 0;
      if (state.ttsCacheCounts) {
        state.ttsCacheCounts[cacheKey] = seenCount + 1;
      }
      const cacheStatus = seenCount > 0 ? "HIT" : "MISS";
      const cacheControl =
        scope === "PRIVATE" ? "private, no-store" : "no-store";

      return {
        status: 200,
        contentType: "audio/wav",
        headers: {
          "Cache-Control": cacheControl,
          "X-TTS-Cache": cacheStatus,
          "X-TTS-Scope": scope,
          "X-TTS-Provider": "local",
          "X-Voice-Provider": "local",
          "X-Resolved-Voice-Id": voiceId,
          "X-Voice-Region": voiceId.includes("south")
            ? "south"
            : voiceId.includes("central")
              ? "central"
              : "north",
          "X-Voice-Gender": voiceId.includes("minh_quan") ? "male" : "female",
          "X-Voice-Model-Version": OPAQUE_TTS_MODEL_VERSION,
          "X-Voice-Fallback": "0",
          "Access-Control-Expose-Headers":
            "X-TTS-Cache,X-TTS-Scope,X-TTS-Provider,X-Voice-Provider,X-Resolved-Voice-Id,X-Voice-Region,X-Voice-Gender,X-Voice-Model-Version,X-Voice-Fallback",
        },
        body: makeMinimalWavBuffer(260),
      };
    }
    if (
      ctx.method === "POST" &&
      ctx.pathname === "/voice/text-to-speech/timed"
    ) {
      const payload = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const words = Array.isArray(payload.words)
        ? payload.words.filter((w): w is string => typeof w === "string")
        : ["Xin", "chào"];
      const voiceId =
        typeof payload.voice_id === "string"
          ? payload.voice_id
          : OPAQUE_VOICE_NORTH_ID;
      const region = voiceId.includes("south")
        ? "south"
        : voiceId.includes("central")
          ? "central"
          : "north";
      return {
        status: 200,
        body: makeTimedSpeechPayload(words, {
          resolved_voice_id: voiceId,
          region,
          provider: voiceId.startsWith("google_") ? "google" : "local",
        }),
      };
    }
    if (
      ctx.method === "POST" &&
      ctx.pathname === "/voice/text-to-speech/phonics"
    ) {
      const payload = isRecord(ctx.postDataJson) ? ctx.postDataJson : {};
      const steps = Array.isArray(payload.steps)
        ? payload.steps.map((step, idx) => ({
            id:
              isRecord(step) && typeof step.id === "string"
                ? step.id
                : `step_${idx}`,
          }))
        : [{ id: "rhyme_build" }];
      return {
        status: 200,
        body: makePhonicsSpeechPayload(steps),
      };
    }
    if (ctx.method === "POST" && ctx.pathname === "/voice/speech-to-text") {
      return {
        status: 200,
        headers: {
          "X-Voice-Provider": "local",
          "X-Voice-Model-Version": "sherpa-zipformer-vi-1.0",
          "X-Voice-Fallback": "0",
        },
        body: makeSttTranscriptionPayload("mốt Mèo con đi"),
      };
    }

    return null;
  };
}

export async function installCluster3Mocks(
  page: Page,
  state: Cluster3HandlerState = {},
): Promise<ApiMockHandle> {
  return installApiMock(page, makeCluster3DefaultHandlers(state), {
    unmatchedMode: "default-mock",
  });
}

export function assertNoUnexpectedPageErrors(
  errors: PageErrorCollector,
  options: { readonly allowFailedResourceStatuses?: readonly number[] } = {},
): void {
  expect(errors.pageErrors).toEqual([]);
  const allowedStatuses = options.allowFailedResourceStatuses ?? [];
  if (allowedStatuses.length === 0) {
    expect(errors.consoleErrors).toEqual([]);
    return;
  }
  const unexpectedConsoleErrors = errors.consoleErrors.filter((text) => {
    const isNetworkStatusLog =
      text.includes(
        "Failed to load resource: the server responded with a status of ",
      ) &&
      allowedStatuses.some((status) => text.includes(`status of ${status}`));
    return !isNetworkStatusLog;
  });
  expect(unexpectedConsoleErrors).toEqual([]);
}

// ============================================================================
// Cluster 4 Helpers (Reserved for Cluster 4)
// ============================================================================

export const OPAQUE_C4_NOW_OFFSET = "2026-11-21T10:00:00Z";
export const OPAQUE_C4_QUESTION_ID_1 = makeOpaqueUuid(101, "f1100001");
export const OPAQUE_C4_QUESTION_ID_2 = makeOpaqueUuid(102, "f1100002");
export const OPAQUE_C4_ANSWER_ID = makeOpaqueUuid(103, "f1100003");
export const OPAQUE_C4_DIFFICULT_WORD_ATTEMPT_ID = makeOpaqueUuid(
  201,
  "f1200001",
);
export const OPAQUE_C4_PERIOD_ID = makeOpaqueUuid(202, "f1200002");
export const OPAQUE_C4_GOAL_ID = makeOpaqueUuid(301, "f1300001");
export const OPAQUE_C4_PLAN_ID = makeOpaqueUuid(302, "f1300002");
export const OPAQUE_C4_COLLECTION_ID = makeOpaqueUuid(303, "f1300003");
export const OPAQUE_C4_REMINDER_ID = makeOpaqueUuid(304, "f1300004");
export const OPAQUE_C4_OCCURRENCE_ID = makeOpaqueUuid(305, "f1300005");
export const OPAQUE_C4_EMAIL_DELIVERY_ID = makeOpaqueUuid(306, "f1300006");
export const OPAQUE_C4_SHOOTER_SESSION_ID = makeOpaqueUuid(401, "f1400001");
export const OPAQUE_C4_SHOOTER_ROUND_ID = makeOpaqueUuid(402, "f1400002");
export const OPAQUE_C4_SHOOTER_TOKEN_1 = makeOpaqueUuid(403, "f1400003");
export const OPAQUE_C4_SHOOTER_TOKEN_2 = makeOpaqueUuid(404, "f1400004");
export const OPAQUE_C4_PICTURE_SESSION_ID = makeOpaqueUuid(405, "f1400005");
export const OPAQUE_C4_PICTURE_ATTEMPT_ID = makeOpaqueUuid(406, "f1400006");
export const OPAQUE_C4_MEMORY_SESSION_ID = makeOpaqueUuid(407, "f1400007");
export const OPAQUE_C4_KARAOKE_SONG_ID = makeOpaqueUuid(501, "f1500001");
export const OPAQUE_C4_KARAOKE_VERSION_ID = makeOpaqueUuid(502, "f1500002");
export const OPAQUE_C4_KARAOKE_DRAFT_ID = makeOpaqueUuid(503, "f1500003");
export const OPAQUE_C4_KARAOKE_LINE_1_ID = makeOpaqueUuid(504, "f1500004");
export const OPAQUE_C4_KARAOKE_LINE_2_ID = makeOpaqueUuid(505, "f1500005");
export const OPAQUE_C4_KARAOKE_SYLL_1_ID = makeOpaqueUuid(506, "f1500006");
export const OPAQUE_C4_KARAOKE_SYLL_2_ID = makeOpaqueUuid(507, "f1500007");
export const OPAQUE_C4_KARAOKE_SYLL_3_ID = makeOpaqueUuid(508, "f1500008");
export const OPAQUE_C4_KARAOKE_SYLL_4_ID = makeOpaqueUuid(509, "f1500009");
export const OPAQUE_C4_KARAOKE_PRACTICE_ID = makeOpaqueUuid(510, "f150000a");
export const OPAQUE_C4_KARAOKE_JOB_ID = makeOpaqueUuid(511, "f150000b");
export const OPAQUE_C4_AUDIT_ID_1 = makeOpaqueUuid(601, "f2100001");
export const OPAQUE_C4_AUDIT_ID_2 = makeOpaqueUuid(602, "f2100002");
export const OPAQUE_C4_AUDIT_ID_3 = makeOpaqueUuid(603, "f2100003");

export function makeAdminProfilePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: OPAQUE_ADMIN_ID,
    email: "admin@viread.local",
    full_name: "Quản trị ViRead",
    role: "ADMIN",
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// F-11: Comprehension & AI Tutor Factories
// ----------------------------------------------------------------------------

export function makeTutorGenerateResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: OPAQUE_SESSION_ID,
    total: 2,
    source: "AI",
    created: true,
    ...overrides,
  };
}

export function makeTutorNextQuestion(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const defaultQuestion = {
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
  };
  return {
    question:
      overrides.question !== undefined ? overrides.question : defaultQuestion,
    choices: overrides.choices ?? [
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
    progress_label: "Câu 1/2",
    position: 1,
    total: 2,
    completed: false,
    ...overrides,
  };
}

export function makeTutorAnswerResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    answer_id: OPAQUE_C4_ANSWER_ID,
    question_id: OPAQUE_C4_QUESTION_ID_1,
    submitted_answer: "Một giỏ dâu rừng đỏ mọng",
    is_correct: true,
    score: 100,
    feedback_code: "CORRECT",
    story_hint: null,
    ...overrides,
  };
}

export function makeChildProgressAssessment(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const days = typeof overrides.days === "number" ? overrides.days : 30;
  return {
    child_id: OPAQUE_CHILD_ID,
    period_start: "2026-10-22",
    period_end: "2026-11-21",
    days,
    generated_at: OPAQUE_C4_NOW_OFFSET,
    data_status: "OK",
    score: {
      overall: 86,
      previous_overall: 80,
      delta: 6,
      grade: "GOOD",
      grade_label: "Đọc tốt",
      components: [
        {
          key: "ACCURACY",
          label: "Độ chính xác",
          score: 91,
          previous_score: 86,
          detail: "Đọc đúng hầu hết từ khóa.",
        },
        {
          key: "FLUENCY",
          label: "Độ trôi chảy",
          score: 82,
          previous_score: 77,
          detail: "Tốc độ đọc ổn định.",
        },
        {
          key: "COMPREHENSION",
          label: "Đọc hiểu",
          score: 85,
          previous_score: 78,
          detail: "Trả lời tốt câu hỏi nội dung.",
        },
        {
          key: "CONSISTENCY",
          label: "Duy trì thói quen",
          score: 86,
          previous_score: 79,
          detail: "Đọc đều đặn trong tuần.",
        },
      ],
    },
    metrics: {
      reading_assessment: {
        first_pass_correct: 42,
        first_pass_incorrect: 4,
        self_corrected_words: 2,
        unresolved_words: 2,
        retry_attempts: 2,
        skipped_after_retry_limit: 0,
        recognition_uncertain: 1,
      },
      sessions: 6,
      active_days: 5,
      reading_minutes: 38,
      books: 2,
      pages_compared: 8,
      words_read: 420,
      coverage_pct: 95.0,
      accuracy_pct: 91.5,
      skipped_rate_pct: 1.5,
      substitution_rate_pct: 2.0,
      hesitations: 3,
      repeated_words: 2,
      hesitations_per_100_words: 0.7,
      words_per_minute: 68.5,
      comprehension_answered: 8,
      comprehension_first_try_pct: 87.5,
      comprehension_by_type: [
        { type: "FACTUAL", answered: 5, first_try_correct: 4 },
        { type: "VOCABULARY", answered: 3, first_try_correct: 3 },
      ],
      retry_confirmed: 2,
      retry_failed: 0,
    },
    weekly: [
      {
        week_start: "2026-11-09",
        sessions: 3,
        minutes: 18,
        accuracy_pct: 89.0,
      },
      {
        week_start: "2026-11-16",
        sessions: 3,
        minutes: 20,
        accuracy_pct: 91.5,
      },
    ],
    difficult_words: [
      {
        word: "lấp lánh",
        times: 3,
        heard_as: "lắp lánh",
      },
    ],
    assessment: {
      source: "AI",
      model: "gemini-2.5-flash",
      headline: "Bé đang tiến bộ rõ rệt về độ trôi chảy",
      summary:
        "Trong khoảng thời gian này, bé giữ nhịp đọc ổn định và tự sửa tốt các từ khó.",
      strengths: ["Ngắt nghỉ tự nhiên theo dấu câu", "Hiểu ý chính câu chuyện"],
      weaknesses: [
        {
          area: "Thanh điệu",
          detail: "Đôi lúc nhầm giữa thanh hỏi và thanh ngã.",
        },
      ],
      actions: [
        {
          title: "Ôn luyện từ khóa",
          detail: "Đọc chậm lại các từ có dấu ngã 5 phút mỗi tối.",
          audience: "PARENT",
        },
      ],
      practice_words: ["lấp lánh", "rì rào"],
      encouragement:
        "Con làm rất tốt, tiếp tục giữ thói quen đọc mỗi ngày nhé!",
    },
    ai_cached: false,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// F-12: Reports & Difficult Words Factories
// ----------------------------------------------------------------------------

export function makeDifficultWordItem(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    normalized_word: "lấp lánh",
    display_text: "lấp lánh",
    error_count: 3,
    book_title: "Chú Mèo Đi Hia",
    book_id: OPAQUE_BOOK_ID,
    last_practiced_at: OPAQUE_C4_NOW_OFFSET,
    practice_status: "NEEDS_MORE_PRACTICE",
    latest_score: 72,
    practice_count: 1,
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
        context_snippet: "Ánh nắng lấp lánh trên mặt hồ.",
        error_count: 3,
        last_seen_at: OPAQUE_C4_NOW_OFFSET,
      },
    ],
    ...overrides,
  };
}

export function makeDifficultWordsList(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    items: [
      makeDifficultWordItem(),
      makeDifficultWordItem({
        normalized_word: "rì rào",
        display_text: "rì rào",
        error_count: 2,
        practice_status: "NOT_PRACTICED",
        latest_score: null,
        practice_count: 0,
      }),
    ],
    ...overrides,
  };
}

export function makeDifficultWordPracticeAttempt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attempt_id: OPAQUE_C4_DIFFICULT_WORD_ATTEMPT_ID,
    child_id: OPAQUE_CHILD_ID,
    normalized_word: "lấp lánh",
    display_text: "lấp lánh",
    status: "IN_PROGRESS",
    practice_status: "IN_PROGRESS",
    assessment_status: "CORRECT",
    recognition_source: "SERVER_STT",
    transcript: "lấp lánh",
    confidence: 0.94,
    score: 95,
    feedback_message: "Con đọc rõ từ lấp lánh rồi!",
    audio_quality_status: "SPEECH_DETECTED",
    duration_ms: 850,
    started_at: OPAQUE_C4_NOW_OFFSET,
    completed_at: null,
    evidence_count_unchanged: true,
    ...overrides,
  };
}

export function makeDifficultWordHistory(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    child_id: OPAQUE_CHILD_ID,
    items: [
      makeDifficultWordPracticeAttempt({
        status: "COMPLETED",
        practice_status: "COMPLETED",
        completed_at: OPAQUE_C4_NOW_OFFSET,
      }),
    ],
    ...overrides,
  };
}

export function makeProgressReport(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: OPAQUE_REPORT_ID,
    generated_at: OPAQUE_C4_NOW_OFFSET,
    child_id: OPAQUE_CHILD_ID,
    period_start: "2026-11-14",
    period_end: "2026-11-21",
    completed_sessions: 4,
    reading_duration_ms: 960_000,
    omission_count: 2,
    repetition_count: 1,
    long_pause_count: 3,
    omission_rate: 2.5,
    repetition_rate: 1.2,
    long_pause_rate: 3.1,
    comprehension_accuracy: 88.0,
    assessment: {
      first_pass_correct: 35,
      first_pass_incorrect: 3,
      self_corrected_words: 2,
      unresolved_words: 1,
      retry_attempts: 2,
      skipped_after_retry_limit: 0,
      recognition_uncertain: 1,
    },
    assessment_coverage: {
      assessed_sessions: 4,
      total_sessions: 4,
    },
    difficult_words: [makeDifficultWordItem()],
    previous_period: {
      completed_sessions: 3,
      reading_duration_ms: 720_000,
      omission_count: 4,
      repetition_count: 2,
      long_pause_count: 4,
      omission_rate: 4.0,
      repetition_rate: 2.0,
      long_pause_rate: 4.5,
      comprehension_accuracy: 80.0,
    },
    trend_deltas: {
      completed_sessions: 1,
      reading_duration_ms: 240_000,
      omission_rate: -1.5,
      repetition_rate: -0.8,
      long_pause_rate: -1.4,
      comprehension_accuracy: 8.0,
    },
    legacy: null,
    data_status: "complete",
    availability: {
      metrics: "available",
      difficult_words: "available",
      comparison: "available",
    },
    ...overrides,
  };
}

export function makeProgressPeriods(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    items: [
      {
        id: OPAQUE_C4_PERIOD_ID,
        child_id: OPAQUE_CHILD_ID,
        period_start: "2026-11-14",
        period_end: "2026-11-21",
        generated_at: OPAQUE_C4_NOW_OFFSET,
      },
    ],
    next_cursor: null,
    ...overrides,
  };
}

export function makeSessionReadingReports(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: OPAQUE_SESSION_ID,
    primary_report: {
      id: OPAQUE_REPORT_ID,
      session_id: OPAQUE_SESSION_ID,
      child_id: OPAQUE_CHILD_ID,
      page_id: OPAQUE_PAGE_ID,
      page_revision_id: OPAQUE_REV_ID,
      reading_attempt_id: makeOpaqueUuid(203, "f1200003"),
      spoken_text: "Chú mèo đi hia bước ra khu vườn xanh.",
      words_total: 9,
      words_matched: 8,
      words_omitted: 1,
      words_substituted: 0,
      words_inserted: 0,
      accuracy_pct: 88.9,
      omission_rate: 11.1,
      wpm: 64.0,
      created_at: OPAQUE_C4_NOW_OFFSET,
      aligned_words: [
        {
          index: 0,
          expected_word: "Chú",
          spoken_word: "Chú",
          status: "MATCHED",
        },
        {
          index: 1,
          expected_word: "mèo",
          spoken_word: "mèo",
          status: "MATCHED",
        },
      ],
    },
    reports: [],
    total_reports: 1,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// F-13: Reading Management & Parent Emails Factories
// ----------------------------------------------------------------------------

export function makeReadingGoal(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: OPAQUE_C4_GOAL_ID,
    child_id: OPAQUE_CHILD_ID,
    metric: "MINUTES",
    target_value: 20,
    period: "DAILY",
    starts_on: "2026-11-20",
    ends_on: "2026-12-20",
    timezone: "Asia/Ho_Chi_Minh",
    status: "ACTIVE",
    current_value: 15,
    progress_percent: 75,
    completed_value: null,
    completed_at: null,
    created_at: OPAQUE_C4_NOW_OFFSET,
    updated_at: OPAQUE_C4_NOW_OFFSET,
    phase: "RUNNING",
    streak_cycles: 3,
    cycle_starts_on: "2026-11-21",
    cycle_ends_on: "2026-11-21",
    ...overrides,
  };
}

export function makeReadingPlan(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: OPAQUE_C4_PLAN_ID,
    child_id: OPAQUE_CHILD_ID,
    book_id: OPAQUE_BOOK_ID,
    book_title: "Chú Mèo Đi Hia",
    title: "Kế hoạch đọc buổi tối",
    target_minutes: 15,
    weekdays: [1, 3, 5],
    starts_on: "2026-11-20",
    ends_on: "2026-12-20",
    timezone: "Asia/Ho_Chi_Minh",
    status: "ACTIVE",
    scheduled_days_this_week: 3,
    completed_days_this_week: 2,
    progress_percent: 66.7,
    completed_at: null,
    created_at: OPAQUE_C4_NOW_OFFSET,
    updated_at: OPAQUE_C4_NOW_OFFSET,
    phase: "RUNNING",
    next_scheduled_date: "2026-11-22",
    is_scheduled_today: true,
    minutes_today: 10,
    ...overrides,
  };
}

export function makeReadingCollection(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: OPAQUE_C4_COLLECTION_ID,
    child_id: OPAQUE_CHILD_ID,
    book_id: OPAQUE_BOOK_ID,
    collection_type: "FAVORITE",
    created_at: OPAQUE_C4_NOW_OFFSET,
    book: {
      id: OPAQUE_BOOK_ID,
      title: "Chú Mèo Đi Hia",
      author: "ViRead",
      min_grade: 1,
      max_grade: 3,
      lifecycle_status: "ACTIVE",
      available_to_read: true,
    },
    ...overrides,
  };
}

export function makeReadingReminder(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: OPAQUE_C4_REMINDER_ID,
    child_id: OPAQUE_CHILD_ID,
    remind_at: "19:30",
    weekdays: [1, 3, 5],
    timezone: "Asia/Ho_Chi_Minh",
    is_active: true,
    email_enabled: true,
    deleted_at: null,
    created_at: OPAQUE_C4_NOW_OFFSET,
    updated_at: OPAQUE_C4_NOW_OFFSET,
    ...overrides,
  };
}

export function makeDueOccurrence(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: OPAQUE_C4_OCCURRENCE_ID,
    reminder_id: OPAQUE_C4_REMINDER_ID,
    scheduled_local_date: "2026-11-21",
    scheduled_for: OPAQUE_C4_NOW_OFFSET,
    status: "DUE",
    acknowledged_at: null,
    child_id: OPAQUE_CHILD_ID,
    child_alias: "Bé Mèo",
    remind_at: "19:30",
    timezone: "Asia/Ho_Chi_Minh",
    ...overrides,
  };
}

export function makeParentNotificationPreferences(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

export function makeParentNotificationHistory(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    items: [
      {
        id: OPAQUE_C4_EMAIL_DELIVERY_ID,
        child_id: OPAQUE_CHILD_ID,
        notification_type: "TEST",
        subject: "Email thử nghiệm từ ViRead",
        recipient_masked: "p***@viread.local",
        status: "SENT",
        provider: "resend",
        error_summary: null,
        sent_at: OPAQUE_C4_NOW_OFFSET,
        created_at: OPAQUE_C4_NOW_OFFSET,
      },
    ],
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// F-14: Entertainment V4 & Adaptive Learning Factories
// ----------------------------------------------------------------------------

export function makeAdaptiveRecommendations(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const primary = {
    game_key: "SENTENCE_SHOOTER",
    zone_title_vi: "Khu luyện câu",
    game_title_vi: "Bắn câu tinh anh",
    reason_vi: "Giúp con ôn tập từ khó lấp lánh qua ghép câu.",
    suggested_mode: "WORD_ORDER",
    suggested_difficulty: 1,
    target_words: ["lấp lánh"],
    href: "/entertainment/sentence-shooter",
    priority: 1,
  };
  return {
    child_id: OPAQUE_CHILD_ID,
    child_alias: "Bé Mèo",
    child_grade: 2,
    mascot_greeting_vi: "Chào Bé Mèo! Cùng chơi trò chơi ngôn ngữ nào!",
    natural_break_reminder_vi: "Chơi 15 phút rồi nghỉ mắt một chút nhé.",
    today_activities_count: 2,
    focus_difficult_words: ["lấp lánh"],
    primary_recommendation: primary,
    recommendations: [
      primary,
      {
        game_key: "PICTURE_DESCRIPTION",
        zone_title_vi: "Khu quan sát",
        game_title_vi: "Kể chuyện theo tranh",
        reason_vi: "Rèn khả năng diễn đạt câu hoàn chỉnh.",
        suggested_mode: "OBSERVE",
        suggested_difficulty: 1,
        target_words: ["rì rào"],
        href: "/entertainment/picture-description",
        priority: 2,
      },
      {
        game_key: "MEMORY_GAME",
        zone_title_vi: "Khu trí nhớ",
        game_title_vi: "Ghi nhớ bức tranh",
        reason_vi: "Tăng độ tập trung chi tiết.",
        suggested_mode: "FREE_RECALL",
        suggested_difficulty: 1,
        target_words: [],
        href: "/entertainment/memory-game",
        priority: 3,
      },
    ],
    ...overrides,
  };
}

export function makeParentLearningAnalytics(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const domains = [
    "READING_WORDS",
    "LANGUAGE_GRAMMAR",
    "OBSERVATION_MEMORY_CREATIVITY",
    "MUSIC_RHYTHM",
  ] as const;
  const skills = Array.from({ length: 16 }, (_, idx) => ({
    skill_key: `skill_${idx + 1}`,
    label_vi: `Kỹ năng ngôn ngữ ${idx + 1}`,
    domain: domains[idx % 4],
    status: idx < 6 ? "OBSERVED" : idx < 11 ? "ESTIMATED" : "UNKNOWN",
    mastery_pct: idx < 11 ? 75 + (idx % 20) : null,
    confidence: idx < 6 ? 0.85 : 0.45,
    evidence_count: idx < 11 ? 3 : 0,
    high_confidence_count: idx < 6 ? 2 : 0,
    last_observed_at: idx < 11 ? OPAQUE_C4_NOW_OFFSET : null,
    source_modules: idx < 11 ? ["SENTENCE_SHOOTER"] : [],
  }));
  return {
    child_id: OPAQUE_CHILD_ID,
    child_alias: "Bé Mèo",
    child_grade: 2,
    window_days: 30,
    is_diagnostic: false,
    disclaimer_vi:
      "Số liệu phản ánh mức độ luyện tập trong trò chơi, không thay thế đánh giá y khoa.",
    observed_skills_count: 6,
    estimated_skills_count: 5,
    unknown_skills_count: 5,
    skills,
    practiced_difficult_words: [
      {
        normalized_word: "lấp lánh",
        display_text: "lấp lánh",
        priority_score: 0.9,
        practice_count: 2,
        last_practiced_at: OPAQUE_C4_NOW_OFFSET,
        days_since_practice: 1,
        recommended_game: "SENTENCE_SHOOTER",
        reason_vi: "Cần ôn thêm qua trò ghép câu.",
      },
    ],
    module_activities: [
      {
        game_key: "SENTENCE_SHOOTER",
        title_vi: "Bắn câu tinh anh",
        sessions_count: 3,
        recent_average_pct: 85,
        highlight_vi: "Ghép đúng 3 câu liên tiếp.",
      },
    ],
    karaoke_weak_segments: [],
    home_support_tips_vi: ["Cùng con đặt câu mới với từ lấp lánh."],
    generated_at: OPAQUE_C4_NOW_OFFSET,
    ...overrides,
  };
}

export function makeSentenceShooterBook(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: OPAQUE_BOOK_ID,
    name: "chu-meo-di-hia",
    title: "Chú Mèo Đi Hia",
    author: "ViRead",
    min_grade: 1,
    max_grade: 3,
    available_rounds: 3,
    ...overrides,
  };
}

export function makeSentenceShooterSession(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: OPAQUE_C4_SHOOTER_SESSION_ID,
    book: makeSentenceShooterBook(),
    difficulty: "easy",
    learning_mode: "WORD_ORDER",
    total_rounds: 2,
    completed_rounds: 0,
    total_stars: 0,
    practiced_difficult_words: ["lấp lánh"],
    round: {
      round_id: OPAQUE_C4_SHOOTER_ROUND_ID,
      round_number: 1,
      token_count: 2,
      tokens: [
        {
          id: OPAQUE_C4_SHOOTER_TOKEN_1,
          text: "Ánh nắng",
          is_difficult_word: false,
        },
        {
          id: OPAQUE_C4_SHOOTER_TOKEN_2,
          text: "lấp lánh",
          is_difficult_word: true,
        },
      ],
      learning_mode: "WORD_ORDER",
      prompt_slots: [
        { position: 0, text: null, is_blank: true, is_difficult_word: false },
        { position: 1, text: null, is_blank: true, is_difficult_word: true },
      ],
      practiced_difficult_words: ["lấp lánh"],
      prompt_hint: "Chọn cụm từ bắt đầu câu.",
    },
    ...overrides,
  };
}

export function makeSentenceShooterShotResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    is_correct: true,
    correct_count: 2,
    token_count: 2,
    mistakes_total: 0,
    completed_rounds: 1,
    total_stars: 3,
    round_completed: true,
    session_completed: true,
    next_expected_position: 2,
    stars_awarded: 3,
    score: 100,
    completed_sentence: "Ánh nắng lấp lánh",
    next_round: null,
    message: "Tuyệt vời! Con ghép đúng câu rồi.",
    client_shot_id: null,
    learning_mode: "WORD_ORDER",
    grammar_tip: "Chủ ngữ đứng trước vị ngữ miêu tả.",
    practiced_difficult_words: ["lấp lánh"],
    ...overrides,
  };
}

export function makeSentenceShooterResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: OPAQUE_C4_SHOOTER_SESSION_ID,
    book: makeSentenceShooterBook(),
    difficulty: "easy",
    learning_mode: "WORD_ORDER",
    status: "COMPLETED",
    total_rounds: 2,
    completed_rounds: 2,
    total_stars: 6,
    stars_max: 6,
    mistakes_total: 0,
    accuracy_percent: 100,
    summary_message: "Hoàn thành xuất sắc!",
    practiced_difficult_words: ["lấp lánh"],
    ...overrides,
  };
}

export function makePictureDescriptionCatalog(
  apiBaseUrl: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    samples: [
      {
        sample_key: "sunny_garden",
        title: "Khu vườn buổi sáng",
        theme: "Thiên nhiên",
        description: "Tranh khu vườn có hoa và bướm.",
        image_url: `${apiBaseUrl}/media/picture-sample.png`,
      },
    ],
    book_pages: [
      {
        book_id: OPAQUE_BOOK_ID,
        book_title: "Chú Mèo Đi Hia",
        page_id: OPAQUE_PAGE_ID,
        page_number: 1,
        image_url: `${apiBaseUrl}/media/picture-sample.png`,
      },
    ],
    ...overrides,
  };
}

export function makePictureDescriptionSession(
  apiBaseUrl: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: OPAQUE_C4_PICTURE_SESSION_ID,
    child_id: OPAQUE_CHILD_ID,
    child_grade: 2,
    source_type: "SAMPLE",
    sample_key: "sunny_garden",
    book_id: null,
    book_page_id: null,
    image_url: `${apiBaseUrl}/media/picture-sample.png`,
    scene_title: "Khu vườn buổi sáng",
    status: "ACTIVE",
    best_stars: 0,
    best_score: 0,
    attempts_count: 0,
    teaching_mode: "OBSERVE",
    target_words: ["rì rào"],
    provider_tier: "CURATED",
    guide: {
      is_child_safe: true,
      scene_title: "Khu vườn buổi sáng",
      scene_summary: "Một khu vườn tràn ngập ánh nắng và hoa nở rộ.",
      guiding_questions: ["Con nhìn thấy những gì trong bức tranh?"],
      suggested_vocabulary: [
        { word: "rì rào", hint: "Âm thanh gió thổi qua lá cây" },
      ],
      model_sample_sentences: ["Gió thổi rì rào qua tán cây xanh."],
      teaching_mode: "OBSERVE",
      target_words: ["rì rào"],
    },
    attempts: [],
    created_at: OPAQUE_C4_NOW_OFFSET,
    updated_at: OPAQUE_C4_NOW_OFFSET,
    ...overrides,
  };
}

export function makePictureDescriptionEvaluateResponse(
  apiBaseUrl: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const attempt = {
    attempt_id: OPAQUE_C4_PICTURE_ATTEMPT_ID,
    attempt_number: 1,
    input_mode: "TEXT",
    transcript_text: "Khu vườn có hoa vàng và gió thổi rì rào.",
    score_out_of_10: 9,
    stars: 3,
    evaluation_source: "AI",
    provider_tier: "CURATED",
    feedback: {
      is_relevant: true,
      score_out_of_10: 9,
      stars: 3,
      matched_details: ["hoa vàng", "gió thổi"],
      missed_details: [],
      praise_message: "Câu miêu tả của con rất sinh động!",
      improvement_tip: "Có thể thêm chi tiết màu sắc của bầu trời.",
      upgraded_sentences: ["Trong khu vườn nắng ấm, hoa vàng nở rộ."],
      vocabulary_highlights: ["rì rào"],
      teaching_mode: "OBSERVE",
      scaffolding_step: "PRAISE",
      next_prompt_question: "Con thấy bạn nhỏ trong vườn đang làm gì?",
      used_target_words: ["rì rào"],
      provider_tier: "CURATED",
    },
    created_at: OPAQUE_C4_NOW_OFFSET,
  };
  return {
    session: makePictureDescriptionSession(apiBaseUrl, {
      status: "COMPLETED",
      best_stars: 3,
      best_score: 9,
      attempts_count: 1,
      attempts: [attempt],
    }),
    latest_attempt: attempt,
    ...overrides,
  };
}

export function makeMemoryThemes(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    themes: [
      {
        theme_key: "sunny_garden",
        name_vi: "Khu vườn nắng mai",
        description_vi: "Quan sát hoa lá và các bạn nhỏ trong vườn.",
        badge_vi: "Phù hợp lớp 2",
        accent_hex: "#2563EB",
        sprite_count: 3,
        sample_items_vi: ["Quả bóng đỏ", "Bông hoa vàng"],
      },
    ],
    timer_options: [
      {
        mode: "10S",
        seconds: 10,
        label_vi: "10 giây",
        recommended_for_vi: "Nhanh",
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
        grade: 2,
        min_objects: 2,
        max_objects: 4,
        recommended_timer: "10S",
        recommended_recall_mode: "FREE_RECALL",
        recommended_difficulty: 1,
        note_vi: "Gợi ý quan sát 10 giây.",
      },
    ],
    total_sprites: 12,
    ...overrides,
  };
}

export function makeMemorySession(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const status =
    typeof overrides.status === "string" ? overrides.status : "OBSERVING";
  const sceneObject = {
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
  };
  return {
    session_id: OPAQUE_C4_MEMORY_SESSION_ID,
    child_id: OPAQUE_CHILD_ID,
    child_grade: 2,
    theme_key: "sunny_garden",
    timer_mode: "10S",
    timer_seconds: 10,
    recall_mode: "FREE_RECALL",
    difficulty_level: 1,
    status,
    hints_used: 0,
    peek_used: 0,
    best_factual_score: 0,
    best_creative_score: 0,
    best_stars: 0,
    scene: {
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
      objects: [sceneObject],
      observation_tips_vi: ["Nhớ vị trí và màu sắc của đồ vật."],
      guided_questions_vi: ["Quả bóng màu gì?"],
      creative_prompt_vi: "Hãy kể tiếp câu chuyện về quả bóng đỏ trong vườn.",
      matched_focus_words: ["quả bóng"],
    },
    latest_evaluation: null,
    attempts: [],
    created_at: OPAQUE_C4_NOW_OFFSET,
    updated_at: OPAQUE_C4_NOW_OFFSET,
    ...overrides,
  };
}

export function makeMemoryAttemptResult(
  stage: "RECALL" | "CREATIVE",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    used_focus_words: ["quả bóng"],
    provider_tier: "CURATED",
    hints_used: 0,
    peek_used: 0,
  };
  return {
    session: makeMemorySession({
      status: stage === "CREATIVE" ? "COMPLETED" : "RECALLING",
      best_factual_score: 90,
      best_creative_score: evaluation.creative_score,
      best_stars: 3,
      latest_evaluation: evaluation,
    }),
    evaluation,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// F-15: Karaoke Ecosystem Factories
// ----------------------------------------------------------------------------

export function makeKaraokeLyricsPayload(): Record<string, unknown> {
  return {
    format_version: 2,
    lines: [
      {
        id: OPAQUE_C4_KARAOKE_LINE_1_ID,
        text: "Con cò",
        start_ms: 0,
        end_ms: 900,
        syllables: [
          {
            id: OPAQUE_C4_KARAOKE_SYLL_1_ID,
            text: "Con",
            start_ms: 0,
            end_ms: 400,
          },
          {
            id: OPAQUE_C4_KARAOKE_SYLL_2_ID,
            text: "cò",
            start_ms: 450,
            end_ms: 900,
          },
        ],
      },
      {
        id: OPAQUE_C4_KARAOKE_LINE_2_ID,
        text: "bé bé",
        start_ms: 1000,
        end_ms: 1900,
        syllables: [
          {
            id: OPAQUE_C4_KARAOKE_SYLL_3_ID,
            text: "bé",
            start_ms: 1000,
            end_ms: 1400,
          },
          {
            id: OPAQUE_C4_KARAOKE_SYLL_4_ID,
            text: "bé",
            start_ms: 1450,
            end_ms: 1900,
          },
        ],
      },
    ],
  };
}

export function makeKaraokeSongCard(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    song_id: OPAQUE_C4_KARAOKE_SONG_ID,
    version_id: OPAQUE_C4_KARAOKE_VERSION_ID,
    title: "Con Cò Bé Bé",
    author: "Dân ca thiếu nhi",
    duration_ms: 2000,
    cover_url: null,
    min_grade: 1,
    max_grade: 3,
    ...overrides,
  };
}

export function makeKaraokePlayback(
  apiBaseUrl: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    song_id: OPAQUE_C4_KARAOKE_SONG_ID,
    version_id: OPAQUE_C4_KARAOKE_VERSION_ID,
    revision: 1,
    title: "Con Cò Bé Bé",
    author: "Dân ca thiếu nhi",
    duration_ms: 2000,
    audio_url: `${apiBaseUrl}/media/karaoke-test.wav`,
    audio_url_expires_at: OPAQUE_C4_NOW_OFFSET,
    cover_url: null,
    lyrics: makeKaraokeLyricsPayload(),
    ...overrides,
  };
}

export function makeKaraokePracticeSession(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: OPAQUE_C4_KARAOKE_PRACTICE_ID,
    child_id: OPAQUE_CHILD_ID,
    song_id: OPAQUE_C4_KARAOKE_SONG_ID,
    song_version_id: OPAQUE_C4_KARAOKE_VERSION_ID,
    practice_mode: "FULL_SONG",
    scoring_mode: "FULL_MUSICAL",
    playback_rate: 0.85,
    headphone_mode: false,
    overall_score: 88,
    rhythm_score: 86,
    pitch_score: 90,
    lyrics_score: 88,
    fluency_score: 87,
    stars: 3,
    segment_start_ms: null,
    segment_end_ms: null,
    report_payload: {},
    created_at: OPAQUE_C4_NOW_OFFSET,
    persisted: true,
    storage_notice: null,
    ...overrides,
  };
}

export function makeKaraokeMusicalProfile(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    song_id: OPAQUE_C4_KARAOKE_SONG_ID,
    song_version_id: OPAQUE_C4_KARAOKE_VERSION_ID,
    bpm: 100,
    audio_type: "VOCAL_FULL",
    has_pitch_contour: true,
    has_beat_grid: true,
    source_method: "LYRICS_TIMING",
    beat_grid_ms: [0, 500, 1000, 1500],
    pitch_contour: [
      { time_ms: 200, hz: 261.63, midi: 60 },
      { time_ms: 1200, hz: 293.66, midi: 62 },
    ],
    phrase_windows: [{ start_ms: 0, end_ms: 1900 }],
    updated_at: OPAQUE_C4_NOW_OFFSET,
    ...overrides,
  };
}

export function makeAdminProcessingCapabilities(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    enabled: true,
    configured: true,
    supported_modes: ["VOCAL_TRACK", "INSTRUMENTAL_WITH_REFERENCE"],
    unavailable_reason: null,
    limits: {
      max_audio_bytes: 20 * 1024 * 1024,
      max_duration_ms: 300_000,
      max_lyric_lines: 300,
      max_lyric_characters: 50_000,
    },
    queue_warning_after_seconds: 30,
    ...overrides,
  };
}

export function makeAdminKaraokeSongSummary(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    song_id: OPAQUE_C4_KARAOKE_SONG_ID,
    status: "PUBLISHED",
    revision: 1,
    title: "Con Cò Bé Bé",
    author: "Dân ca thiếu nhi",
    min_grade: 1,
    max_grade: 3,
    duration_ms: 2000,
    draft_version_id: OPAQUE_C4_KARAOKE_DRAFT_ID,
    published_version_id: OPAQUE_C4_KARAOKE_VERSION_ID,
    processing_summary: null,
    has_audio: true,
    has_cover: false,
    created_at: OPAQUE_C4_NOW_OFFSET,
    updated_at: OPAQUE_C4_NOW_OFFSET,
    ...overrides,
  };
}

export function makeAdminKaraokeSongDetail(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const versionBase = {
    title: "Con Cò Bé Bé",
    author: "Dân ca thiếu nhi",
    min_grade: 1,
    max_grade: 3,
    source_note: "Bài hát thiếu nhi dân gian Việt Nam.",
    usage_note: "Dùng cho luyện hát và nhịp điệu trong ViRead.",
    has_audio: true,
    has_cover: false,
    duration_ms: 2000,
    audio_size_bytes: 64_000,
    audio_sha256: "a".repeat(64),
    has_reference_audio: false,
    reference_audio_sha256: null,
    lyrics: makeKaraokeLyricsPayload(),
    created_at: OPAQUE_C4_NOW_OFFSET,
    updated_at: OPAQUE_C4_NOW_OFFSET,
  };
  return {
    processing_summary: null,
    processing_review: {
      required: false,
      current_content_fingerprint: "b".repeat(64),
      reviewed: true,
      reviewed_at: OPAQUE_C4_NOW_OFFSET,
      quality_flags: [],
    },
    song_id: OPAQUE_C4_KARAOKE_SONG_ID,
    status: "PUBLISHED",
    revision: 1,
    draft: {
      ...versionBase,
      id: OPAQUE_C4_KARAOKE_DRAFT_ID,
      version_no: 2,
      state: "DRAFT",
      published_at: null,
    },
    published: {
      ...versionBase,
      id: OPAQUE_C4_KARAOKE_VERSION_ID,
      version_no: 1,
      state: "PUBLISHED",
      published_at: OPAQUE_C4_NOW_OFFSET,
    },
    created_at: OPAQUE_C4_NOW_OFFSET,
    updated_at: OPAQUE_C4_NOW_OFFSET,
    ...overrides,
  };
}

export function makeSimpleImportResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    song_id: OPAQUE_C4_KARAOKE_SONG_ID,
    version_id: OPAQUE_C4_KARAOKE_DRAFT_ID,
    revision: 1,
    title: "Con Cò Bé Bé",
    author: "Dân ca thiếu nhi",
    duration_ms: 2000,
    has_cover: false,
    audio_type: "VOCAL_FULL",
    bpm: 100,
    lyrics_source: "EMBEDDED_SYNCED",
    lyrics_line_count: 2,
    flagged_lines: [],
    requires_lyrics_input: false,
    guidance_vi: "Bài hát đã sẵn sàng để kiểm tra và xuất bản.",
    ready_to_publish: true,
    missing_checks: [],
    lifecycle_state: "READY_FOR_REVIEW",
    worker_online: true,
    processing_queued: false,
    processing_job_id: null,
    processing_notice: null,
    song: makeAdminKaraokeSongDetail({ status: "DRAFT", published: null }),
    ...overrides,
  };
}

export function makeSimpleProcessingStatus(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    song_id: OPAQUE_C4_KARAOKE_SONG_ID,
    draft_version_id: OPAQUE_C4_KARAOKE_DRAFT_ID,
    revision: 1,
    lifecycle_state: "READY_FOR_REVIEW",
    worker_online: true,
    processing_enabled: true,
    processing_configured: true,
    job_id: OPAQUE_C4_KARAOKE_JOB_ID,
    job_status: "READY",
    job_stage: "COMPLETE",
    can_apply: true,
    review_required: false,
    reviewed: true,
    has_beat_grid: true,
    has_pitch_contour: true,
    bpm: 100,
    safe_error_code: null,
    retry_policy: "NONE",
    quality_flags: [],
    guidance_vi: "Kết quả xử lý đã sẵn sàng.",
    song: makeAdminKaraokeSongDetail({ status: "DRAFT", published: null }),
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// F-21 & F-22: Admin Health, Audit Logs, Support Factories
// ----------------------------------------------------------------------------

export function makeCluster4AdminHealthSnapshot(
  overrides: Partial<AdminHealthSnapshotPayload> = {},
): AdminHealthSnapshotPayload {
  return makeAdminHealthSnapshot({
    services: [
      {
        id: "api",
        label: "Hệ thống xử lý chính",
        status: "HEALTHY",
        operational_state: "Healthy",
        checked_at: OPAQUE_C4_NOW_OFFSET,
        safe_message: "Dịch vụ đang hoạt động ổn định.",
        detail_status: "healthy",
        last_success_at: OPAQUE_C4_NOW_OFFSET,
        service_group: "core",
        execution_mode: "always_on",
        criticality: "core",
        can_wake: false,
      },
      {
        id: "voice_stt",
        label: "Nhận diện giọng đọc",
        status: "HEALTHY",
        operational_state: "Healthy",
        checked_at: OPAQUE_C4_NOW_OFFSET,
        safe_message: "Voice engine sẵn sàng.",
        detail_status: "healthy",
        last_success_at: OPAQUE_C4_NOW_OFFSET,
        service_group: "voice",
        execution_mode: "in_process",
        criticality: "important",
        can_wake: false,
      },
      {
        id: "ocr_worker",
        label: "Dịch vụ nhận diện chữ",
        status: "HEALTHY",
        operational_state: "Standby",
        checked_at: OPAQUE_C4_NOW_OFFSET,
        safe_message: "Worker đang chờ lệnh đánh thức.",
        detail_status: "standby",
        last_success_at: OPAQUE_C4_NOW_OFFSET,
        queue_depth: 0,
        service_group: "ocr",
        execution_mode: "remote_worker",
        criticality: "important",
        can_wake: true,
      },
      {
        id: "parent_email_cron",
        label: "Tác vụ gửi email phụ huynh",
        status: "HEALTHY",
        operational_state: "Scheduled",
        checked_at: OPAQUE_C4_NOW_OFFSET,
        safe_message: "Lịch trình định kỳ hoạt động bình thường.",
        detail_status: "scheduled",
        last_success_at: OPAQUE_C4_NOW_OFFSET,
        service_group: "workers",
        execution_mode: "cron_scheduled",
        criticality: "optional",
        can_wake: false,
      },
      {
        id: "browser_wasm_stt",
        label: "STT trình duyệt",
        status: "HEALTHY",
        operational_state: "Local only",
        checked_at: OPAQUE_C4_NOW_OFFSET,
        safe_message: "Chạy cục bộ trên thiết bị.",
        detail_status: "local_only",
        last_success_at: null,
        service_group: "voice",
        execution_mode: "local_only",
        criticality: "optional",
        can_wake: false,
      },
    ],
    ...overrides,
  });
}

export function makeAdminAuditLogsPage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    items: [
      {
        id: OPAQUE_C4_AUDIT_ID_1,
        actor_id: OPAQUE_ADMIN_ID,
        action: "BOOK_PUBLISHED",
        resource_type: "BOOK",
        resource_id: OPAQUE_BOOK_ID,
        request_id: "req-audit-001",
        created_at: OPAQUE_C4_NOW_OFFSET,
        metadata: {
          book_title: "Chú Mèo Đi Hia",
          grade_range: "1-3",
          auth_token: "leaked-token-should-be-masked",
          webhook_secret: "leaked-secret-should-be-masked",
          payload_hash: "leaked-hash-should-be-masked",
          hmac_signature: "leaked-sig-should-be-masked",
          request_nonce: "leaked-nonce-should-be-masked",
          internal_uuid: "leaked-uuid-should-be-masked",
        },
      },
      {
        id: OPAQUE_C4_AUDIT_ID_2,
        actor_id: OPAQUE_ADMIN_ID,
        action: "KARAOKE_PUBLISHED",
        resource_type: "KARAOKE_SONG",
        resource_id: OPAQUE_C4_KARAOKE_SONG_ID,
        request_id: "req-audit-002",
        created_at: OPAQUE_C4_NOW_OFFSET,
        metadata: {
          song_title: "Con Cò Bé Bé",
        },
      },
    ],
    next_cursor: null,
    ...overrides,
  };
}

export function makeSupportFeedbackAccepted(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    accepted: true,
    delivery_status: "accepted_by_smtp",
    detail: "Phản hồi của bạn đã được tiếp nhận.",
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// Cluster 4 Mock Handler Builder & Single-Install Helpers
// ----------------------------------------------------------------------------

export interface Cluster4HandlerState {
  role?: "parent" | "admin";
  healthPayload?: HealthPayload;
  tutorGenerate?: Record<string, unknown>;
  tutorNext?: Record<string, unknown>;
  tutorAnswer?: Record<string, unknown>;
  childProgressAssessment?: Record<string, unknown>;
  progressReport?: Record<string, unknown>;
  progressPeriods?: Record<string, unknown>;
  difficultWords?: Record<string, unknown>;
  difficultWordStart?: Record<string, unknown>;
  difficultWordEvaluate?: Record<string, unknown>;
  difficultWordComplete?: Record<string, unknown>;
  difficultWordHistory?: Record<string, unknown>;
  readingHistory?: Record<string, unknown>;
  sessionDetail?: Record<string, unknown>;
  sessionReports?: Record<string, unknown>;
  readingGoals?: Record<string, unknown>[];
  readingPlans?: Record<string, unknown>[];
  readingCollections?: Record<string, unknown>[];
  readingReminders?: Record<string, unknown>[];
  readingDue?: Record<string, unknown>[];
  parentPreferences?: Record<string, unknown>;
  parentHistory?: Record<string, unknown>;
  recommendations?: Record<string, unknown>;
  parentAnalytics?: Record<string, unknown>;
  shooterBooks?: Record<string, unknown>[];
  shooterSession?: Record<string, unknown>;
  shooterShot?: Record<string, unknown>;
  shooterResult?: Record<string, unknown>;
  pictureCatalog?: Record<string, unknown>;
  pictureSession?: Record<string, unknown>;
  pictureEvaluate?: Record<string, unknown>;
  memoryThemes?: Record<string, unknown>;
  memorySession?: Record<string, unknown>;
  memoryAttempt?: Record<string, unknown>;
  karaokeSongs?: Record<string, unknown>[];
  karaokePlayback?: Record<string, unknown>;
  karaokePracticeHistory?: Record<string, unknown>;
  karaokePracticeSession?: Record<string, unknown>;
  karaokeMusicalProfile?: Record<string, unknown>;
  adminCapabilities?: Record<string, unknown>;
  adminKaraokeSongs?: Record<string, unknown>[];
  adminKaraokeDetail?: Record<string, unknown>;
  simpleImportResult?: Record<string, unknown>;
  simpleProcessingStatus?: Record<string, unknown>;
  assistantStatus?: Record<string, unknown>;
  assistantContext?: Record<string, unknown>;
  assistantReply?: Record<string, unknown>;
  adminHealthSnapshot?: AdminHealthSnapshotPayload;
  adminAuditLogs?: Record<string, unknown>;
  supportFeedbackResponse?: Record<string, unknown>;
  customRoutes?: readonly ApiRouteHandler[];
}

export function makeCluster4DefaultHandlers(
  state: Cluster4HandlerState = {},
): ApiRouteHandler[] {
  const wavAudioBytes = makeMinimalWavBuffer(2000);
  const pngBytes = makeMinimalPngBuffer();

  const goals = [...(state.readingGoals ?? [makeReadingGoal()])];
  const plans = [...(state.readingPlans ?? [makeReadingPlan()])];
  const collections = [
    ...(state.readingCollections ?? [makeReadingCollection()]),
  ];
  const reminders = [...(state.readingReminders ?? [makeReadingReminder()])];
  const dueOccurrences = [...(state.readingDue ?? [makeDueOccurrence()])];
  let prefs = state.parentPreferences ?? makeParentNotificationPreferences();
  let adminKaraokeDetail =
    state.adminKaraokeDetail ?? makeAdminKaraokeSongDetail();
  const adminKaraokeSongs = [
    ...(state.adminKaraokeSongs ?? [makeAdminKaraokeSongSummary()]),
  ];

  const c4Handler: ApiRouteHandler = (
    ctx: ApiMockRequestContext,
  ): ApiMockResponse | null => {
    const { method, pathname, apiBaseUrl, searchParams } = ctx;

    // Static test media served from API origin
    if (method === "GET" && pathname === "/media/karaoke-test.wav") {
      return {
        status: 200,
        contentType: "audio/wav",
        body: wavAudioBytes,
      };
    }
    if (method === "GET" && pathname === "/media/picture-sample.png") {
      return {
        status: 200,
        contentType: "image/png",
        body: pngBytes,
      };
    }

    if (method === "GET" && pathname === "/health") {
      return {
        status: 200,
        body: state.healthPayload ?? makeHealthPayload(),
      };
    }

    if (method === "GET" && pathname === "/auth/me") {
      if (state.role === "admin") {
        return { status: 200, body: makeAdminProfilePayload() };
      }
      return { status: 200, body: makeParentProfile() };
    }

    // F-11: Tutor & Child Progress Assessment
    if (
      method === "POST" &&
      /^\/tutor\/sessions\/[^/]+\/questions\/generate$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.tutorGenerate ?? makeTutorGenerateResponse(),
      };
    }
    if (
      method === "GET" &&
      /^\/tutor\/sessions\/[^/]+\/questions\/next$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.tutorNext ?? makeTutorNextQuestion(),
      };
    }
    if (
      method === "POST" &&
      /^\/tutor\/sessions\/[^/]+\/questions\/[^/]+\/answer$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.tutorAnswer ?? makeTutorAnswerResponse(),
      };
    }
    if (
      (method === "GET" || method === "POST") &&
      /^\/tutor\/children\/[^/]+\/progress-assessment$/.test(pathname)
    ) {
      const daysParam = Number(searchParams.get("days") ?? "30");
      const validDays =
        daysParam === 7 || daysParam === 30 || daysParam === 90
          ? daysParam
          : 30;
      return {
        status: 200,
        body:
          state.childProgressAssessment ??
          makeChildProgressAssessment({ days: validDays }),
      };
    }

    // F-12: Reading History, Session Detail, Progress Reports, Difficult Words
    if (method === "GET" && pathname === "/reading/history") {
      return {
        status: 200,
        body: state.readingHistory ?? makeReadingHistoryList(),
      };
    }
    if (method === "GET" && /^\/reading\/history\/[^/]+$/.test(pathname)) {
      return {
        status: 200,
        body: state.sessionDetail ?? makeReadingSessionDetail(),
      };
    }
    if (
      method === "GET" &&
      /^\/reading\/history\/[^/]+\/book$/.test(pathname)
    ) {
      return {
        status: 200,
        body: makeCatalogBook(),
      };
    }
    if (
      method === "GET" &&
      /^\/reading\/sessions\/[^/]+\/reports$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.sessionReports ?? makeSessionReadingReports(),
      };
    }
    if (method === "GET" && /^\/reading\/pages\/[^/]+$/.test(pathname)) {
      return {
        status: 200,
        body: makeCatalogPagePreview(),
      };
    }
    if (
      method === "GET" &&
      /^\/system\/progress\/[^/]+\/periods$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.progressPeriods ?? makeProgressPeriods(),
      };
    }
    if (method === "GET" && /^\/system\/progress\/[^/]+$/.test(pathname)) {
      return {
        status: 200,
        body: state.progressReport ?? makeProgressReport(),
      };
    }
    if (
      method === "GET" &&
      /^\/system\/difficult-words\/[^/]+\/practice\/history$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.difficultWordHistory ?? makeDifficultWordHistory(),
      };
    }
    if (
      method === "POST" &&
      /^\/system\/difficult-words\/[^/]+\/practice\/start$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.difficultWordStart ?? makeDifficultWordPracticeAttempt(),
      };
    }
    if (
      method === "POST" &&
      /^\/system\/difficult-words\/[^/]+\/practice\/[^/]+\/evaluate-audio$/.test(
        pathname,
      )
    ) {
      return {
        status: 200,
        body: state.difficultWordEvaluate ?? makeDifficultWordPracticeAttempt(),
      };
    }
    if (
      method === "POST" &&
      /^\/system\/difficult-words\/[^/]+\/practice\/[^/]+\/complete$/.test(
        pathname,
      )
    ) {
      return {
        status: 200,
        body:
          state.difficultWordComplete ??
          makeDifficultWordPracticeAttempt({
            status: "COMPLETED",
            practice_status: "COMPLETED",
            completed_at: OPAQUE_C4_NOW_OFFSET,
          }),
      };
    }
    if (
      method === "GET" &&
      /^\/system\/difficult-words\/[^/]+$/.test(pathname)
    ) {
      const baseList = state.difficultWords ?? makeDifficultWordsList();
      const statusFilter = searchParams.get("status");
      if (statusFilter && Array.isArray(baseList.items)) {
        const filtered = (
          baseList.items as Array<Record<string, unknown>>
        ).filter((item) => item.practice_status === statusFilter);
        return { status: 200, body: { ...baseList, items: filtered } };
      }
      return { status: 200, body: baseList };
    }

    // F-13: Reading Management & Parent Email Preferences
    if (method === "GET" && pathname === "/reading-management/goals") {
      return { status: 200, body: { items: goals } };
    }
    if (method === "POST" && pathname === "/reading-management/goals") {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const created = makeReadingGoal({
        id: makeOpaqueUuid(goals.length + 310, "f1300000"),
        metric: body.metric ?? "MINUTES",
        target_value: body.target_value ?? 20,
        period: body.period ?? "DAILY",
        starts_on: body.starts_on ?? "2026-11-21",
        ends_on: body.ends_on ?? null,
      });
      goals.push(created);
      return { status: 201, body: created };
    }
    if (method === "GET" && pathname === "/reading-management/plans") {
      return { status: 200, body: { items: plans } };
    }
    if (method === "POST" && pathname === "/reading-management/plans") {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const created = makeReadingPlan({
        id: makeOpaqueUuid(plans.length + 320, "f1300000"),
        title: body.title ?? "Kế hoạch mới",
        target_minutes: body.target_minutes ?? 15,
        weekdays: body.weekdays ?? [1, 3, 5],
      });
      plans.push(created);
      return { status: 201, body: created };
    }
    if (method === "GET" && pathname === "/reading-management/collections") {
      return { status: 200, body: { items: collections } };
    }
    if (
      method === "PUT" &&
      /^\/reading-management\/collections\/[^/]+$/.test(pathname)
    ) {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const item = makeReadingCollection({
        id: makeOpaqueUuid(collections.length + 330, "f1300000"),
        collection_type: body.collection_type ?? "WANT_TO_READ",
      });
      collections.push(item);
      return { status: 200, body: item };
    }
    if (method === "GET" && pathname === "/reading-management/reminders") {
      return { status: 200, body: { items: reminders } };
    }
    if (method === "POST" && pathname === "/reading-management/reminders") {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const created = makeReadingReminder({
        id: makeOpaqueUuid(reminders.length + 340, "f1300000"),
        remind_at: body.remind_at ?? "20:00",
        weekdays: body.weekdays ?? [1, 2, 3, 4, 5],
        email_enabled: body.email_enabled ?? true,
      });
      reminders.push(created);
      return { status: 201, body: created };
    }
    if (method === "GET" && pathname === "/reading-management/reminders/due") {
      return { status: 200, body: { items: dueOccurrences } };
    }
    if (
      method === "POST" &&
      /^\/reading-management\/reminders\/occurrences\/[^/]+\/acknowledge$/.test(
        pathname,
      )
    ) {
      if (dueOccurrences[0]) {
        dueOccurrences[0] = {
          ...dueOccurrences[0],
          status: "ACKNOWLEDGED",
          acknowledged_at: OPAQUE_C4_NOW_OFFSET,
        };
      }
      return {
        status: 200,
        body:
          dueOccurrences[0] ??
          makeDueOccurrence({
            status: "ACKNOWLEDGED",
            acknowledged_at: OPAQUE_C4_NOW_OFFSET,
          }),
      };
    }
    if (method === "GET" && pathname === "/parent-notifications/preferences") {
      return { status: 200, body: prefs };
    }
    if (method === "PUT" && pathname === "/parent-notifications/preferences") {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      prefs = { ...prefs, ...body };
      return { status: 200, body: prefs };
    }
    if (method === "GET" && pathname === "/parent-notifications/history") {
      return {
        status: 200,
        body: state.parentHistory ?? makeParentNotificationHistory(),
      };
    }
    if (method === "POST" && pathname === "/parent-notifications/test-email") {
      return {
        status: 200,
        body: {
          sent: true,
          provider: "resend",
          recipient_masked: "p***@viread.local",
        },
      };
    }

    // F-14: Entertainment V4 & Adaptive Learning
    if (
      method === "GET" &&
      /^\/learning\/children\/[^/]+\/recommendations$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.recommendations ?? makeAdaptiveRecommendations(),
      };
    }
    if (
      method === "GET" &&
      /^\/learning\/children\/[^/]+\/parent-analytics$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.parentAnalytics ?? makeParentLearningAnalytics(),
      };
    }
    if (method === "GET" && pathname === "/games/sentence-shooter/books") {
      return {
        status: 200,
        body: state.shooterBooks ?? [makeSentenceShooterBook()],
      };
    }
    if (method === "POST" && pathname === "/games/sentence-shooter/sessions") {
      return {
        status: 201,
        body: state.shooterSession ?? makeSentenceShooterSession(),
      };
    }
    if (
      method === "POST" &&
      /^\/games\/sentence-shooter\/sessions\/[^/]+\/shots$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.shooterShot ?? makeSentenceShooterShotResult(),
      };
    }
    if (
      method === "POST" &&
      /^\/games\/sentence-shooter\/sessions\/[^/]+\/hints$/.test(pathname)
    ) {
      return {
        status: 200,
        body: {
          target_token_id: OPAQUE_C4_SHOOTER_TOKEN_1,
          hint_count: 1,
          message: "Thử chọn cụm từ chỉ sự vật đứng đầu câu nhé!",
        },
      };
    }
    if (
      method === "POST" &&
      /^\/games\/sentence-shooter\/sessions\/[^/]+\/next-round$/.test(pathname)
    ) {
      const nextSession = makeSentenceShooterSession({ completed_rounds: 1 });
      return {
        status: 200,
        body: {
          session_id: OPAQUE_C4_SHOOTER_SESSION_ID,
          completed_rounds: 1,
          total_rounds: 2,
          total_stars: 3,
          round: nextSession.round,
        },
      };
    }
    if (
      method === "GET" &&
      /^\/games\/sentence-shooter\/sessions\/[^/]+\/result$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.shooterResult ?? makeSentenceShooterResult(),
      };
    }
    if (
      method === "POST" &&
      /^\/games\/sentence-shooter\/sessions\/[^/]+\/abandon$/.test(pathname)
    ) {
      return {
        status: 200,
        body:
          state.shooterResult ??
          makeSentenceShooterResult({ status: "ABANDONED" }),
      };
    }
    if (method === "GET" && pathname === "/games/picture-description/catalog") {
      return {
        status: 200,
        body: state.pictureCatalog ?? makePictureDescriptionCatalog(apiBaseUrl),
      };
    }
    if (
      method === "GET" &&
      pathname === "/games/picture-description/sessions"
    ) {
      return { status: 200, body: [] };
    }
    if (
      method === "POST" &&
      pathname === "/games/picture-description/sessions"
    ) {
      return {
        status: 201,
        body: state.pictureSession ?? makePictureDescriptionSession(apiBaseUrl),
      };
    }
    if (
      method === "GET" &&
      /^\/games\/picture-description\/sessions\/[^/]+$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.pictureSession ?? makePictureDescriptionSession(apiBaseUrl),
      };
    }
    if (
      method === "POST" &&
      /^\/games\/picture-description\/sessions\/[^/]+\/evaluate$/.test(pathname)
    ) {
      return {
        status: 200,
        body:
          state.pictureEvaluate ??
          makePictureDescriptionEvaluateResponse(apiBaseUrl),
      };
    }
    if (method === "GET" && pathname === "/games/memory/themes") {
      return { status: 200, body: state.memoryThemes ?? makeMemoryThemes() };
    }
    if (method === "GET" && pathname === "/games/memory/sessions") {
      return { status: 200, body: [] };
    }
    if (method === "POST" && pathname === "/games/memory/sessions") {
      return {
        status: 201,
        body: state.memorySession ?? makeMemorySession(),
      };
    }
    if (
      method === "GET" &&
      /^\/games\/memory\/sessions\/[^/]+$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.memorySession ?? makeMemorySession(),
      };
    }
    if (
      method === "POST" &&
      /^\/games\/memory\/sessions\/[^/]+\/hint$/.test(pathname)
    ) {
      return {
        status: 200,
        body: {
          session: makeMemorySession({
            status: "RECALLING",
            hints_used: 1,
          }),
          hint_level: 1,
          hint_text: "Có một đồ vật tròn ở giữa vườn.",
          target_object_id: "obj-ball",
        },
      };
    }
    if (
      method === "POST" &&
      /^\/games\/memory\/sessions\/[^/]+\/peek$/.test(pathname)
    ) {
      return {
        status: 200,
        body: {
          session: makeMemorySession({
            status: "RECALLING",
            peek_used: 1,
          }),
          peek_seconds: 5,
          peek_used: 1,
        },
      };
    }
    if (
      method === "POST" &&
      /^\/games\/memory\/sessions\/[^/]+\/attempts$/.test(pathname)
    ) {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const stage = body.stage === "CREATIVE" ? "CREATIVE" : "RECALL";
      return {
        status: 200,
        body: state.memoryAttempt ?? makeMemoryAttemptResult(stage),
      };
    }

    // F-15: Karaoke Ecosystem (Parent & Admin)
    if (method === "GET" && pathname === "/karaoke/songs") {
      const items = state.karaokeSongs ?? [makeKaraokeSongCard()];
      return {
        status: 200,
        body: { items, total: items.length, limit: 12, offset: 0 },
      };
    }
    if (
      method === "GET" &&
      /^\/karaoke\/songs\/[^/]+\/playback$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.karaokePlayback ?? makeKaraokePlayback(apiBaseUrl),
      };
    }
    if (
      method === "GET" &&
      /^\/karaoke\/songs\/[^/]+\/musical-profile$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.karaokeMusicalProfile ?? makeKaraokeMusicalProfile(),
      };
    }
    if (method === "GET" && pathname === "/karaoke/practice-sessions") {
      return {
        status: 200,
        body: state.karaokePracticeHistory ?? {
          child_id: OPAQUE_CHILD_ID,
          song_id: OPAQUE_C4_KARAOKE_SONG_ID,
          best_full_song_score: 88,
          best_full_song_stars: 3,
          total_sessions: 1,
          items: [makeKaraokePracticeSession()],
          storage_ready: true,
        },
      };
    }
    if (method === "POST" && pathname === "/karaoke/practice-sessions") {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      return {
        status: 201,
        body:
          state.karaokePracticeSession ??
          makeKaraokePracticeSession({
            playback_rate:
              typeof body.playback_rate === "number"
                ? body.playback_rate
                : 0.85,
          }),
      };
    }
    if (
      method === "GET" &&
      pathname === "/karaoke/admin/processing-capabilities"
    ) {
      return {
        status: 200,
        body: state.adminCapabilities ?? makeAdminProcessingCapabilities(),
      };
    }
    if (method === "GET" && pathname === "/karaoke/admin/songs") {
      return {
        status: 200,
        body: {
          items: adminKaraokeSongs,
          total: adminKaraokeSongs.length,
          limit: 20,
          offset: 0,
        },
      };
    }
    if (
      method === "POST" &&
      pathname === "/karaoke/admin/songs/simple-import"
    ) {
      return {
        status: 201,
        body: state.simpleImportResult ?? makeSimpleImportResult(),
      };
    }
    if (
      method === "GET" &&
      /^\/karaoke\/admin\/songs\/[^/]+\/simple-processing$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.simpleProcessingStatus ?? makeSimpleProcessingStatus(),
      };
    }
    if (
      method === "POST" &&
      /^\/karaoke\/admin\/songs\/[^/]+\/simple-processing$/.test(pathname)
    ) {
      return {
        status: 200,
        body: state.simpleProcessingStatus ?? makeSimpleProcessingStatus(),
      };
    }
    if (
      method === "POST" &&
      /^\/karaoke\/admin\/songs\/[^/]+\/simple-publish$/.test(pathname)
    ) {
      adminKaraokeDetail = makeAdminKaraokeSongDetail({
        status: "PUBLISHED",
        revision: 2,
      });
      return { status: 200, body: adminKaraokeDetail };
    }
    if (
      method === "GET" &&
      /^\/karaoke\/admin\/songs\/[^/]+\/processing-jobs$/.test(pathname)
    ) {
      return {
        status: 200,
        body: { items: [], total: 0, limit: 20, offset: 0 },
      };
    }
    if (method === "GET" && /^\/karaoke\/admin\/songs\/[^/]+$/.test(pathname)) {
      return { status: 200, body: adminKaraokeDetail };
    }
    if (
      method === "PUT" &&
      /^\/karaoke\/admin\/songs\/[^/]+\/draft$/.test(pathname)
    ) {
      const rev =
        typeof adminKaraokeDetail.revision === "number"
          ? adminKaraokeDetail.revision + 1
          : 2;
      adminKaraokeDetail = { ...adminKaraokeDetail, revision: rev };
      return { status: 200, body: adminKaraokeDetail };
    }
    if (
      method === "POST" &&
      /^\/karaoke\/admin\/songs\/[^/]+\/publish$/.test(pathname)
    ) {
      const rev =
        typeof adminKaraokeDetail.revision === "number"
          ? adminKaraokeDetail.revision + 1
          : 2;
      adminKaraokeDetail = {
        ...adminKaraokeDetail,
        status: "PUBLISHED",
        revision: rev,
      };
      return { status: 200, body: adminKaraokeDetail };
    }
    if (
      method === "PATCH" &&
      /^\/karaoke\/admin\/songs\/[^/]+\/visibility$/.test(pathname)
    ) {
      const body = (ctx.postDataJson ?? {}) as Record<string, unknown>;
      const nextStatus = body.visible === false ? "HIDDEN" : "PUBLISHED";
      const rev =
        typeof adminKaraokeDetail.revision === "number"
          ? adminKaraokeDetail.revision + 1
          : 2;
      adminKaraokeDetail = {
        ...adminKaraokeDetail,
        status: nextStatus,
        revision: rev,
      };
      return { status: 200, body: adminKaraokeDetail };
    }

    // F-16: AI Assistant Chatbot
    if (method === "GET" && pathname === "/assistant/status") {
      return {
        status: 200,
        body: state.assistantStatus ?? makeAssistantStatus(),
      };
    }
    if (method === "GET" && pathname === "/assistant/context") {
      return {
        status: 200,
        body: state.assistantContext ?? makeAssistantContext(),
      };
    }
    if (method === "POST" && pathname === "/assistant/chat") {
      const defaultScope =
        state.role === "admin"
          ? "admin"
          : ctx.headers.authorization
            ? "parent"
            : "public";
      return {
        status: 200,
        body:
          state.assistantReply ??
          makeAssistantChatReply({ role_scope: defaultScope }),
      };
    }

    // F-21: Admin Health & Audit Logs
    if (method === "GET" && pathname === "/system/admin/health") {
      return {
        status: 200,
        body: state.adminHealthSnapshot ?? makeCluster4AdminHealthSnapshot(),
      };
    }
    if (
      method === "POST" &&
      pathname === "/system/admin/health/ocr-worker/wakeup"
    ) {
      return {
        status: 200,
        body: {
          accepted: true,
          status: "waking",
          message: "Đã gửi lệnh đánh thức worker OCR.",
        },
      };
    }
    if (method === "GET" && pathname === "/system/admin/audit-logs") {
      return {
        status: 200,
        body: state.adminAuditLogs ?? makeAdminAuditLogsPage(),
      };
    }

    // F-22: Support & Feedback
    if (method === "POST" && pathname === "/support/feedback") {
      return {
        status: 202,
        body: state.supportFeedbackResponse ?? makeSupportFeedbackAccepted(),
      };
    }

    return null;
  };

  return [
    ...(state.customRoutes ?? []),
    c4Handler,
    ...makeCluster3DefaultHandlers({
      healthPayload: state.healthPayload,
      sessionDetail: state.sessionDetail,
    }),
  ];
}

export async function installCluster4ParentMocks(
  page: Page,
  state: Cluster4HandlerState = {},
): Promise<ApiMockHandle> {
  return installApiMock(
    page,
    makeCluster4DefaultHandlers({ ...state, role: state.role ?? "parent" }),
    { unmatchedMode: "default-mock" },
  );
}

export async function installCluster4AdminMocks(
  page: Page,
  state: Cluster4HandlerState = {},
): Promise<ApiMockHandle> {
  return installApiMock(
    page,
    makeCluster4DefaultHandlers({ ...state, role: "admin" }),
    { unmatchedMode: "default-mock" },
  );
}
