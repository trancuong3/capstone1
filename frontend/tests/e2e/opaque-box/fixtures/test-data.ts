import { deflateSync } from "node:zlib";

export const OPAQUE_PARENT_ID = "11111111-1111-4111-8111-111111111111";
export const OPAQUE_ADMIN_ID = "88000000-0000-4000-8000-000000000001";
export const OPAQUE_CHILD_ID = "92000000-0000-4000-8000-000000000001";
export const OPAQUE_BOOK_ID = "82000000-0000-4000-8000-000000000010";
export const OPAQUE_PAGE_ID = "83000000-0000-4000-8000-000000000011";
export const OPAQUE_REV_ID = "84000000-0000-4000-8000-000000000011";
export const OPAQUE_REV_3_ID = "84000000-0000-4000-8000-000000000013";
export const OPAQUE_SESSION_ID = "72000000-0000-4000-8000-000000000001";
export const OPAQUE_REPORT_ID = "85000000-0000-4000-8000-000000000011";
export const OPAQUE_TASK_ID = "86000000-0000-4000-8000-000000000001";

export const OPAQUE_SUPABASE_URL = "https://example.supabase.co";
export const OPAQUE_SUPABASE_COOKIE_NAME = "sb-example-auth-token";
export const OPAQUE_CRON_SECRET = "viread_opaque_cron_secret_0123456789abcdef";
export const OPAQUE_NOW_ISO = "2026-11-21T10:00:00Z";

export const OVERSIZED_AVATAR_BYTES = 5 * 1024 * 1024 + 1024;
export const OVERSIZED_SCAN_BYTES = 12 * 1024 * 1024 + 1024;

export function makeOpaqueUuid(index: number, prefixHex = "00000000"): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`Expected non-negative integer index, got ${index}`);
  }
  const cleanPrefix = prefixHex
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "0")
    .padStart(8, "0")
    .slice(0, 8);
  const tail = index.toString(16).padStart(12, "0").slice(-12);
  return `${cleanPrefix}-0000-4000-8000-${tail}`;
}

export interface HealthPayload {
  status: "ok" | "degraded";
  version: string;
  ocr_mode: "remote_worker" | "local_inprocess";
  database: {
    status: "healthy" | "unavailable";
  };
  ocr: {
    mode: "remote_worker" | "local_inprocess";
    ready: boolean;
    engines: Record<string, string>;
    workers: Array<{ online: boolean }>;
    queue: { queued: number };
    heartbeat_ttl_seconds: number;
    probe_degraded?: boolean;
  };
  workers?: Record<string, string>;
}

export function makeHealthPayload(
  overrides: Partial<HealthPayload> = {},
): HealthPayload {
  return {
    status: "ok",
    version: "1.0.0-opaque",
    ocr_mode: "remote_worker",
    database: { status: "healthy" },
    ocr: {
      mode: "remote_worker",
      ready: true,
      engines: {
        paddleocr: "ready",
        vietocr: "ready",
      },
      workers: [{ online: true }],
      queue: { queued: 0 },
      heartbeat_ttl_seconds: 45,
      probe_degraded: false,
    },
    workers: {
      ocr: "healthy",
    },
    ...overrides,
  };
}

export interface ParentProfileChildPayload {
  id: string;
  alias: string;
  grade: number;
  created_at: string;
  avatar_url?: string | null;
}

export interface ParentProfilePayload {
  id: string;
  display_name: string | null;
  role: "parent" | "admin";
  created_at: string;
  email: string | null;
  contact_phone: string | null;
  pending_email: string | null;
  email_verified: boolean | null;
  contact_info_status:
    "available" | "not_configured" | "user_not_found" | "lookup_failed";
  children: ParentProfileChildPayload[];
  avatar_url: string | null;
}

export interface ChildProfilePayload {
  id: string;
  parent_id: string;
  alias: string;
  grade: number;
  settings: Record<string, unknown>;
  created_at: string;
  avatar_url: string | null;
}

