import { expect, type Page, type Route } from "@playwright/test";
import { createPlaywrightAuthFixtureHeaders } from "../../lib/auth/playwright-auth-fixture";
import type { VoiceEngineHealthSnapshot } from "../../lib/reading/voice-engine-status";
import type { ProcessingCapabilities } from "../../types/karaoke-processing";

export const PLAYWRIGHT_ORIGIN = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3106"}`;

export function readyVoiceStatus(
  defaultVoiceId: string,
): VoiceEngineHealthSnapshot {
  return {
    default_mode: "local_only",
    default_voice_id: defaultVoiceId,
    local: { available: true, stt_ready: true, tts_ready: true },
    google: {
      stt_configured: false,
      tts_configured: false,
      stt_cooldown: false,
      tts_cooldown: false,
    },
  };
}

const FIXTURE_LOCAL_VOICES = [
  {
    voice_id: "local_north_truc_ly",
    name: "Cô Trúc Ly",
    provider: "local",
    region: "north",
    region_label: "Miền Bắc",
    model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
    category: "local_neural",
    gender: "female",
    accent: "Miền Bắc",
    use_case: "reading_coach",
    description: "Miền Bắc · Nữ · Tự nhiên, ấm áp",
    preview_url: null,
    is_default: true,
  },
  {
    voice_id: "local_north_ngoc_linh",
    name: "Cô Ngọc Linh",
    provider: "local",
    region: "north",
    region_label: "Miền Bắc",
    model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
    category: "local_neural",
    gender: "female",
    accent: "Miền Bắc",
    use_case: "storytelling",
    description: "Miền Bắc · Nữ · Kể chuyện dịu dàng",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "local_north_thien_minh",
    name: "Thầy Thiện Minh",
    provider: "local",
    region: "north",
    region_label: "Miền Bắc",
    model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
    category: "local_neural",
    gender: "male",
    accent: "Miền Bắc",
    use_case: "storytelling",
    description: "Miền Bắc · Nam · Kể chuyện truyền cảm",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "local_central_ngoc_tran",
    name: "Cô Ngọc Trân",
    provider: "local",
    region: "central",
    region_label: "Miền Trung",
    model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
    category: "local_neural",
    gender: "female",
    accent: "Miền Trung",
    use_case: "reading_coach",
    description: "Miền Trung · Nữ · Tự nhiên, dịu dàng",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "local_central_quang_son",
    name: "Thầy Quang Sơn",
    provider: "local",
    region: "central",
    region_label: "Miền Trung",
    model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
    category: "local_neural",
    gender: "male",
    accent: "Miền Trung",
    use_case: "reading_coach",
    description: "Miền Trung · Nam · Tự nhiên, rõ chữ",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "local_south_thuc_doan",
    name: "Cô Thục Đoan",
    provider: "local",
    region: "south",
    region_label: "Miền Nam",
    model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
    category: "local_neural",
    gender: "female",
    accent: "Miền Nam",
    use_case: "storytelling",
    description: "Miền Nam · Nữ · Kể chuyện ấm áp",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "local_south_my_duyen",
    name: "Cô Mỹ Duyên",
    provider: "local",
    region: "south",
    region_label: "Miền Nam",
    model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
    category: "local_neural",
    gender: "female",
    accent: "Miền Nam",
    use_case: "storytelling",
    description: "Miền Nam · Nữ · Đọc truyện thiếu nhi",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "local_south_thai_son",
    name: "Thầy Thái Sơn",
    provider: "local",
    region: "south",
    region_label: "Miền Nam",
    model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
    category: "local_neural",
    gender: "male",
    accent: "Miền Nam",
    use_case: "storytelling",
    description: "Miền Nam · Nam · Kể chuyện rõ ràng",
    preview_url: null,
    is_default: false,
  },
] as const;

export const ids = {
  parent: "11111111-1111-4111-8111-111111111111",
  child: "22222222-2222-4222-8222-222222222222",
  book: "33333333-3333-4333-8333-333333333333",
  session: "44444444-4444-4444-8444-444444444444",
  page: "55555555-5555-4555-8555-555555555555",
  revision: "66666666-6666-4666-8666-666666666666",
  oldRevision: "77777777-7777-4777-8777-777777777777",
  draftRevision: "88888888-8888-4888-8888-888888888888",
};
const timestamp = "2026-10-08T00:00:00Z";
export const child = {
  id: ids.child,
  parent_id: ids.parent,
  alias: "Bé API",
  grade: 2,
  settings: {},
  created_at: timestamp,
};
export const book = {
  id: ids.book,
  name: "Tên sách từ API",
  title: "Câu chuyện từ API",
  author: "Tác giả API",
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "ACTIVE",
};
const processing = {
  page_id: ids.page,
  page_revision_id: ids.revision,
  revision_no: 2,
  verification_status: "VERIFIED",
  lifecycle_status: "ACTIVE",
  ocr_preview_metadata: {},
  verified_at: timestamp,
  current_verified_revision_id: ids.revision,
};
const summary = {
  id: ids.session,
  child_id: ids.child,
  book_id: ids.book,
  state: "ABORTED",
  started_at: timestamp,
  ended_at: null,
  duration_ms: null,
};
const word = {
  normalized_word: "meo",
  display_text: "Mèo API",
  difficulty_score: 3,
  omission_count: 1,
  repetition_count: 0,
  long_pause_count: 0,
  read_example_count: 0,
  session_count: 1,
  last_seen_at: timestamp,
  evidence_word_ids: [ids.revision],
};