export function makeChildProfile(
  overrides: Partial<ChildProfilePayload> = {},
): ChildProfilePayload {
  return {
    id: OPAQUE_CHILD_ID,
    parent_id: OPAQUE_PARENT_ID,
    alias: "Bé An",
    grade: 2,
    settings: {},
    created_at: OPAQUE_NOW_ISO,
    avatar_url: null,
    ...overrides,
  };
}

export function makeParentProfile(
  overrides: Partial<ParentProfilePayload> = {},
): ParentProfilePayload {
  const defaultChild = makeChildProfile();
  return {
    id: OPAQUE_PARENT_ID,
    display_name: "Phụ huynh Kiểm thử",
    role: "parent",
    created_at: OPAQUE_NOW_ISO,
    email: "parent@viread.local",
    contact_phone: "+84901234567",
    pending_email: null,
    email_verified: true,
    contact_info_status: "available",
    children: [
      {
        id: defaultChild.id,
        alias: defaultChild.alias,
        grade: defaultChild.grade,
        created_at: defaultChild.created_at,
        avatar_url: defaultChild.avatar_url,
      },
    ],
    avatar_url: null,
    ...overrides,
  };
}

export interface DashboardLatestSessionPayload {
  id: string;
  session_id?: string;
  child_id: string;
  book_id: string;
  book_title: string | null;
  title?: string | null;
  state: string;
  started_at: string | null;
  ended_at: string | null;
  resumable: boolean;
}

export interface DashboardSummaryPayload {
  profile: ParentProfilePayload | null;
  children: ChildProfilePayload[];
  latest_sessions_by_child: Record<
    string,
    DashboardLatestSessionPayload | null
  >;
}

export function makeDashboardSummary(
  overrides: Partial<DashboardSummaryPayload> = {},
): DashboardSummaryPayload {
  const child = makeChildProfile();
  const profile = makeParentProfile({
    children: [
      {
        id: child.id,
        alias: child.alias,
        grade: child.grade,
        created_at: child.created_at,
        avatar_url: child.avatar_url,
      },
    ],
  });
  return {
    profile,
    children: [child],
    latest_sessions_by_child: {
      [child.id]: null,
    },
    ...overrides,
  };
}

export interface CatalogBookPayload {
  id: string;
  title: string;
  author: string | null;
  min_grade: number;
  max_grade: number;
  lifecycle_status: "ACTIVE" | "RETIRED";
  visibility_scope: "CATALOG" | "PARENT_PRIVATE";
  cover_url: string | null;
  cover_source_type: "USER_UPLOAD" | "AI_GENERATED" | "METADATA_RENDER" | null;
}

export function makeCatalogBook(
  overrides: Partial<CatalogBookPayload> = {},
): CatalogBookPayload {
  return {
    id: OPAQUE_BOOK_ID,
    title: "Chú Mèo Đi Hia",
    author: "ViRead",
    min_grade: 1,
    max_grade: 3,
    lifecycle_status: "ACTIVE",
    visibility_scope: "CATALOG",
    cover_url: null,
    cover_source_type: null,
    ...overrides,
  };
}

export interface CatalogPagePreviewPayload {
  page_id: string;
  page_number: number;
  lifecycle_status: "ACTIVE";
  current_verified_revision_id: string;
  preview_url: string;
  tts_audio_url?: string | null;
}

export function makeCatalogPagePreview(
  overrides: Partial<CatalogPagePreviewPayload> = {},
): CatalogPagePreviewPayload {
  return {
    page_id: OPAQUE_PAGE_ID,
    page_number: 1,
    lifecycle_status: "ACTIVE",
    current_verified_revision_id: OPAQUE_REV_ID,
    preview_url:
      "https://example.supabase.co/storage/v1/object/public/book-pages/page-1.png",
    tts_audio_url: null,
    ...overrides,
  };
}

export interface AdminCatalogBookPayload {
  id: string;
  name: string | null;
  title: string;
  author: string | null;
  min_grade: number;
  max_grade: number;
  lifecycle_status: "ACTIVE" | "RETIRED";
  cover_url: string | null;
  cover_source_type: "USER_UPLOAD" | "AI_GENERATED" | "METADATA_RENDER" | null;
}