export interface BrowserApiState {
  catalogStatus: number;
  emptyCatalog: boolean;
  emptyChildren: boolean;
  reportStatus: number;
  previewStatus: number;
  adminPagesStatus: number;
  historyStatus: number;
  unexpected: string[];
  requests: string[];
  createBookRequest: {
    name: string;
    title: string;
    author: string | null;
    min_grade: number;
    max_grade: number;
  } | null;
  createdBook: {
    id: string;
    name: string;
    title: string;
    author: string | null;
    min_grade: number;
    max_grade: number;
    lifecycle_status: "ACTIVE";
  } | null;
  draftCreateSourceRevisionId: string | null;
  aiCorrectionText: string | null;
  workflowRequest: Record<string, unknown> | null;
  candidateRequest: Record<string, unknown> | null;
  safetyDecisionRequest: Record<string, unknown> | null;
  draftSaveRequest: Record<string, unknown> | null;
  verifyRequest: Record<string, unknown> | null;
}

export async function setRole(page: Page, role: "parent" | "admin") {
  const fixtureToken = process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN;
  if (!fixtureToken) throw new Error("Missing isolated auth fixture token");
  await page.setExtraHTTPHeaders(
    createPlaywrightAuthFixtureHeaders(role, fixtureToken),
  );
}