export interface AdminCatalogItemPayload {
  book: AdminCatalogBookPayload;
  page_count: number;
  processing_count: number;
  needs_review_count: number;
  verified_count: number;
  parent_catalog_eligible: boolean;
}

export function makeAdminCatalogItem(
  overrides: Partial<AdminCatalogItemPayload> = {},
): AdminCatalogItemPayload {
  const defaultBook: AdminCatalogBookPayload = {
    id: OPAQUE_BOOK_ID,
    name: "chu-meo-di-hia",
    title: "Chú Mèo Đi Hia",
    author: "ViRead",
    min_grade: 1,
    max_grade: 3,
    lifecycle_status: "ACTIVE",
    cover_url: null,
    cover_source_type: null,
  };
  return {
    book: overrides.book ?? defaultBook,
    page_count: 5,
    processing_count: 0,
    needs_review_count: 0,
    verified_count: 5,
    parent_catalog_eligible: true,
    ...overrides,
  };
}

export interface AdminHealthServiceItemPayload {
  id: string;
  label: string;
  status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  operational_state?:
    | "Healthy"
    | "Degraded"
    | "Offline"
    | "Queued"
    | "Quota exhausted"
    | "Unsupported"
    | "Unknown"
    | "Standby"
    | "Scheduled"
    | "Local only"
    | null;
  checked_at: string;
  safe_message: string;
  detail_status?:
    | "installed"
    | "initialized"
    | "loaded"
    | "healthy"
    | "failed"
    | "unknown"
    | "disabled"
    | "standby"
    | "cached"
    | "client_side"
    | "cloud_ready"
    | "scheduled"
    | "remote_delegated"
    | "local_only"
    | null;
  last_success_at?: string | null;
  oldest_pending_job_age_seconds?: number | null;
  queue_depth?: number | null;
  last_error?: string | null;
  service_group?: "core" | "voice" | "ocr" | "workers" | null;
  execution_mode?:
    | "always_on"
    | "in_process"
    | "on_demand"
    | "cron_scheduled"
    | "remote_worker"
    | "remote_delegated"
    | "precomputed_cache"
    | "browser_wasm"
    | "cloud_ai"
    | "local_only"
    | "disabled_opt_in"
    | null;
  criticality?: "core" | "important" | "optional" | null;
  action_hint?: string | null;
  can_wake?: boolean;
}

export interface AdminHealthSnapshotPayload {
  overall_status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  checked_at: string;
  services: AdminHealthServiceItemPayload[];
  audio_cache: {
    entry_count: number;
    storage_used_bytes: number;
    storage_quota_bytes: number;
    daily_egress_bytes: number;
    daily_egress_limit_bytes: number | null;
    cache_hit_ratio: number | null;
    quota_exhausted: boolean;
  } | null;
  audio_cache_error: string | null;
}

export function makeAdminHealthSnapshot(
  overrides: Partial<AdminHealthSnapshotPayload> = {},
): AdminHealthSnapshotPayload {
  return {
    overall_status: "HEALTHY",
    checked_at: OPAQUE_NOW_ISO,
    services: [
      {
        id: "api",
        label: "Hệ thống xử lý chính",
        status: "HEALTHY",
        operational_state: "Healthy",
        checked_at: OPAQUE_NOW_ISO,
        safe_message: "Dịch vụ đang hoạt động ổn định.",
        detail_status: "healthy",
        last_success_at: OPAQUE_NOW_ISO,
        service_group: "core",
        execution_mode: "always_on",
        criticality: "core",
        can_wake: false,
      },
      {
        id: "ocr_worker",
        label: "Dịch vụ nhận diện chữ",
        status: "HEALTHY",
        operational_state: "Healthy",
        checked_at: OPAQUE_NOW_ISO,
        safe_message: "Dịch vụ nhận diện chữ sẵn sàng.",
        detail_status: "healthy",
        last_success_at: OPAQUE_NOW_ISO,
        queue_depth: 0,
        service_group: "ocr",
        execution_mode: "remote_worker",
        criticality: "important",
        can_wake: true,
      },
    ],
    audio_cache: {
      entry_count: 12,
      storage_used_bytes: 1024 * 512,
      storage_quota_bytes: 1024 * 1024 * 100,
      daily_egress_bytes: 1024 * 128,
      daily_egress_limit_bytes: 1024 * 1024 * 500,
      cache_hit_ratio: 0.85,
      quota_exhausted: false,
    },
    audio_cache_error: null,
    ...overrides,
  };
}

export interface GlobalTaskItemPayload {
  id: string;
  source:
    | "smart_studio_job"
    | "ocr_inference_job"
    | "admin_ai_workflow"
    | "parent_submission";
  job_type: string;
  title_vi: string;
  book_id: string | null;
  book_page_id: string | null;
  book_title: string | null;
  page_number: number | null;
  source_revision_id: string | null;
  actor_role: "admin" | "parent";
  status:
    | "QUEUED"
    | "RUNNING"
    | "WAITING_FOR_WORKER"
    | "WAITING_FOR_QUOTA"
    | "WAITING_FOR_REVIEW"
    | "RETRY_SCHEDULED"
    | "PARTIAL_SUCCESS"
    | "SUCCEEDED"
    | "FAILED"
    | "CANCEL_REQUESTED"
    | "CANCELLED"
    | "STALE";
  status_label_vi: string;
  stage: string;
  stage_label_vi: string;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  progress_completed: number | null;
  progress_total: number | null;
  progress_unit: string | null;
  progress_pct: number | null;
  is_indeterminate: boolean;
  can_retry: boolean;
  can_cancel: boolean;
  result_href: string | null;
  result_ref: Record<string, unknown>;
  checkpoints: Record<string, unknown>;
  error_code: string | null;
  error_message_vi: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface GlobalTaskListPayload {
  actor_id: string;
  actor_role: "admin" | "parent";
  active_count: number;
  waiting_review_count: number;
  failed_count: number;
  completed_count: number;
  worker_online: boolean | null;
  recommended_poll_ms: number | null;
  tasks: GlobalTaskItemPayload[];
}

export function makeGlobalTaskList(
  overrides: Partial<GlobalTaskListPayload> = {},
): GlobalTaskListPayload {
  return {
    actor_id: OPAQUE_PARENT_ID,
    actor_role: "parent",
    active_count: 0,
    waiting_review_count: 0,
    failed_count: 0,
    completed_count: 0,
    worker_online: true,
    recommended_poll_ms: 15_000,
    tasks: [],
    ...overrides,
  };
}

export interface AssistantTierStatusPayload {
  tier: string;
  provider_id: string;
  family: string;
  model_id: string | null;
  is_local: boolean;
  enabled: boolean;
  available_now: boolean;
  circuit_state: string;
  notes: string;
}

export interface AssistantStatusPayload {
  enabled: boolean;
  allow_public_llm: boolean;
  tiers: AssistantTierStatusPayload[];
  cache_entries: number;
  kb_article_count: number;
  bandwidth_profiles: Record<string, Record<string, unknown>>;
}

export function makeAssistantStatus(
  overrides: Partial<AssistantStatusPayload> = {},
): AssistantStatusPayload {
  return {
    enabled: true,
    allow_public_llm: false,
    tiers: [
      {
        tier: "tier_0_kb",
        provider_id: "kb-local",
        family: "knowledge_base",
        model_id: null,
        is_local: true,
        enabled: true,
        available_now: true,
        circuit_state: "closed",
        notes: "Local FAQ match",
      },
    ],
    cache_entries: 0,
    kb_article_count: 18,
    bandwidth_profiles: {
      low: { max_tokens: 120 },
      medium: { max_tokens: 240 },
      high: { max_tokens: 480 },
    },
    ...overrides,
  };
}

export interface AssistantQuickActionPayload {
  label: string;
  href: string;
}

export interface AssistantContextPayload {
  current_path: string;
  page_title: string;
  greeting: string;
  suggested_prompts: string[];
  quick_actions: AssistantQuickActionPayload[];
}

export function makeAssistantContext(
  overrides: Partial<AssistantContextPayload> = {},
): AssistantContextPayload {
  return {
    current_path: "/dashboard",
    page_title: "Tổng quan",
    greeting:
      "Xin chào! Mình có thể hỗ trợ ba mẹ chọn sách hoặc xem tiến bộ của bé.",
    suggested_prompts: [
      "Cách chọn sách phù hợp cho bé?",
      "Xem báo cáo buổi đọc ở đâu?",
    ],
    quick_actions: [{ label: "Mở tủ sách", href: "/books" }],
    ...overrides,
  };
}

export interface AssistantChatReplyPayload {
  reply: string;
  source_tier:
    | "cache"
    | "tier_0_kb"
    | "tier_1_cloud"
    | "tier_2_ollama"
    | "tier_3_fallback";
  provider_id: string;
  model_id: string | null;
  bandwidth_applied: "low" | "medium" | "high";
  latency_ms: number;
  cached: boolean;
  role_scope: "public" | "parent" | "admin";
  quick_actions: AssistantQuickActionPayload[];
  suggested_prompts: string[];
}

export function makeAssistantChatReply(
  overrides: Partial<AssistantChatReplyPayload> = {},
): AssistantChatReplyPayload {
  return {
    reply: "Ba mẹ có thể mở mục Tủ sách để chọn truyện theo lớp của bé.",
    source_tier: "tier_0_kb",
    provider_id: "kb-local",
    model_id: null,
    bandwidth_applied: "high",
    latency_ms: 8,
    cached: false,
    role_scope: "parent",
    quick_actions: [{ label: "Mở tủ sách", href: "/books" }],
    suggested_prompts: ["Cách tạo hồ sơ bé?"],
    ...overrides,
  };
}

export interface CronDispatchResponsePayload {
  scope: "all" | "reminders" | "presence" | "engagement";
  delivery_configured: boolean;
  delivery_provider: string;
  presence_sent: number;
  reminders_sent: number;
  engagement_sent: number;
  checked_at: string;
}

export function makeCronDispatchResponse(
  overrides: Partial<CronDispatchResponsePayload> = {},
): CronDispatchResponsePayload {
  return {
    scope: "all",
    delivery_configured: true,
    delivery_provider: "resend",
    presence_sent: 0,
    reminders_sent: 0,
    engagement_sent: 0,
    checked_at: OPAQUE_NOW_ISO,
    ...overrides,
  };
}

export interface ReadingHistorySummaryPayload {
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
    | "ABORTED"
    | "IN_PROGRESS";
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
}

export interface ReadingHistoryListPayload {
  sessions: ReadingHistorySummaryPayload[];
  next_cursor: string | null;
}

export function makeReadingHistoryList(
  overrides: Partial<ReadingHistoryListPayload> = {},
): ReadingHistoryListPayload {
  return {
    sessions: [
      {
        id: OPAQUE_SESSION_ID,
        child_id: OPAQUE_CHILD_ID,
        book_id: OPAQUE_BOOK_ID,
        state: "FINISHED",
        started_at: "2026-11-21T09:50:00Z",
        ended_at: OPAQUE_NOW_ISO,
        duration_ms: 600_000,
      },
    ],
    next_cursor: null,
    ...overrides,
  };
}

export interface ReadingSessionDetailPayload extends ReadingHistorySummaryPayload {
  assessment: null;
  selected_range_pages: number | null;
  pages_completed: number | null;
  selected_page_revision_ids: string[];
  reference_page_revision_ids: string[];
  events: Array<{
    id: string;
    session_id: string;
    page_id: string;
    page_revision_id: string;
    page_revision_word_id: string | null;
    type:
      | "OMISSION"
      | "REPETITION"
      | "LONG_PAUSE"
      | "SUBSTITUTION"
      | "SELF_CORRECTION"
      | "READ_EXAMPLE"
      | "MISPRONUNCIATION"
      | "WORD_RETRY";
    status:
      | "CANDIDATE"
      | "CONFIRMED"
      | "FAILED"
      | "UNCERTAIN"
      | "DISMISSED"
      | "DETECTED"
      | "FEEDBACK_GIVEN"
      | "IGNORED_BY_GATE";
    start_ms: number;
    end_ms: number | null;
    confidence: number | null;
    metadata: Record<string, unknown>;
  }>;
  fluency_assessment: null;
  comprehension: never[];
  report_id: string | null;
  availability: {
    events: "absent" | "available" | "partial" | "unsupported";
    fluency: "absent" | "available" | "partial" | "unsupported";
    comprehension: "absent" | "available" | "partial" | "unsupported";
  };
}

export function makeReadingSessionDetail(
  overrides: Partial<ReadingSessionDetailPayload> = {},
): ReadingSessionDetailPayload {
  return {
    id: OPAQUE_SESSION_ID,
    child_id: OPAQUE_CHILD_ID,
    book_id: OPAQUE_BOOK_ID,
    state: "FINISHED",
    started_at: "2026-11-21T09:50:00Z",
    ended_at: OPAQUE_NOW_ISO,
    duration_ms: 600_000,
    assessment: null,
    selected_range_pages: 1,
    pages_completed: 1,
    selected_page_revision_ids: [OPAQUE_REV_ID],
    reference_page_revision_ids: [OPAQUE_REV_ID],
    events: [],
    fluency_assessment: null,
    comprehension: [],
    report_id: OPAQUE_REPORT_ID,
    availability: {
      events: "available",
      fluency: "absent",
      comprehension: "absent",
    },
    ...overrides,
  };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    const index = (crc ^ byte) & 0xff;
    crc = (CRC32_TABLE[index] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

export function makeMinimalPngBuffer(): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idatData = deflateSync(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]));
  return Buffer.concat([
    signature,
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", idatData),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function makeMinimalWebpBuffer(): Buffer {
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x20, 0x18, 0x00, 0x00, 0x00, 0x30, 0x01, 0x00, 0x9d,
    0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00, 0x34, 0x25, 0xa4, 0x00,
    0x03, 0x70, 0x00, 0xfe, 0xfb, 0xfd, 0x50, 0x00,
  ]);
}