/** Unverified SDK session only, accepted solely by the intercepted test API. */
async function seedBrowserSession(page: Page) {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(
    JSON.stringify({
      sub: ids.parent,
      exp: expiry,
      aud: "authenticated",
      role: "authenticated",
    }),
  ).toString("base64url");
  const session = {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.isolated-test-signature`,
    refresh_token: "isolated-test-refresh",
    token_type: "bearer",
    expires_at: expiry,
    expires_in: 3600,
    user: {
      id: ids.parent,
      aud: "authenticated",
      role: "authenticated",
      email: "parent@example.test",
      app_metadata: {},
      user_metadata: { display_name: "Ba mẹ API" },
      created_at: timestamp,
    },
  };
  await page.context().addCookies([
    {
      name: "sb-example-auth-token",
      value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
      expires: expiry,
    },
  ]);
}

export async function installApiFixture(page: Page): Promise<BrowserApiState> {
  const state: BrowserApiState = {
    catalogStatus: 200,
    emptyCatalog: false,
    emptyChildren: false,
    reportStatus: 200,
    previewStatus: 503,
    adminPagesStatus: 200,
    historyStatus: 200,
    unexpected: [],
    requests: [],
    createBookRequest: null,
    createdBook: null,
    draftCreateSourceRevisionId: null,
    aiCorrectionText: null,
    workflowRequest: null,
    candidateRequest: null,
    safetyDecisionRequest: null,
    draftSaveRequest: null,
    verifyRequest: null,
  };
  await seedBrowserSession(page);
  const childState: {
    id: string;
    parent_id: string;
    alias: string;
    grade: number;
    settings: Record<string, unknown>;
    created_at: string;
  } = {
    ...child,
    settings: { ...child.settings },
  };
  const headers = {
    "access-control-allow-origin": PLAYWRIGHT_ORIGIN,
    "access-control-allow-headers":
      "authorization,content-type,accept,x-voice-policy-mode,x-allow-google-stt-fallback,x-allow-google-tts-fallback,x-voice-region,x-voice-session-id,x-voice-page-id,x-voice-turn-id,x-voice-lock-update",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  };
  async function respond(route: Route, json: unknown, status = 200) {
    await route.fulfill({
      status,
      headers,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
  }
  function draftDetail() {
    const words = ["Văn", "bản", "đã", "lưu"].map((text, index) => ({
      word_index: index,
      line_index: 0,
      text,
      normalized_text: text.toLocaleLowerCase("vi"),
      bbox: [0.1 + index * 0.16, 0.2, 0.14, 0.05],
      ocr_confidence: 0.8,
    }));
    const saved = state.draftSaveRequest;
    const verified = state.verifyRequest;
    const savedWords = (saved?.words ?? words) as typeof words;
    const correctedWords = (verified?.words ?? savedWords) as typeof words;
    return {
      page_id: ids.page,
      page_revision_id: ids.draftRevision,
      revision_no: 3,
      verification_status: verified ? "VERIFIED" : "NEEDS_REVIEW",
      lifecycle_status: "ACTIVE",
      draft_text:
        (verified?.corrected_text as string | undefined) ??
        (saved?.draft_text as string | undefined) ??
        "Văn bản đã lưu",
      words: correctedWords,
      ocr_metadata: { source_revision_id: ids.revision },
      created_at: timestamp,
      verified_at: verified ? timestamp : null,
      verified_by: verified ? ids.parent : null,
    };
  }
  let latestWorkflow: Record<string, unknown> | null = null;
  function makeReadyWorkflow() {
    const proofreadHash = "b".repeat(64);
    return {
      workflow_id: "99999999-9999-4999-8999-999999999999",
      page_id: ids.page,
      book_id: ids.book,
      page_revision_id: ids.draftRevision,
      status: "READY_FOR_ADMIN_REVIEW",
      stage: "READY_FOR_ADMIN_REVIEW",
      progress: { completed_chunks: 1, total_chunks: 1 },
      attempts: 1,
      error_code: null,
      original_ocr_hash: "a".repeat(64),
      admin_input_hash: "a".repeat(64),
      proofread_text: "Văn bản đã sửa",
      proofread_output_hash: proofreadHash,
      corrections: [],
      uncertain_word_indices: [],
      proofread_metadata: {},
      safety_metadata: {},
      candidate_history: [],
      safety_history: [],
      review_history: [],
      candidate_text: "Văn bản đã sửa",
      candidate_hash: proofreadHash,
      candidate_version: 0,
      safety_input_hash: proofreadHash,
      hash_match: true,
      suitability: "SUITABLE",
      safety_status: "PROVISIONAL",
      findings: [],
      provider_events: [],
      ocr_approved_at: null,
      final_approved_text_hash: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
  }
  const difficultPracticeAttempts: Record<string, unknown>[] = [];
  const difficultWordState: {
    normalized_word: string;
    display_text: string;
    practice_status?: string;
    practice_attempts_count?: number;
    practice_correct_count?: number;
    consecutive_correct_count?: number;
    last_practiced_at?: string | null;
    last_practice_status?: string | null;
    [key: string]: unknown;
  } = { ...word };
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === PLAYWRIGHT_ORIGIN) return route.continue();
    if (
      url.hostname === "example.supabase.co" &&
      url.pathname === "/auth/v1/user"
    ) {
      if (request.method() === "OPTIONS")
        return route.fulfill({
          status: 204,
          headers: { ...headers, "access-control-allow-credentials": "true" },
        });
      if (request.method() === "GET")
        return route.fulfill({
          status: 200,
          headers: {
            ...headers,
            "access-control-allow-credentials": "true",
          },
          contentType: "application/json",
          body: JSON.stringify({
            id: ids.parent,
            aud: "authenticated",
            role: "authenticated",
            email: "parent@example.test",
            app_metadata: { provider: "email", providers: ["email"] },
            user_metadata: { display_name: "Ba mẹ API" },
            created_at: timestamp,
            updated_at: timestamp,
          }),
        });
    }
    // Every other origin is intercepted: no real network calls can escape.
    if (url.origin !== "http://127.0.0.1:8000") {
      state.unexpected.push(`external:${url.hostname}`);
      return route.abort();
    }
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    const path = url.pathname;
    if (request.method() === "POST" && path === "/books/admin/catalog") {
      expect(request.headers().authorization).toMatch(/^Bearer /);
      const body = request.postDataJSON() as Record<string, unknown>;
      if (
        typeof body.name !== "string" ||
        !body.name.trim() ||
        typeof body.title !== "string" ||
        !body.title.trim() ||
        !(body.author === null || typeof body.author === "string") ||
        !Number.isInteger(body.min_grade) ||
        !Number.isInteger(body.max_grade) ||
        Number(body.min_grade) < 1 ||
        Number(body.max_grade) > 5 ||
        Number(body.min_grade) > Number(body.max_grade)
      ) {
        return respond(route, { detail: "Invalid create book payload" }, 422);
      }
      const requestPayload = {
        name: body.name.trim(),
        title: body.title.trim(),
        author: body.author as string | null,
        min_grade: Number(body.min_grade),
        max_grade: Number(body.max_grade),
      };
      state.createBookRequest = requestPayload;
      state.createdBook = {
        id: "88888888-8888-4888-8888-888888888888",
        ...requestPayload,
        lifecycle_status: "ACTIVE",
      };
      return respond(route, state.createdBook);
    }
    if (
      request.method() === "POST" &&
      path === `/books/admin/pages/${ids.page}/revisions/draft`
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.draftCreateSourceRevisionId =
        typeof body.expected_source_revision_id === "string"
          ? body.expected_source_revision_id
          : null;
      if (state.draftCreateSourceRevisionId !== ids.revision)
        return respond(route, { detail: "Invalid source revision" }, 409);
      return respond(route, draftDetail());
    }
    if (
      request.method() === "POST" &&
      path === `/books/admin/pages/${ids.page}/ai-correct/jobs`
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.aiCorrectionText =
        typeof body.draft_text === "string" ? body.draft_text : null;
      if (!state.draftCreateSourceRevisionId || !state.aiCorrectionText)
        return respond(route, { detail: "No editable draft" }, 409);
      return respond(
        route,
        {
          job_id: "99999999-9999-4999-8999-999999999999",
          page_id: ids.page,
          status: "SUCCEEDED",
          completed_chunks: 1,
          total_chunks: 1,
          result: "Văn bản đã sửa",
          error: null,
          created_at: timestamp,
          updated_at: timestamp,
        },
        202,
      );
    }
    if (
      request.method() === "POST" &&
      path === `/books/admin/pages/${ids.page}/ai-workflows`
    ) {
      state.workflowRequest = request.postDataJSON() as Record<string, unknown>;
      if (
        state.workflowRequest.page_revision_id !== ids.draftRevision ||
        state.workflowRequest.draft_text !== "Văn bản đã lưu"
      )
        return respond(route, { detail: "Invalid workflow snapshot" }, 409);
      latestWorkflow = makeReadyWorkflow();
      return respond(route, latestWorkflow, 202);
    }
    if (
      request.method() === "PATCH" &&
      path ===
        `/books/admin/pages/${ids.page}/ai-workflows/99999999-9999-4999-8999-999999999999/candidate`
    ) {
      state.candidateRequest = request.postDataJSON() as Record<
        string,
        unknown
      >;
      const candidateText = state.candidateRequest.candidate_text;
      if (!latestWorkflow || candidateText !== "Văn bản đã sửa")
        return respond(route, { detail: "Invalid candidate" }, 409);
      latestWorkflow = {
        ...latestWorkflow,
        candidate_text: candidateText,
        candidate_hash: "c".repeat(64),
        candidate_version: 1,
        safety_input_hash: "c".repeat(64),
        hash_match: true,
      };
      return respond(route, latestWorkflow);
    }
    if (
      request.method() === "POST" &&
      path ===
        `/books/admin/pages/${ids.page}/ai-workflows/99999999-9999-4999-8999-999999999999/safety-decision`
    ) {
      state.safetyDecisionRequest = request.postDataJSON() as Record<
        string,
        unknown
      >;
      if (
        !latestWorkflow ||
        state.safetyDecisionRequest.expected_candidate_hash !==
          latestWorkflow.candidate_hash
      )
        return respond(route, { detail: "Stale candidate hash" }, 409);
      latestWorkflow = {
        ...latestWorkflow,
        safety_status: state.safetyDecisionRequest.confirmed
          ? "CONFIRMED"
          : "PROVISIONAL",
      };
      return respond(route, latestWorkflow);
    }
    if (
      request.method() === "PUT" &&
      path ===
        `/books/admin/pages/${ids.page}/revisions/${ids.draftRevision}/draft`
    ) {
      state.draftSaveRequest = request.postDataJSON() as Record<
        string,
        unknown
      >;
      if (!state.draftCreateSourceRevisionId)
        return respond(route, { detail: "No editable draft" }, 409);
      return respond(route, draftDetail());
    }
    if (
      request.method() === "POST" &&
      path === `/books/admin/pages/${ids.page}/verify`
    ) {
      state.verifyRequest = request.postDataJSON() as Record<string, unknown>;
      if (state.verifyRequest.page_revision_id !== ids.draftRevision)
        return respond(route, { detail: "Invalid draft revision" }, 409);
      return respond(route, draftDetail());
    }
    const latestWorkflowPath = `/books/admin/pages/${ids.page}/revisions/${ids.draftRevision}/ai-workflows/latest`;
    if (request.method() === "GET" && path === latestWorkflowPath)
      return respond(route, latestWorkflow);
    if (
      request.method() === "GET" &&
      path ===
        `/books/admin/pages/${ids.page}/revisions/${ids.revision}/ai-workflows/latest`
    )
      return respond(route, null);
    // The AI progress card is a separate feature with its own tests; here it
    // only needs to settle quietly ("not enough data" -> no AI call is made).
    const assessmentChild =
      /^\/tutor\/children\/([^/]+)\/progress-assessment$/.exec(path)?.[1];
    if (request.method() === "GET" && assessmentChild) {
      const day = timestamp.slice(0, 10);
      return respond(route, {
        child_id: assessmentChild,
        period_start: day,
        period_end: day,
        days: 30,
        generated_at: timestamp,
        data_status: "INSUFFICIENT",
        score: {
          overall: null,
          previous_overall: null,
          delta: null,
          grade: null,
          grade_label: null,
          components: [],
        },
        metrics: {
          sessions: 0,
          active_days: 0,
          reading_minutes: 0,
          books: 0,
          pages_compared: 0,
          words_read: 0,
          coverage_pct: null,
          accuracy_pct: null,
          skipped_rate_pct: null,
          substitution_rate_pct: null,
          hesitations: 0,
          repeated_words: 0,
          hesitations_per_100_words: null,
          words_per_minute: null,
          comprehension_answered: 0,
          comprehension_first_try_pct: null,
          comprehension_by_type: [],
          retry_confirmed: 0,
          retry_failed: 0,
        },
        weekly: [],
        difficult_words: [],
        assessment: {
          source: "RULE_BASED",
          model: null,
          headline: "Chưa đủ dữ liệu để đánh giá",
          summary: "Bé cần đọc thêm vài buổi để có đánh giá.",
          strengths: [],
          weaknesses: [],
          actions: [
            {
              title: "Đọc cùng bé",
              detail: "Dành vài phút mỗi ngày để đọc cùng bé.",
              audience: "PARENT",
            },
          ],
          practice_words: [],
          encouragement: "Bé cố gắng lên nhé!",
        },
        ai_cached: false,
      });
    }
    if (request.method() === "POST" && path === "/voice/phonics/analyze") {
      const body = (request.postDataJSON() ?? {}) as { text?: string };
      const text = body.text ?? "";
      return respond(route, {
        supported: false,
        source: "none",
        raw_text: text,
        clean_phrase: text,
        syllables: [],
        focus_syllable_index: 0,
        focus_syllable: "",
        steps: [],
        message: "Chưa có mẫu đánh vần",
        can_play_whole_word: true,
      });
    }
    if (request.method() === "POST" && path === "/voice/text-to-speech") {
      const bytes = 3200;
      const audio = Buffer.alloc(44 + bytes);
      audio.write("RIFF");
      audio.writeUInt32LE(36 + bytes, 4);
      audio.write("WAVE", 8);
      audio.write("fmt ", 12);
      audio.writeUInt32LE(16, 16);
      audio.writeUInt16LE(1, 20);
      audio.writeUInt16LE(1, 22);
      audio.writeUInt32LE(16_000, 24);
      audio.writeUInt32LE(32_000, 28);
      audio.writeUInt16LE(2, 32);
      audio.writeUInt16LE(16, 34);
      audio.write("data", 36);
      audio.writeUInt32LE(bytes, 40);
      return route.fulfill({
        status: 200,
        headers: { ...headers, "content-type": "audio/wav" },
        body: audio,
      });
    }
    const voicePrefsMatch =
      request.method() === "PATCH"
        ? /^\/(?:profiles\/)?children\/([^/]+)\/voice-preferences$/.exec(path)
        : null;
    if (voicePrefsMatch) {
      expect(request.headers().authorization).toMatch(/^Bearer /);
      const targetChildId = decodeURIComponent(voicePrefsMatch[1]);
      if (targetChildId !== ids.child) return respond(route, {}, 404);
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      childState.settings = {
        ...childState.settings,
        voice_preferences: {
          voice_id:
            typeof body.voice_id === "string"
              ? body.voice_id
              : "local_north_truc_ly",
          gender: body.gender === "male" ? "male" : "female",
          region:
            body.region === "central" || body.region === "south"
              ? body.region
              : "north",
          speed:
            typeof body.speed === "number" && Number.isFinite(body.speed)
              ? body.speed
              : 1.0,
          updated_at:
            typeof body.updated_at === "number" &&
            Number.isFinite(body.updated_at)
              ? body.updated_at
              : Date.now(),
        },
      };
      return respond(route, childState);
    }
    if (request.method() === "PUT" && path === "/voice/session-lock") {
      expect(request.headers().authorization).toMatch(/^Bearer /);
      const body = (request.postDataJSON() ?? {}) as {
        session_id?: string;
        voice_id?: string;
      };
      const voiceId =
        typeof body.voice_id === "string" && body.voice_id.trim()
          ? body.voice_id.trim()
          : "local_north_truc_ly";
      return respond(route, {
        session_id:
          typeof body.session_id === "string" ? body.session_id : ids.session,
        voice_id: voiceId,
        provider: voiceId.startsWith("google_") ? "google" : "local",
        locked: true,
      });
    }
    if (request.method() !== "GET") {
      state.unexpected.push(`write:${request.method()}:${url.pathname}`);
      return respond(route, { detail: "Test forbids writes" }, 405);
    }
    state.requests.push(`${url.pathname}${url.search}`);
    if (path === "/test-page.svg")
      return route.fulfill({
        headers,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#fff9e8"/><text x="100" y="220" font-size="38">Stored page - test fixture</text></svg>',
      });
    if (path === "/health")
      return respond(route, {
        status: "ok",
        ocr_mode: "remote_worker",
        ocr: { mode: "remote_worker", ready: true, workers: [], queue: {} },
      });
    expect(request.headers().authorization).toMatch(/^Bearer /);
    if (
      path === "/reading-management/collections" ||
      path === "/reading-management/goals" ||
      path === "/reading-management/plans" ||
      path === "/reading-management/reminders" ||
      path === "/reading-management/reminders/due"
    )
      return respond(route, []);
    if (path === "/reading-presence/settings")
      return respond(route, { email_enabled: false, updated_at: timestamp });
    if (path.startsWith("/reading-presence/"))
      return respond(route, { ok: true, cancelled: 0 });
    if (path === "/profiles/dashboard-summary")
      return respond(route, {
        profile: {
          id: ids.parent,
          role: "parent",
          display_name: "Ba mẹ API",
          created_at: timestamp,
          email: "parent@example.test",
          contact_phone: "+84900000000",
          email_verified: true,
          contact_info_status: "available",
          avatar_url: null,
          children: state.emptyChildren ? [] : [childState],
        },
        children: state.emptyChildren ? [] : [childState],
        latest_sessions_by_child: {},
      });
    if (path === "/profiles/me")
      return respond(route, {
        id: ids.parent,
        role: "parent",
        display_name: "Ba mẹ API",
        created_at: timestamp,
        email: "parent@example.test",
        contact_phone: "+84900000000",
        email_verified: true,
        contact_info_status: "available",
        children: state.emptyChildren ? [] : [childState],
      });
    if (path === "/parent-notifications/preferences")
      return respond(route, {
        weekly_digest_enabled: true,
        inactivity_alert_enabled: true,
        inactivity_days: 5,
        milestone_enabled: true,
        digest_weekday: 6,
        timezone: "Asia/Ho_Chi_Minh",
        quiet_hours_start: 21,
        quiet_hours_end: 7,
        max_emails_per_week: 4,
        delivery_configured: true,
        delivery_provider: "resend",
        updated_at: timestamp,
      });
    if (path === "/parent-notifications/history") return respond(route, []);
    if (path === "/profiles/children")
      return respond(route, state.emptyChildren ? [] : [childState]);
    if (path === `/profiles/children/${ids.child}`)
      return respond(route, childState);
    if (path.startsWith("/profiles/children/")) return respond(route, {}, 404);
    if (path === "/profiles/admin/parents")
      return respond(route, {
        items: [],
        total: 0,
        limit: Number(url.searchParams.get("limit") ?? 10),
        offset: Number(url.searchParams.get("offset") ?? 0),
      });
    if (path === `/profiles/admin/parents/${ids.parent}`)
      return respond(route, {
        id: ids.parent,
        display_name: "Ba mẹ API",
        email: "parent@example.test",
        phone: null,
        created_at: timestamp,
        children: [childState],
        contact_info_status: "not_configured",
      });
    if (path === "/books/catalog") {
      if (state.catalogStatus !== 200)
        return respond(
          route,
          { detail: "private sql token" },
          state.catalogStatus,
        );
      const search =
        url.searchParams.get("search")?.toLocaleLowerCase("vi") ?? "";
      return respond(
        route,
        state.emptyCatalog ||
          (search &&
            !`${book.title} ${book.author}`
              .toLocaleLowerCase("vi")
              .includes(search))
          ? []
          : [book],
      );
    }
    if (path === `/books/catalog/${ids.book}`) return respond(route, book);
    if (path === `/books/catalog/${ids.book}/preview`) {
      if (state.previewStatus !== 200)
        return respond(route, [], state.previewStatus);
      return respond(route, [
        {
          page_id: ids.page,
          page_number: 1,
          lifecycle_status: "ACTIVE",
          current_verified_revision_id: ids.revision,
          preview_url: "http://127.0.0.1:8000/test-page.svg",
        },
      ]);
    }
    if (path === "/books/reports/mine")
      return respond(route, {
        items: [],
        total: 0,
        limit: Number(url.searchParams.get("limit") ?? 20),
        offset: Number(url.searchParams.get("offset") ?? 0),
      });
    if (path.startsWith("/books/catalog/")) return respond(route, {}, 404);
    if (path === "/reading/history")
      return respond(
        route,
        { sessions: [summary], next_cursor: null },
        state.historyStatus,
      );
    if (path === `/reading/history/${ids.session}/book`)
      return respond(route, { ...book, lifecycle_status: "RETIRED" });
    if (path === `/reading/history/${ids.session}`)
      return respond(
        route,
        {
          ...summary,
          selected_page_revision_ids: [],
          reference_page_revision_ids: [],
          events: [],
          fluency_assessment: null,
          comprehension: [],
          report_id: null,
          availability: {
            events: "absent",
            fluency: "absent",
            comprehension: "absent",
          },
        },
        state.historyStatus,
      );
    if (path.startsWith("/reading/history/")) return respond(route, {}, 404);
    const reportPathParts = path.split("/");
    if (
      reportPathParts.length === 5 &&
      reportPathParts[1] === "reading" &&
      reportPathParts[2] === "sessions" &&
      reportPathParts[4] === "reports"
    ) {
      return respond(
        route,
        { session_id: reportPathParts[3], total: 0, reports: [] },
        state.reportStatus,
      );
    }
    if (path.startsWith("/system/progress/") && path.endsWith("/periods"))
      return respond(
        route,
        {
          items: [
            {
              id: ids.session,
              child_id: ids.child,
              period_start: "2026-09-09",
              period_end: "2026-10-08",
              generated_at: timestamp,
            },
          ],
          next_cursor: null,
        },
        state.reportStatus,
      );
    if (path.startsWith("/system/progress/"))
      return respond(
        route,
        {
          id: ids.session,
          generated_at: timestamp,
          legacy: null,
          data_status: "complete",
          availability: {
            metrics: "available",
            difficult_words: "available",
            comparison: "absent",
          },
          child_id: ids.child,
          period_start: url.searchParams.get("period_start") ?? "2026-09-09",
          period_end: url.searchParams.get("period_end") ?? "2026-10-08",
          completed_sessions: 2,
          reading_duration_ms: 120000,
          omission_count: 1,
          repetition_count: 0,
          long_pause_count: 0,
          omission_rate: null,
          repetition_rate: null,
          long_pause_rate: null,
          comprehension_accuracy: null,
          difficult_words: [word],
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
        state.reportStatus,
      );
    if (
      path.startsWith(`/system/difficult-words/${ids.child}/practice/history`)
    ) {
      if (state.reportStatus !== 200)
        return respond(route, {}, state.reportStatus);
      return respond(route, {
        storage_ready: true,
        items: difficultPracticeAttempts,
      });
    }
    if (
      path === `/system/difficult-words/${ids.child}/practice/evaluate` &&
      request.method() === "POST"
    ) {
      if (state.reportStatus !== 200)
        return respond(route, {}, state.reportStatus);
      const attemptId = `99999999-9999-4999-8999-${String(difficultPracticeAttempts.length + 1).padStart(12, "0")}`;
      const attempt = {
        attempt_id: attemptId,
        child_id: ids.child,
        normalized_word: difficultWordState.normalized_word,
        display_text: difficultWordState.display_text,
        attempt_number: difficultPracticeAttempts.length + 1,
        state: "COMPLETED",
        assessment_status: "CORRECT",
        recognition_source: "SERVER_STT",
        spoken_transcript: difficultWordState.display_text,
        confidence: null,
        audio_duration_ms: 820,
        assessment_version: 1,
        evidence_word_ids: [ids.revision],
        persistence_backend: "READING_EVENT",
        resolved_in_session: true,
        started_at: timestamp,
        completed_at: timestamp,
        feedback_message: "Chính xác rồi! Con giỏi lắm!",
        word_progress: {
          normalized_word: difficultWordState.normalized_word,
          practice_status: "COMPLETED",
          practice_attempts_count: 1,
          practice_correct_count: 1,
          practice_incorrect_count: 0,
          practice_uncertain_count: 0,
          consecutive_correct_count: 1,
          required_consecutive_correct: 1,
          last_practiced_at: timestamp,
          last_practice_status: "CORRECT",
        },
        next_recommended_word: null,
        evidence_count_unchanged: true,
      };
      difficultWordState.practice_status = "COMPLETED";
      difficultWordState.practice_attempts_count = 1;
      difficultWordState.practice_correct_count = 1;
      difficultWordState.consecutive_correct_count = 1;
      difficultWordState.last_practiced_at = timestamp;
      difficultWordState.last_practice_status = "CORRECT";
      difficultPracticeAttempts.unshift(attempt);
      return respond(route, attempt);
    }
    if (
      path === `/system/difficult-words/${ids.child}/practice/start` &&
      request.method() === "POST"
    ) {
      if (state.reportStatus !== 200)
        return respond(route, {}, state.reportStatus);
      const body = route.request().postDataJSON() as {
        normalized_word: string;
        display_text?: string;
        evidence_word_ids?: string[];
      };
      const attemptId = `99999999-9999-4999-8999-${String(difficultPracticeAttempts.length + 1).padStart(12, "0")}`;
      const attempt = {
        attempt_id: attemptId,
        child_id: ids.child,
        normalized_word: body.normalized_word,
        display_text: body.display_text ?? body.normalized_word,
        attempt_number: difficultPracticeAttempts.length + 1,
        state: "STARTED",
        assessment_status: null,
        recognition_source: null,
        spoken_transcript: null,
        confidence: null,
        audio_duration_ms: null,
        assessment_version: 1,
        evidence_word_ids: body.evidence_word_ids ?? [ids.revision],
        started_at: timestamp,
        completed_at: null,
        feedback_message: null,
        word_progress: {
          normalized_word: body.normalized_word,
          practice_status: "IN_PROGRESS",
          practice_attempts_count: difficultPracticeAttempts.length,
          practice_correct_count: difficultPracticeAttempts.length,
          practice_incorrect_count: 0,
          practice_uncertain_count: 0,
          consecutive_correct_count: difficultPracticeAttempts.length,
          required_consecutive_correct: 2,
          last_practiced_at: null,
          last_practice_status: null,
        },
        next_recommended_word: null,
        evidence_count_unchanged: true,
      };
      difficultPracticeAttempts.unshift(attempt);
      return respond(route, attempt);
    }
    if (path.startsWith("/system/difficult-words/"))
      return respond(route, [difficultWordState], state.reportStatus);
    if (path === "/books/admin/catalog")
      return respond(
        route,
        [book, ...(state.createdBook ? [state.createdBook] : [])].map(
          (catalogBook) => ({
            book: catalogBook,
            page_count: catalogBook.id === book.id ? 1 : 0,
            processing_count: 0,
            needs_review_count: 0,
            verified_count: catalogBook.id === book.id ? 1 : 0,
            parent_catalog_eligible: catalogBook.id === book.id,
          }),
        ),
      );
    if (path === "/books/admin/metadata-quality")
      return respond(route, {
        summary: {
          total_books: 0,
          books_with_issues: 0,
          missing_title: 0,
          missing_author: 0,
          invalid_grade_range: 0,
          possible_duplicate_groups: 0,
          books_in_duplicate_groups: 0,
          checked_at: timestamp,
        },
        items: [],
        total: 0,
        limit: Number(url.searchParams.get("limit") ?? 10),
        offset: Number(url.searchParams.get("offset") ?? 0),
      });
    if (path === "/books/admin/quality/reports")
      return respond(route, {
        items: [],
        total: 0,
        summary: {},
        limit: Number(url.searchParams.get("limit") ?? 10),
        offset: Number(url.searchParams.get("offset") ?? 0),
      });
    if (path === "/books/admin/quality/books")
      return respond(route, {
        items: [],
        total: 0,
        limit: Number(url.searchParams.get("limit") ?? 10),
        offset: Number(url.searchParams.get("offset") ?? 0),
      });
    if (path === "/books/admin/viread-training/overview")
      return respond(route, {
        outbox: [],
        samples: [],
        jobs: [],
        runs: [],
        benchmarks: [],
        active_model: null,
      });
    if (
      state.createdBook &&
      path === `/books/admin/catalog/${state.createdBook.id}`
    )
      return respond(route, state.createdBook);
    if (
      state.createdBook &&
      path === `/books/admin/catalog/${state.createdBook.id}/pages`
    )
      return respond(route, []);
    if (
      state.createdBook &&
      path === `/books/admin/catalog/${state.createdBook.id}/ocr-jobs`
    )
      return respond(route, []);
    if (path === `/books/admin/catalog/${ids.book}`)
      return respond(route, book);
    if (path === `/books/admin/catalog/${ids.book}/ocr-jobs`)
      return respond(route, []);
    if (
      path === "/reading/scan-page-ocr/jobs" &&
      route.request().method() === "GET"
    )
      return respond(route, { worker_online: true, jobs: [] });
    if (path === `/books/admin/catalog/${ids.book}/pages`)
      return respond(
        route,
        [{ book_id: ids.book, page_number: 2, processing }],
        state.adminPagesStatus,
      );
    if (path === `/books/admin/pages/${ids.page}/image`)
      return respond(route, {
        page_id: ids.page,
        page_revision_id:
          new URL(route.request().url()).searchParams.get("revision_id") ??
          ids.revision,
        page_number: 2,
        preview_url: "http://127.0.0.1:8000/test-page.svg",
        width: 800,
        height: 1000,
      });
    if (path === `/books/admin/pages/${ids.page}/revisions`)
      return respond(route, [
        ...(state.draftCreateSourceRevisionId
          ? [
              {
                page_revision_id: ids.draftRevision,
                revision_no: 3,
                verification_status: state.verifyRequest
                  ? "VERIFIED"
                  : "NEEDS_REVIEW",
                created_at: timestamp,
                is_current_verified: Boolean(state.verifyRequest),
              },
            ]
          : []),
        {
          page_revision_id: ids.revision,
          revision_no: 2,
          verification_status: "VERIFIED",
          created_at: timestamp,
          is_current_verified: !state.verifyRequest,
        },
        {
          page_revision_id: ids.oldRevision,
          revision_no: 1,
          verification_status: "VERIFIED",
          created_at: timestamp,
          is_current_verified: false,
        },
      ]);
    if (path.startsWith(`/books/admin/pages/${ids.page}/revisions/`)) {
      if (path.endsWith(ids.draftRevision) && state.draftCreateSourceRevisionId)
        return respond(route, draftDetail());
      const old = path.endsWith(ids.oldRevision);
      return respond(route, {
        ...processing,
        page_revision_id: old ? ids.oldRevision : ids.revision,
        revision_no: old ? 1 : 2,
        draft_text: old ? "Văn bản revision cũ" : "Văn bản đã lưu",
        words: [
          {
            word_index: 0,
            line_index: 0,
            text: "Văn",
            normalized_text: "van",
            bbox: [0.1, 0.2, 0.15, 0.05],
            ocr_confidence: 0.8,
          },
        ],
        ocr_metadata: {},
        created_at: timestamp,
        verified_by: null,
      });
    }
    if (
      request.method() === "GET" &&
      path === "/karaoke/admin/processing-capabilities"
    )
      return respond(route, {
        enabled: false,
        configured: false,
        supported_modes: [],
        unavailable_reason: "DISABLED",
        limits: {
          max_audio_bytes: 20971520,
          max_duration_ms: 300000,
          max_lyric_lines: 300,
          max_lyric_characters: 50000,
        },
        queue_warning_after_seconds: 150,
      } satisfies ProcessingCapabilities);
    if (path === "/system/admin/audit-logs")
      return respond(route, {
        items: [
          {
            id: ids.revision,
            actor_id: null,
            resource_id: null,
            request_id: null,
            action: "book.read",
            resource_type: "book",
            created_at: timestamp,
            metadata: {},
          },
        ],
        next_cursor: null,
      });
    if (path === "/system/admin/health")
      return respond(route, {
        overall_status: "HEALTHY",
        checked_at: timestamp,
        services: [
          {
            id: "database",
            label: "Database",
            status: "HEALTHY",
            checked_at: timestamp,
            safe_message: "Database đã phản hồi truy vấn đọc.",
          },
        ],
      });
    if (request.method() === "GET" && path === "/voice/status")
      return respond(route, readyVoiceStatus("Binh"));
    if (request.method() === "GET" && path === "/voice/voices")
      return respond(route, {
        default_voice_id: "local_north_truc_ly",
        local_worker_ready: true,
        google_tts_available: false,
        voices: FIXTURE_LOCAL_VOICES,
      });
    if (
      request.method() === "GET" &&
      (path === "/studio/tasks" ||
        path === "/studio/parent/tasks" ||
        path === "/studio/admin/tasks")
    ) {
      const portal =
        path === "/studio/admin/tasks" ||
        url.searchParams.get("portal") === "admin"
          ? "admin"
          : "parent";
      return respond(route, {
        actor_id: ids.parent,
        actor_role: portal,
        portal,
        active_count: 0,
        waiting_review_count: 0,
        failed_count: 0,
        completed_count: 0,
        worker_online: true,
        recommended_poll_ms: null,
        tasks: [],
      });
    }
    if (
      request.method() === "GET" &&
      /^\/studio\/books\/[^/]+\/assets$/.test(path)
    )
      return respond(route, {
        book_id: ids.book,
        title: book.title,
        author: book.author,
        min_grade: book.min_grade,
        max_grade: book.max_grade,
        visibility_scope: "CATALOG",
        active_cover: null,
        effective_cover_source: "METADATA_RENDER",
        metadata_fallback: {
          palette_id: "sky-blue",
          primary_color: "#1D4ED8",
          secondary_color: "#DBEAFE",
          accent_color: "#F59E0B",
          motif: "storybook",
          title: book.title,
          author: book.author,
          grade_label: `Lớp ${book.min_grade}–${book.max_grade}`,
          source_type: "METADATA_RENDER",
        },
        style_bible: null,
        page_illustrations: [],
        ai_image_provider_available: false,
        ai_image_provider_name: null,
        ai_image_provider_message_vi:
          "Chưa cấu hình nhà cung cấp tạo ảnh AI miễn phí.",
        v2_storage_degraded: false,
      });
    const recMatch =
      request.method() === "GET"
        ? /^\/learning\/children\/([^/]+)\/recommendations$/.exec(path)
        : null;
    if (recMatch) {
      const targetChildId = decodeURIComponent(recMatch[1]);
      return respond(route, {
        child_id: targetChildId,
        child_alias: child.alias,
        child_grade: child.grade,
        mascot_greeting_vi: `Chào ${child.alias}! Hôm nay cùng vui học nhé!`,
        natural_break_reminder_vi:
          "Mỗi phiên chơi khoảng 10–15 phút là vừa đẹp để mắt bé luôn khỏe mạnh.",
        today_activities_count: 1,
        focus_difficult_words: [word.display_text],
        primary_recommendation: {
          game_key: "KARAOKE",
          zone_title_vi: "Sân khấu âm nhạc",
          game_title_vi: "Hát vui cùng bé",
          reason_vi: "Cùng bé luyện nhịp điệu và câu hát rõ lời.",
          suggested_mode: "FULL_SONG",
          suggested_difficulty: 1,
          target_words: [word.display_text],
          href: "/karaoke",
          priority: 1,
        },
        recommendations: [
          {
            game_key: "KARAOKE",
            zone_title_vi: "Sân khấu âm nhạc",
            game_title_vi: "Hát vui cùng bé",
            reason_vi: "Cùng bé luyện nhịp điệu và câu hát rõ lời.",
            suggested_mode: "FULL_SONG",
            suggested_difficulty: 1,
            target_words: [word.display_text],
            href: "/karaoke",
            priority: 1,
          },
        ],
      });
    }
    const analyticsMatch =
      request.method() === "GET"
        ? /^\/learning\/children\/([^/]+)\/parent-analytics$/.exec(path)
        : null;
    if (analyticsMatch) {
      const targetChildId = decodeURIComponent(analyticsMatch[1]);
      const windowDays =
        Number(url.searchParams.get("window_days") ?? "30") || 30;
      return respond(route, {
        child_id: targetChildId,
        child_alias: child.alias,
        child_grade: child.grade,
        window_days: windowDays,
        is_diagnostic: false,
        disclaimer_vi:
          "Báo cáo này tổng hợp hoạt động Học mà Chơi để hỗ trợ luyện đọc tại nhà, không phải đánh giá hay chẩn đoán y khoa.",
        observed_skills_count: 0,
        estimated_skills_count: 0,
        unknown_skills_count: 0,
        skills: [],
        practiced_difficult_words: [],
        module_activities: [],
        karaoke_weak_segments: [],
        home_support_tips_vi: [],
        generated_at: timestamp,
      });
    }
    const warmupStoryMatch =
      request.method() === "GET"
        ? /^\/learning\/children\/([^/]+)\/warmup-story$/.exec(path)
        : null;
    if (warmupStoryMatch) {
      const targetChildId = decodeURIComponent(warmupStoryMatch[1]);
      return respond(route, {
        child_id: targetChildId,
        local_date: "2026-10-08",
        has_due_words: true,
        target_words: ["mèo", "nắng"],
        title_vi: "Nắng sớm bên hiên",
        sentences: [
          "Chú mèo nhỏ sưởi nắng sớm bên hiên nhà.",
          "Bé mỉm cười đọc sách cùng chú mèo ngoan.",
        ],
        full_text:
          "Chú mèo nhỏ sưởi nắng sớm bên hiên nhà. Bé mỉm cười đọc sách cùng chú mèo ngoan.",
        source: "RULE_BASED",
        cached: false,
      });
    }
    const vocabNotebookMatch =
      request.method() === "GET"
        ? /^\/vocabulary\/children\/([^/]+)\/notebook$/.exec(path)
        : null;
    if (vocabNotebookMatch) {
      return respond(route, {
        child_id: decodeURIComponent(vocabNotebookMatch[1]),
        total: 0,
        items: [],
        storytelling_words: [],
      });
    }
    const dialectProfileMatch =
      request.method() === "GET"
        ? /^\/dialect\/children\/([^/]+)\/profile$/.exec(path)
        : null;
    if (dialectProfileMatch) {
      return respond(route, {
        child_id: decodeURIComponent(dialectProfileMatch[1]),
        phonetic_profile: "STRICT_SGK",
        visibility: "PARENT_PRIVATE",
      });
    }
    if (
      request.method() === "GET" &&
      path === "/games/picture-description/catalog"
    )
      return respond(route, {
        samples: [
          {
            sample_key: "sunny-garden",
            title: "Khu vườn đầy nắng",
            theme: "Thiên nhiên",
            description: "Chú mèo mướp và chú bướm trong khu vườn đầy nắng.",
            image_url: "/images/picture-description/sunny-garden.jpg",
          },
        ],
        book_pages: [],
      });
    if (
      request.method() === "GET" &&
      path === "/games/picture-description/sessions"
    )
      return respond(route, []);
    if (request.method() === "GET" && path === "/games/sentence-shooter/books")
      return respond(route, [
        {
          id: ids.book,
          name: book.name,
          title: book.title,
          author: book.author,
          min_grade: book.min_grade,
          max_grade: book.max_grade,
          available_rounds: 3,
        },
      ]);
    state.unexpected.push(`unknown:${path}`);
    return respond(route, {}, 404);
  });
  return state;
}