export function makeMinimalPdfBuffer(text = "ViRead"): Buffer {
  const escaped = text.replace(/[()\\]/g, "\\$&");
  const streamContent = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(streamContent, "utf8")} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    const offsetStr = String(offsets[i] ?? 0).padStart(10, "0");
    pdf += `${offsetStr} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

export function makeMinimalWavBuffer(
  durationMs = 250,
  sampleRate = 16_000,
): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const numSamples = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = numSamples * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM subchunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i += 1) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 4000,
    );
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}

export function makeOversizedBuffer(bytes: number, fillByte = 0x41): Buffer {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new RangeError(`Expected positive integer byte length, got ${bytes}`);
  }
  return Buffer.alloc(bytes, fillByte);
}

export const OPAQUE_VIETNAMESE_TEXT_SAMPLES = [
  "Bé An đọc truyện Mèo con đi hia ở đồng cỏ xanh ngắt.",
  "Tiếng Việt có thanh huyền, sắc, hỏi, ngã, nặng và chữ đ, ă, â, ê, ô, ơ, ư.",
  "Mỗi tối cả nhà cùng luyện đọc rõ chữ, đúng nhịp và ngắt nghỉ tự nhiên.",
] as const;

export const OPAQUE_RTL_TEXT_SAMPLES = {
  ar: "مرحبًا بكم في منصة في ريد لقراءة الأطفال.",
  he: "ברוכים הבאים למערכת הקריאה המודרכת לילדים.",
} as const;

export const OPAQUE_INVALID_LOCALE_VECTORS = [
  "../../etc/passwd",
  "<script>alert(1)</script>",
  "vi; Path=/admin",
  "xx-INVALID-LOCALE-999999999999999999",
  "en\u0000vi",
] as const;

export const OPAQUE_UNSAFE_NEXT_PATHS = [
  "//evil.example.com/phish",
  "https://evil.example.com/steal",
  "http://127.0.0.1:9999/escape",
  "javascript:alert(1)",
  "/\\evil.example.com",
  "/%2f/evil.example.com",
] as const;
