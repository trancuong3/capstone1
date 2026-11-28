import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, type Route } from "@playwright/test";
import { createPlaywrightAuthFixtureHeaders } from "../../lib/auth/playwright-auth-fixture";
import type { VoiceEngineHealthSnapshot } from "../../lib/reading/voice-engine-status";

export const E2E_SUITE_PORT =
  process.env.PLAYWRIGHT_E2E_SUITE_PORT ??
  process.env.PLAYWRIGHT_PORT ??
  "3108";
export const E2E_SUITE_ORIGIN = `http://127.0.0.1:${E2E_SUITE_PORT}`;
export const API_ORIGIN = "http://127.0.0.1:8000";

export const ids = {
  parent: "11111111-1111-4111-8111-111111111111",
  child1: "22222222-2222-4222-8222-222222222222",
  child2: "22222222-2222-4222-8222-222222222229",
  book1: "33333333-3333-4333-8333-333333333333",
  book2: "33333333-3333-4333-8333-333333333334",
  privateBook1: "aa000000-0000-4000-8000-000000000001",
  session1: "44444444-4444-4444-8444-444444444444",
  session2: "44444444-4444-4444-8444-444444444445",
  page1: "55555555-5555-4555-8555-555555555555",
  page2: "55555555-5555-4555-8555-555555555556",
  revision1: "66666666-6666-4666-8666-666666666666",
  revision2: "66666666-6666-4666-8666-666666666667",
  oldRevision: "77777777-7777-4777-8777-777777777777",
  draftRevision: "88888888-8888-4888-8888-888888888888",
  question1: "91000000-0000-4000-8000-000000000001",
  question2: "91000000-0000-4000-8000-000000000002",
  answer1: "92000000-0000-4000-8000-000000000001",
  report1: "93000000-0000-4000-8000-000000000001",
  song1: "e1111111-1111-4111-8111-111111111111",
  version1: "e2222222-2222-4222-8222-222222222222",
  line1: "e3333333-3333-4333-8333-333333333333",
  studioTask1: "cc000000-0000-4000-8000-000000000001",
  bookReport1: "dd000000-0000-4000-8000-000000000001",
  ocrJob1: "ee000000-0000-4000-8000-000000000001",
  karaokeSession1: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
  pictureSession1: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  pictureAttempt1: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  pictureBookPage1: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  shooterSession1: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  shooterRound1: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  shooterToken1: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
  shooterToken2: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
  shooterToken3: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5",
  memorySession1: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  memoryAttemptRecall1: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
  memoryAttemptCreative1: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
  goal1: "77777777-7777-4777-8777-000000000001",
  plan1: "66666666-6666-4666-8666-000000000001",
  collection1: "88888888-8888-4888-8888-000000000001",
  reminder1: "55555555-5555-4555-8555-000000000001",
  occurrence1: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
} as const;

export const NOW = "2026-11-15T08:00:00Z";

export const defaultChildren = [
  {
    id: ids.child1,
    parent_id: ids.parent,
    alias: "Bé An",
    grade: 2,
    settings: {},
    created_at: NOW,
    avatar_url: null,
  },
  {
    id: ids.child2,
    parent_id: ids.parent,
    alias: "Bé Bông",
    grade: 4,
    settings: {},
    created_at: NOW,
    avatar_url: null,
  },
];

export const defaultBooks = [
  {
    id: ids.book1,
    name: "chu-meo-di-hia",
    title: "Chú mèo đi hia",
    author: "Charles Perrault",
    min_grade: 1,
    max_grade: 3,
    lifecycle_status: "ACTIVE" as const,
    visibility_scope: "CATALOG" as const,
    cover_url: null,
    cover_source_type: "METADATA_RENDER" as const,
  },
  {
    id: ids.book2,
    name: "khu-vuon-nang-am",
    title: "Khu vườn nắng ấm",
    author: "Nguyễn Thu Hà",
    min_grade: 2,
    max_grade: 5,
    lifecycle_status: "ACTIVE" as const,
    visibility_scope: "CATALOG" as const,
    cover_url: null,
    cover_source_type: "METADATA_RENDER" as const,
  },
];

export function buildSilentWavBuffer(seconds = 1, rate = 8000): Buffer {
  const bytes = Buffer.alloc(44 + rate * seconds * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

export function readyVoiceStatus(
  defaultVoiceId = "Binh",
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

export interface ReadingWordFixture {
  word_id: string;
  word_index: number;
  text: string;
  bbox: [number, number, number, number];
  line_index: number;
}

export function buildReadingWords(lineCount = 1): ReadingWordFixture[] {
  if (lineCount <= 1) {
    return ["Bé", "mèo", "đọc", "sách"].map((text, index) => ({
      word_id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      word_index: index,
      text,
      bbox: [0.08 + index * 0.2, 0.2, 0.18, 0.08],
      line_index: 0,
    }));
  }
  const lineWords = ["Sáng", "sớm", "bé", "An", "đọc", "sách", "hay."];
  const result: ReadingWordFixture[] = [];
  let wordIndex = 0;
  for (let line = 0; line < lineCount; line += 1) {
    for (let col = 0; col < lineWords.length; col += 1) {
      result.push({
        word_id: `90000000-0000-4000-8000-${String(wordIndex + 1).padStart(12, "0")}`,
        word_index: wordIndex,
        text: lineWords[col],
        bbox: [
          0.05 + col * 0.12,
          Math.min(0.92, 0.05 + (line % 12) * 0.07),
          0.1,
          0.05,
        ],
        line_index: line,
      });
      wordIndex += 1;
    }
  }
  return result;
}

export interface E2eSuiteFixtureOptions {
  emptyChildren?: boolean;
  reportStatus?: number;
  catalogStatus?: number;
  readingImageMode?: "valid" | "missing" | "broken";
  readingLineCount?: number;
  restoredPracticeState?: boolean;
  populatedSessionReports?: boolean;
  denyMicrophone?: boolean;
  silentMicrophone?: boolean;
  disableBrowserSpeechRecognition?: boolean;
  sttTranscript?: string;
  seedChildId?: string | null;
}

export interface E2eSuiteState {
  unexpected: string[];
  requests: string[];
  reportStatus: number;
  catalogStatus: number;
  readingImageMode: "valid" | "missing" | "broken";
  children: Array<Record<string, unknown>>;
  privateBooks: Array<Record<string, unknown>>;
  goals: Array<Record<string, unknown>>;
  plans: Array<Record<string, unknown>>;
  collections: Array<Record<string, unknown>>;
  reminders: Array<Record<string, unknown>>;
  readingFinished: boolean;
  readingEvents: Array<Record<string, unknown>>;
  comprehensionAnswered: number;
  ttsRequests: number;
  sttRequests: number;
  karaokeSessionsSaved: Array<Record<string, unknown>>;
  parentDisplayName: string;
}

export async function setRole(
  page: Page,
  role: "parent" | "admin",
): Promise<void> {
  const fixtureToken = process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN;
  if (!fixtureToken) throw new Error("Missing isolated auth fixture token");
  await page.setExtraHTTPHeaders(
    createPlaywrightAuthFixtureHeaders(role, fixtureToken),
  );
}

export async function seedSelectedChild(
  page: Page,
  childId: string | null = ids.child1,
  userId: string = ids.parent,
): Promise<void> {
  const key = `viread:selected-child:${userId}`;
  await page.addInitScript(
    ({ storageKey, value }) => {
      if (value) {
        window.sessionStorage.setItem(storageKey, value);
      } else {
        window.sessionStorage.removeItem(storageKey);
      }
    },
    { storageKey: key, value: childId },
  );
}

async function seedBrowserSession(page: Page): Promise<void> {
  const expiry = Math.floor(Date.now() / 1000) + 7200;
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
    expires_in: 7200,
    user: {
      id: ids.parent,
      aud: "authenticated",
      role: "authenticated",
      email: "parent@example.test",
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { display_name: "Ba mẹ ViRead" },
      created_at: NOW,
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

function loadDemoAudioAndLyrics(): {
  mp3: Buffer;
  lyrics: Record<string, unknown>;
} {
  try {
    const demoDir = path.resolve(process.cwd(), "..", "docs", "karaoke-demo");
    const mp3 = readFileSync(path.join(demoDir, "ngoi-sao-nho.mp3"));
    const lyrics = JSON.parse(
      readFileSync(path.join(demoDir, "ngoi-sao-nho-v2.json"), "utf8"),
    ) as Record<string, unknown>;
    return { mp3, lyrics };
  } catch {
    return {
      mp3: buildSilentWavBuffer(8, 8000),
      lyrics: {
        format_version: 2,
        lines: [
          {
            id: ids.line1,
            text: "Ngôi sao nhỏ",
            start_ms: 1000,
            end_ms: 4000,
            syllables: [
              {
                id: "44444444-4444-4444-8444-444444444441",
                text: "Ngôi",
                start_ms: 1000,
                end_ms: 2000,
              },
              {
                id: "44444444-4444-4444-8444-444444444442",
                text: "sao",
                start_ms: 2000,
                end_ms: 3000,
              },
              {
                id: "44444444-4444-4444-8444-444444444443",
                text: "nhỏ",
                start_ms: 3000,
                end_ms: 4000,
              },
            ],
          },
        ],
      },
    };
  }
}

export async function installE2eSuiteFixture(
  page: Page,
  options: E2eSuiteFixtureOptions = {},
): Promise<E2eSuiteState> {
  await seedBrowserSession(page);

  if (options.seedChildId !== undefined) {
    await seedSelectedChild(page, options.seedChildId);
  }

  const demo = loadDemoAudioAndLyrics();
  const silentWav = buildSilentWavBuffer(1, 16000);
  const readingWords = buildReadingWords(options.readingLineCount ?? 1);

  const state: E2eSuiteState = {
    unexpected: [],
    requests: [],
    reportStatus: options.reportStatus ?? 200,
    catalogStatus: options.catalogStatus ?? 200,
    readingImageMode: options.readingImageMode ?? "valid",
    children: options.emptyChildren
      ? []
      : defaultChildren.map((item) => ({ ...item })),
    privateBooks: [
      {
        id: ids.privateBook1,
        title: "Truyện cổ tích gia đình",
        author: "Mẹ Bé An",
        min_grade: 1,
        max_grade: 3,
        lifecycle_status: "ACTIVE",
        visibility_scope: "PARENT_PRIVATE",
        moderation_status: "ACTIVE",
        suspended_reason: null,
        source_declaration: "[OWNED_PHYSICAL_BOOK] Sách giấy gia đình",
        committed_page_count: 2,
        pending_submission_count: 0,
        flagged_submission_count: 0,
        failed_submission_count: 0,
        ready_to_add_count: 0,
        readable_for_children: true,
        has_held_multipage_batch: false,
        privacy_notice: "Chỉ bạn và các hồ sơ trẻ của bạn có thể đọc sách này.",
        created_at: NOW,
      },
    ],
    goals: [
      {
        id: ids.goal1,
        child_id: ids.child1,
        metric: "MINUTES",
        target_value: 20,
        period: "DAILY",
        starts_on: "2026-11-01",
        ends_on: null,
        timezone: "Asia/Ho_Chi_Minh",
        status: "ACTIVE",
        current_value: 10,
        progress_percent: 50,
        created_at: NOW,
        updated_at: NOW,
        phase: "RUNNING",
        streak_cycles: 3,
        cycle_starts_on: "2026-11-15",
        cycle_ends_on: "2026-11-15",
      },
    ],
    plans: [
      {
        id: ids.plan1,
        child_id: ids.child1,
        book_id: ids.book1,
        book_title: defaultBooks[0].title,
        title: "Đọc truyện buổi tối",
        target_minutes: 15,
        weekdays: [0, 2, 4],
        starts_on: "2026-11-01",
        ends_on: null,
        timezone: "Asia/Ho_Chi_Minh",
        status: "ACTIVE",
        scheduled_days_this_week: 3,
        completed_days_this_week: 1,
        progress_percent: 33,
        completed_at: null,
        created_at: NOW,
        updated_at: NOW,
        phase: "RUNNING",
        next_scheduled_date: "2026-11-16",
        is_scheduled_today: true,
        minutes_today: 10,
      },
    ],
    collections: [
      {
        id: ids.collection1,
        child_id: ids.child1,
        book_id: ids.book1,
        collection_type: "FAVORITE",
        created_at: NOW,
        book: {
          id: ids.book1,
          title: defaultBooks[0].title,
          author: defaultBooks[0].author,
          min_grade: defaultBooks[0].min_grade,
          max_grade: defaultBooks[0].max_grade,
          lifecycle_status: "ACTIVE",
          available_to_read: true,
        },
      },
    ],
    reminders: [
      {
        id: ids.reminder1,
        child_id: ids.child1,
        remind_at: "19:30:00",
        weekdays: [0, 1, 2, 3, 4],
        timezone: "Asia/Ho_Chi_Minh",
        is_active: true,
        email_enabled: true,
        deleted_at: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    readingFinished: false,
    readingEvents: [],
    comprehensionAnswered: 0,
    ttsRequests: 0,
    sttRequests: 0,
    karaokeSessionsSaved: [],
    parentDisplayName: "Ba mẹ ViRead",
  };

  let emailPrefs: Record<string, unknown> = {
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
    updated_at: NOW,
  };

  let currentPageId: string = ids.page1;
  const completedPageIds = new Set<string>();
  const difficultPracticeAttempts: Array<Record<string, unknown>> = [];
  const difficultWordItem: Record<string, unknown> = {
    normalized_word: "meo",
    display_text: "mèo",
    difficulty_score: 3,
    omission_count: 1,
    repetition_count: 0,
    long_pause_count: 0,
    read_example_count: 0,
    session_count: 1,
    last_seen_at: NOW,
    evidence_word_ids: [ids.revision1],
    practice_status: "NOT_PRACTICED",
    practice_attempts_count: 0,
    practice_correct_count: 0,
    practice_incorrect_count: 0,
    practice_uncertain_count: 0,
    consecutive_correct_count: 0,
    last_practiced_at: null,
    last_practice_status: null,
    sources: [
      {
        book_id: ids.book1,
        book_title: defaultBooks[0].title,
        book_author: defaultBooks[0].author,
        min_grade: 1,
        max_grade: 3,
        session_id: ids.session1,
        page_id: ids.page1,
        page_revision_id: ids.revision1,
        page_number: 1,
        word_id: readingWords[1]?.word_id ?? ids.revision1,
        context_phrase: "Bé mèo đọc sách",
        last_seen_at: NOW,
      },
    ],
  };

  let shooterResolvedShots = 0;
  let shooterCurrentRound = 1;
  let shooterHintCount = 0;
  let sessionReportDeleted = false;
  const ocrScanJobs: Array<Record<string, unknown>> = [];
  const shooterTokens = [
    { id: ids.shooterToken1, text: "Bé", is_difficult_word: false },
    { id: ids.shooterToken2, text: "đọc", is_difficult_word: false },
    { id: ids.shooterToken3, text: "sách.", is_difficult_word: true },
  ];

  const memoryCat = {
    id: "obj-cat",
    sprite_key: "tabby_cat",
    name_vi: "mèo mướp",
    category_vi: "con vật",
    aliases_vi: ["mèo", "con mèo"],
    color_vi: "cam",
    color_hex: "#FB923C",
    color_stroke_hex: "#9A3412",
    color_light_hex: "#FED7AA",
    shape_cue: "circle",
    count: 1,
    position_zone: "dưới trái",
    bbox: { x: 0.12, y: 0.62, w: 0.2, h: 0.24 },
    action_vi: "đang nằm sưởi nắng",
    hint_tiers: {
      tier_1: "Ở góc dưới trái có một người bạn bốn chân lông màu cam.",
      tier_2: "Bạn ấy kêu meo meo và thích nằm sưởi nắng.",
      tier_3: "Đó là chú mèo mướp màu cam ở dưới trái!",
    },
    is_focus_word: true,
  };
  const memoryFlower = {
    id: "obj-flower",
    sprite_key: "sunflower",
    name_vi: "hoa hướng dương",
    category_vi: "thực vật",
    aliases_vi: ["hoa vàng"],
    color_vi: "vàng",
    color_hex: "#FACC15",
    color_stroke_hex: "#854D0E",
    color_light_hex: "#FEF08A",
    shape_cue: "star",
    count: 2,
    position_zone: "dưới phải",
    bbox: { x: 0.66, y: 0.58, w: 0.22, h: 0.26 },
    action_vi: "đang nở rộ đón nắng",
    hint_tiers: {
      tier_1: "Ở góc dưới phải có 2 bông hoa lớn màu vàng.",
      tier_2: "Loài hoa này luôn hướng về phía mặt trời.",
      tier_3: "Đó là 2 bông hoa hướng dương màu vàng ở dưới phải!",
    },
    is_focus_word: false,
  };

  const memorySessionBase = {
    id: ids.memorySession1,
    child_id: ids.child1,
    child_grade: 2,
    theme_key: "sunny_garden",
    theme_name_vi: "Khu vườn nắng ấm",
    difficulty_level: 2,
    scene_seed: 42,
    timer_mode: "20S",
    timer_seconds: 20,
    recall_mode: "GUIDED_RECALL",
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
      theme_name_vi: "Khu vườn nắng ấm",
      child_grade: 2,
      difficulty_level: 2,
      scene_seed: 42,
      canvas_width: 800,
      canvas_height: 500,
      backdrop: {
        theme_key: "sunny_garden",
        sky_top_hex: "#E0F2FE",
        sky_bottom_hex: "#FEF9C3",
        horizon_hex: "#BBF7D0",
        ground_hex: "#86EFAC",
        accent_hex: "#F59E0B",
        mood_vi: "Buổi sáng trong lành đầy nắng ấm",
      },
      objects: [memoryCat, memoryFlower],
      observation_tips_vi: [
        "Nhìn từ góc dưới trái sang góc dưới phải để nhớ vị trí từng vật.",
      ],
      guided_questions_vi: [
        "Ở góc dưới trái có con vật gì màu cam?",
        "Ở góc dưới phải có mấy bông hoa màu vàng?",
      ],
      creative_prompt_vi:
        "Theo bé, chú mèo mướp sẽ rủ ai cùng chơi trốn tìm trong khu vườn?",
      matched_focus_words: ["mèo mướp"],
    },
    attempts: [],
    created_at: NOW,
    updated_at: NOW,
  };

  const pictureSessionBase = {
    session_id: ids.pictureSession1,
    child_id: ids.child1,
    child_grade: 2,
    source_type: "SAMPLE",
    sample_key: "sunny-garden",
    book_id: null,
    book_page_id: null,
    image_url: "/images/picture-description/sunny-garden.jpg",
    scene_title: "Khu vườn đầy nắng",
    status: "ACTIVE",
    best_stars: 0,
    best_score: 0,
    attempts_count: 0,
    teaching_mode: "OBSERVE",
    target_words: ["mèo mướp", "lấp lánh"],
    provider_tier: "GEMINI_PRIMARY",
    guide: {
      is_child_safe: true,
      scene_title: "Khu vườn đầy nắng",
      scene_summary: "Khu vườn tràn ngập ánh nắng với chú mèo mướp dễ thương.",
      guiding_questions: [
        "Trong khu vườn có những nhân vật hoặc con vật nào?",
        "Ánh nắng và hoa lá có màu sắc như thế nào?",
      ],
      suggested_vocabulary: [
        { word: "mèo mướp", hint: "Chú mèo có bộ lông vằn cam đáng yêu" },
        { word: "lấp lánh", hint: "Ánh nắng chiếu rực rỡ trên lá xanh" },
      ],
      model_sample_sentences: [
        "Trong khu vườn đầy nắng, chú mèo mướp đang nằm sưởi ấm bên khóm hoa vàng.",
      ],
      teaching_mode: "OBSERVE",
      target_words: ["mèo mướp", "lấp lánh"],
    },
    attempts: [],
    created_at: NOW,
    updated_at: NOW,
  };

  function makeCorsHeaders(route: Route): Record<string, string> {
    const reqOrigin = route.request().headers()["origin"] ?? E2E_SUITE_ORIGIN;
    return {
      "access-control-allow-origin": reqOrigin,
      "access-control-allow-headers":
        "authorization,content-type,accept,x-request-id",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-expose-headers":
        "x-tts-provider,x-tts-voice,x-tts-model,x-tts-cached,x-tts-speed,x-resolved-voice-id,x-voice-provider,x-voice-id,x-voice-locked,x-request-id",
    };
  }

  async function respondJson(
    route: Route,
    payload: unknown,
    status = 200,
  ): Promise<void> {
    await route.fulfill({
      status,
      headers: makeCorsHeaders(route),
      contentType: "application/json",
      body: status === 204 ? undefined : JSON.stringify(payload),
    });
  }

  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const rawUrl = request.url();
    if (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
      return route.continue();
    }

    const url = new URL(rawUrl);
    if (url.origin === E2E_SUITE_ORIGIN) {
      return route.continue();
    }

    // Supabase Auth mock
    if (url.hostname === "example.supabase.co") {
      const cors = {
        ...makeCorsHeaders(route),
        "access-control-allow-credentials": "true",
      };
      if (request.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: cors });
      }
      if (url.pathname === "/auth/v1/user") {
        return route.fulfill({
          status: 200,
          headers: cors,
          contentType: "application/json",
          body: JSON.stringify({
            id: ids.parent,
            aud: "authenticated",
            role: "authenticated",
            email: "parent@example.test",
            email_confirmed_at: NOW,
            app_metadata: { provider: "email", providers: ["email"] },
            user_metadata: { display_name: state.parentDisplayName },
            created_at: NOW,
            updated_at: NOW,
          }),
        });
      }
      if (url.pathname === "/auth/v1/token") {
        return route.fulfill({
          status: 200,
          headers: cors,
          contentType: "application/json",
          body: JSON.stringify({
            access_token: "mock-access-token",
            token_type: "bearer",
            expires_in: 3600,
            refresh_token: "mock-refresh-token",
            user: {
              id: ids.parent,
              aud: "authenticated",
              role: "authenticated",
              email: "parent@example.test",
              app_metadata: { provider: "email", providers: ["email"] },
              user_metadata: { display_name: state.parentDisplayName },
            },
          }),
        });
      }
      if (url.pathname === "/auth/v1/signup") {
        return route.fulfill({
          status: 200,
          headers: cors,
          contentType: "application/json",
          body: JSON.stringify({
            id: ids.parent,
            aud: "authenticated",
            role: "authenticated",
            email: "newparent@example.test",
            confirmation_sent_at: NOW,
          }),
        });
      }
      if (url.pathname === "/auth/v1/logout") {
        return route.fulfill({ status: 204, headers: cors });
      }
      if (url.pathname === "/auth/v1/recover" && request.method() === "POST") {
        return route.fulfill({
          status: 200,
          headers: cors,
          contentType: "application/json",
          body: JSON.stringify({}),
        });
      }
      state.unexpected.push(`supabase:${request.method()}:${url.pathname}`);
      return route.fulfill({ status: 404, headers: cors, body: "{}" });
    }

    // Synthetic karaoke audio media origin
    if (url.origin === "https://media.example.test") {
      if (request.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: makeCorsHeaders(route) });
      }
      const bytes = demo.mp3;
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2]
        ? Math.min(bytes.length - 1, Number(range[2]))
        : bytes.length - 1;
      return route.fulfill({
        status: range ? 206 : 200,
        contentType: "audio/mpeg",
        body: bytes.subarray(start, end + 1),
        headers: {
          "access-control-allow-origin": "*",
          "accept-ranges": "bytes",
          ...(range
            ? { "content-range": `bytes ${start}-${end}/${bytes.length}` }
            : {}),
        },
      });
    }

    if (url.origin !== API_ORIGIN) {
      state.unexpected.push(`external:${url.origin}${url.pathname}`);
      return route.abort();
    }

    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: makeCorsHeaders(route) });
    }

    const method = request.method().toUpperCase();
    const pathname = url.pathname;
    state.requests.push(`${method} ${pathname}${url.search}`);

    // 1. Static SVG test images
    if (pathname === "/test-page.svg" || pathname === "/reading-source.svg") {
      if (
        pathname === "/reading-source.svg" &&
        state.readingImageMode === "broken"
      ) {
        return route.fulfill({
          status: 403,
          headers: makeCorsHeaders(route),
        });
      }
      return route.fulfill({
        status: 200,
        headers: makeCorsHeaders(route),
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#fff9e8"/><path d="M0 520 Q300 320 600 520V800H0Z" fill="#d9f4eb"/><g font-size="36" font-family="sans-serif" fill="#233e40"><text x="48" y="190">Bé mèo đọc sách</text></g></svg>',
      });
    }

    if (pathname === "/health") {
      return respondJson(route, {
        status: "ok",
        ocr_mode: "remote_worker",
        ocr: { mode: "remote_worker", ready: true, workers: [], queue: {} },
      });
    }

    // Require Bearer auth on protected backend endpoints
    expect(
      request.headers().authorization,
      `Missing Bearer auth header on ${method} ${pathname}`,
    ).toMatch(/^Bearer /);

    // 2. Profiles & Dashboard Summary & Children
    if (pathname === "/profiles/dashboard-summary" && method === "GET") {
      const firstChild = state.children[0] as { id: string } | undefined;
      return respondJson(route, {
        profile: {
          id: ids.parent,
          role: "parent",
          display_name: state.parentDisplayName,
          created_at: NOW,
          email: "parent@example.test",
          contact_phone: "+84900000000",
          email_verified: true,
          contact_info_status: "available",
          avatar_url: null,
          children: state.children,
        },
        children: state.children,
        latest_sessions_by_child: firstChild
          ? {
              [firstChild.id]: {
                id: ids.session1,
                child_id: firstChild.id,
                book_id: ids.book1,
                book_title: defaultBooks[0].title,
                state: state.readingFinished ? "FINISHED" : "PAUSED",
                started_at: NOW,
                ended_at: state.readingFinished ? NOW : null,
                resumable: !state.readingFinished,
              },
            }
          : {},
      });
    }

    if (pathname === "/profiles/me" && method === "GET") {
      return respondJson(route, {
        id: ids.parent,
        role: "parent",
        display_name: state.parentDisplayName,
        created_at: NOW,
        email: "parent@example.test",
        contact_phone: "+84900000000",
        email_verified: true,
        contact_info_status: "available",
        avatar_url: null,
        children: state.children,
      });
    }

    if (
      (pathname === "/profiles/me" || pathname === `/profiles/${ids.parent}`) &&
      (method === "PATCH" || method === "PUT")
    ) {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      const rawName =
        typeof body.display_name === "string"
          ? body.display_name
          : typeof body.displayname === "string"
            ? body.displayname
            : "";
      if (rawName.trim()) {
        state.parentDisplayName = rawName.trim();
      }
      return respondJson(route, {
        id: ids.parent,
        role: "parent",
        display_name: state.parentDisplayName,
        created_at: NOW,
      });
    }

    if (pathname === "/profiles/children" && method === "GET") {
      return respondJson(route, state.children);
    }

    if (pathname === "/profiles/children" && method === "POST") {
      const body = request.postDataJSON() as {
        alias: string;
        grade: number;
        settings?: Record<string, unknown>;
      };
      const created = {
        id: `22222222-2222-4222-8222-${String(state.children.length + 10).padStart(12, "0")}`,
        parent_id: ids.parent,
        alias: body.alias,
        grade: body.grade,
        settings: body.settings ?? {},
        created_at: NOW,
        avatar_url: null,
      };
      state.children.push(created);
      return respondJson(route, created, 201);
    }

    const childDetailMatch = /^\/profiles\/children\/([^/]+)$/.exec(pathname);
    if (childDetailMatch) {
      const childId = decodeURIComponent(childDetailMatch[1]);
      const foundIndex = state.children.findIndex((c) => c.id === childId);
      if (method === "GET") {
        if (foundIndex < 0) return respondJson(route, {}, 404);
        return respondJson(route, state.children[foundIndex]);
      }
      if (method === "PUT" || method === "PATCH") {
        if (foundIndex < 0) return respondJson(route, {}, 404);
        const body = request.postDataJSON() as {
          alias?: string;
          grade?: number;
        };
        const updated = {
          ...state.children[foundIndex],
          ...(body.alias ? { alias: body.alias } : {}),
          ...(typeof body.grade === "number" ? { grade: body.grade } : {}),
        };
        state.children[foundIndex] = updated;
        return respondJson(route, updated);
      }
      if (method === "DELETE") {
        if (foundIndex < 0) return respondJson(route, {}, 404);
        state.children.splice(foundIndex, 1);
        return respondJson(route, null, 204);
      }
    }

    const childAvatarMatch = /^\/profiles\/children\/([^/]+)\/avatar$/.exec(
      pathname,
    );
    if (childAvatarMatch) {
      const childId = decodeURIComponent(childAvatarMatch[1]);
      const foundIndex = state.children.findIndex((c) => c.id === childId);
      if (foundIndex < 0) return respondJson(route, {}, 404);
      if (method === "POST") {
        const updated = {
          ...state.children[foundIndex],
          avatar_url: `${API_ORIGIN}/test-page.svg`,
        };
        state.children[foundIndex] = updated;
        return respondJson(route, updated);
      }
      if (method === "DELETE") {
        const updated = {
          ...state.children[foundIndex],
          avatar_url: null,
        };
        state.children[foundIndex] = updated;
        return respondJson(route, updated);
      }
    }

    if (pathname === "/support/feedback" && method === "POST") {
      return respondJson(route, {
        accepted: true,
        delivery_status: "accepted_by_smtp",
        detail: "Máy chủ email đã tiếp nhận phản hồi của ba mẹ.",
      });
    }

    // 3. Parent Notifications
    if (pathname === "/parent-notifications/preferences" && method === "GET") {
      return respondJson(route, emailPrefs);
    }
    if (
      pathname === "/parent-notifications/preferences" &&
      (method === "PUT" || method === "PATCH")
    ) {
      const patch = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      emailPrefs = { ...emailPrefs, ...patch, updated_at: NOW };
      return respondJson(route, emailPrefs);
    }
    if (pathname === "/parent-notifications/history" && method === "GET") {
      return respondJson(route, []);
    }

    // 4. Studio Tasks & Assets
    if (pathname === "/studio/tasks" && method === "GET") {
      return respondJson(route, {
        actor_id: ids.parent,
        actor_role: "parent",
        active_count: 0,
        waiting_review_count: 0,
        failed_count: 0,
        completed_count: 0,
        worker_online: true,
        recommended_poll_ms: null,
        tasks: [],
      });
    }
    const studioTaskActionMatch =
      /^\/studio\/tasks\/([^/]+)\/(retry|cancel)$/.exec(pathname);
    if (studioTaskActionMatch && method === "POST") {
      const jobId = decodeURIComponent(studioTaskActionMatch[1]);
      const action = studioTaskActionMatch[2];
      const nextStatus = action === "retry" ? "QUEUED" : "CANCELLED";
      return respondJson(route, {
        task: {
          id: jobId,
          source: "ocr_inference_job",
          job_type: "ocr_page_scan",
          title_vi: "Nhận diện trang sách",
          book_id: ids.privateBook1,
          book_page_id: ids.page1,
          book_title: "Truyện cổ tích gia đình",
          page_number: 1,
          source_revision_id: ids.revision1,
          actor_role: "parent",
          status: nextStatus,
          status_label_vi: action === "retry" ? "Đang chờ" : "Đã hủy",
          stage: action === "retry" ? "queued" : "cancelled",
          stage_label_vi: action === "retry" ? "Đang xếp hàng" : "Đã hủy",
          priority: 1,
          attempt_count: 1,
          max_attempts: 3,
          progress_completed: null,
          progress_total: null,
          progress_unit: null,
          progress_pct: null,
          is_indeterminate: true,
          can_retry: action !== "retry",
          can_cancel: action === "retry",
          result_href: `/my-books/${ids.privateBook1}`,
          result_ref: {},
          checkpoints: {},
          error_code: null,
          error_message_vi: null,
          created_at: NOW,
          updated_at: NOW,
          started_at: null,
          completed_at: action === "cancel" ? NOW : null,
        },
        action,
        deduplicated: false,
        message_vi:
          action === "retry"
            ? "Đã đưa tác vụ vào hàng chờ thử lại."
            : "Đã hủy tác vụ.",
      });
    }
    const studioCoverMatch =
      /^\/studio\/books\/([^/]+)\/cover(?:\/(upload|generate))?$/.exec(
        pathname,
      );
    if (studioCoverMatch) {
      const targetBookId = decodeURIComponent(studioCoverMatch[1]);
      const subAction = studioCoverMatch[2];
      const metadataFallback = {
        palette_id: "sky-blue",
        primary_color: "#087467",
        secondary_color: "#D9F4EB",
        accent_color: "#FFDB70",
        motif: "storybook",
        title: defaultBooks[0].title,
        author: defaultBooks[0].author,
        grade_label: "Lớp 1–3",
        source_type: "METADATA_RENDER" as const,
      };
      if (subAction === "upload" && method === "POST") {
        return respondJson(route, {
          id: ids.bookReport1,
          book_id: targetBookId,
          book_page_id: null,
          source_revision_id: null,
          asset_role: "COVER",
          source_type: "USER_UPLOAD",
          media_url: `${API_ORIGIN}/test-page.svg`,
          mime_type: "image/svg+xml",
          width: 600,
          height: 800,
          size_bytes: 1024,
          asset_hash: "mock-cover-hash",
          asset_version: 1,
          is_active: true,
          text_free_verified: true,
          moderation_status: "APPROVED",
          provider_name: null,
          model_id: null,
          job_id: null,
          metadata: {},
          created_at: NOW,
          updated_at: NOW,
        });
      }
      if (!subAction && method === "DELETE") {
        return respondJson(route, {
          book_id: targetBookId,
          removed_count: 1,
          metadata_fallback: metadataFallback,
          message_vi: "Đã xóa ảnh bìa tải lên.",
        });
      }
      if (subAction === "generate" && method === "POST") {
        return respondJson(route, {
          status: "BLOCKED_NO_IMAGE_PROVIDER",
          job_id: null,
          provider_name: null,
          model_id: null,
          message_vi: "Chưa cấu hình nhà cung cấp tạo ảnh AI miễn phí.",
          cover: null,
          metadata_fallback: metadataFallback,
          style_bible: null,
          honest_ai_generated: false,
        });
      }
    }
    if (/^\/studio\/books\/[^/]+\/assets$/.test(pathname) && method === "GET") {
      return respondJson(route, {
        book_id: ids.book1,
        title: defaultBooks[0].title,
        author: defaultBooks[0].author,
        min_grade: 1,
        max_grade: 3,
        visibility_scope: "CATALOG",
        active_cover: null,
        effective_cover_source: "METADATA_RENDER",
        metadata_fallback: {
          palette_id: "sky-blue",
          primary_color: "#087467",
          secondary_color: "#D9F4EB",
          accent_color: "#FFDB70",
          motif: "storybook",
          title: defaultBooks[0].title,
          author: defaultBooks[0].author,
          grade_label: "Lớp 1–3",
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
    }

    // 5. Books Catalog & My Books
    if (pathname === "/books/catalog" && method === "GET") {
      if (state.catalogStatus !== 200) {
        return respondJson(
          route,
          { detail: "Catalog error" },
          state.catalogStatus,
        );
      }
      const search =
        url.searchParams.get("search")?.trim().toLocaleLowerCase("vi") ?? "";
      const gradeParam = url.searchParams.get("grade");
      const grade = gradeParam ? Number(gradeParam) : null;
      const filtered = defaultBooks.filter((b) => {
        const matchesGrade =
          grade === null ||
          !Number.isFinite(grade) ||
          (b.min_grade <= grade && b.max_grade >= grade);
        const matchesSearch =
          !search ||
          `${b.title} ${b.author ?? ""}`
            .toLocaleLowerCase("vi")
            .includes(search);
        return matchesGrade && matchesSearch;
      });
      return respondJson(route, filtered);
    }

    const bookDetailMatch = /^\/books\/catalog\/([^/]+)$/.exec(pathname);
    if (bookDetailMatch && method === "GET") {
      const targetId = decodeURIComponent(bookDetailMatch[1]);
      const found = defaultBooks.find((b) => b.id === targetId);
      if (!found) return respondJson(route, { detail: "Not found" }, 404);
      return respondJson(route, found);
    }

    const bookPreviewMatch = /^\/books\/catalog\/([^/]+)\/preview$/.exec(
      pathname,
    );
    if (bookPreviewMatch && method === "GET") {
      const targetId = decodeURIComponent(bookPreviewMatch[1]);
      const found = defaultBooks.find((b) => b.id === targetId);
      if (!found) return respondJson(route, [], 404);
      return respondJson(route, [
        {
          page_id: ids.page1,
          page_number: 1,
          lifecycle_status: "ACTIVE",
          current_verified_revision_id: ids.revision1,
          preview_url: `${API_ORIGIN}/test-page.svg`,
        },
        {
          page_id: ids.page2,
          page_number: 2,
          lifecycle_status: "ACTIVE",
          current_verified_revision_id: ids.revision2,
          preview_url: `${API_ORIGIN}/test-page.svg`,
        },
      ]);
    }

    if (pathname === "/books/reports/mine" && method === "GET") {
      return respondJson(route, {
        items: [],
        total: 0,
        limit: Number(url.searchParams.get("limit") ?? 20),
        offset: Number(url.searchParams.get("offset") ?? 0),
      });
    }
    const bookReportDetailMatch = /^\/books\/reports\/mine\/([^/]+)$/.exec(
      pathname,
    );
    if (bookReportDetailMatch && method === "GET") {
      const targetReportId = decodeURIComponent(bookReportDetailMatch[1]);
      return respondJson(route, {
        id: targetReportId,
        book_id: ids.book1,
        book_title: defaultBooks[0].title,
        reporter_id: ids.parent,
        reporter_name: state.parentDisplayName,
        page_id: ids.page1,
        page_number: 1,
        page_revision_id: ids.revision1,
        issue_type: "SPELLING_ERROR",
        description: "Kiểm tra chính tả trang 1",
        reported_text: "Bé mèo",
        suggested_correction: "Bé mèo",
        status: "OPEN",
        scan_run_id: null,
        verified_text_snapshot: "Bé mèo đọc sách",
        content_hash_snapshot: "mock-hash",
        admin_resolution_note: null,
        reviewed_by: null,
        reviewed_by_name: null,
        resolved_at: null,
        history: [],
        related_findings: [],
        created_at: NOW,
        updated_at: NOW,
      });
    }

    if (pathname === "/books/my-books/paged" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "9");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      return respondJson(route, {
        items: state.privateBooks.slice(offset, offset + limit),
        total: state.privateBooks.length,
        limit,
        offset,
      });
    }

    if (pathname === "/books/my-books" && method === "GET") {
      return respondJson(route, state.privateBooks);
    }

    if (pathname === "/books/my-books" && method === "POST") {
      const body = request.postDataJSON() as {
        title: string;
        author?: string | null;
        min_grade: number;
        max_grade: number;
        source_type: string;
        source_note?: string | null;
      };
      const newBook = {
        id: `aa000000-0000-4000-8000-${String(state.privateBooks.length + 1).padStart(12, "0")}`,
        title: body.title,
        author: body.author ?? null,
        min_grade: body.min_grade,
        max_grade: body.max_grade,
        lifecycle_status: "ACTIVE",
        visibility_scope: "PARENT_PRIVATE",
        moderation_status: "ACTIVE",
        suspended_reason: null,
        source_declaration: `[${body.source_type}] ${body.source_note ?? "Sách gia đình"}`,
        committed_page_count: 0,
        pending_submission_count: 0,
        flagged_submission_count: 0,
        failed_submission_count: 0,
        ready_to_add_count: 0,
        readable_for_children: false,
        has_held_multipage_batch: false,
        privacy_notice: "Chỉ bạn và các hồ sơ trẻ của bạn có thể đọc sách này.",
        created_at: NOW,
      };
      state.privateBooks.unshift(newBook);
      return respondJson(route, newBook, 201);
    }

    const myBookDetailMatch = /^\/books\/my-books\/([^/]+)$/.exec(pathname);
    if (myBookDetailMatch) {
      const targetId = decodeURIComponent(myBookDetailMatch[1]);
      const idx = state.privateBooks.findIndex((b) => b.id === targetId);
      if (method === "GET") {
        if (idx < 0) return respondJson(route, { detail: "Not found" }, 404);
        return respondJson(route, {
          book: state.privateBooks[idx],
          pages: [],
          submissions: [],
        });
      }
      if (method === "PATCH") {
        if (idx < 0) return respondJson(route, { detail: "Not found" }, 404);
        const patch = (request.postDataJSON() ?? {}) as Record<string, unknown>;
        state.privateBooks[idx] = { ...state.privateBooks[idx], ...patch };
        return respondJson(route, state.privateBooks[idx]);
      }
      if (method === "DELETE") {
        if (idx < 0) return respondJson(route, { detail: "Not found" }, 404);
        state.privateBooks.splice(idx, 1);
        return respondJson(route, {
          status: "deleted",
          book_id: targetId,
          retired_pages_count: 0,
          cancelled_submissions_count: 0,
        });
      }
    }

    // 6. Reading Management (Goals, Plans, Collections, Reminders)
    if (pathname === "/reading-management/goals") {
      if (method === "GET") {
        const reqChild = url.searchParams.get("child_id");
        return respondJson(
          route,
          state.goals.filter((g) => !reqChild || g.child_id === reqChild),
        );
      }
      if (method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        const newGoal = {
          id: `77777777-7777-4777-8777-${String(state.goals.length + 10).padStart(12, "0")}`,
          child_id: (body.child_id as string) ?? ids.child1,
          metric: (body.metric as string) ?? "MINUTES",
          target_value: Number(body.target_value ?? 20),
          period: (body.period as string) ?? "DAILY",
          starts_on: (body.starts_on as string) ?? "2026-11-15",
          ends_on: (body.ends_on as string | null) ?? null,
          timezone: (body.timezone as string) ?? "Asia/Ho_Chi_Minh",
          status: "ACTIVE",
          current_value: 0,
          progress_percent: 0,
          created_at: NOW,
          updated_at: NOW,
          phase: "RUNNING",
          streak_cycles: 0,
          cycle_starts_on: "2026-11-15",
          cycle_ends_on: "2026-11-15",
        };
        state.goals.unshift(newGoal);
        return respondJson(route, newGoal, 201);
      }
    }

    const goalDetailMatch = /^\/reading-management\/goals\/([^/]+)$/.exec(
      pathname,
    );
    if (goalDetailMatch && method === "PATCH") {
      const targetId = decodeURIComponent(goalDetailMatch[1]);
      const idx = state.goals.findIndex((g) => g.id === targetId);
      if (idx < 0) return respondJson(route, { detail: "Not found" }, 404);
      const patch = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      const updated = {
        ...state.goals[idx],
        ...(typeof patch.target_value === "number"
          ? { target_value: patch.target_value }
          : {}),
        ...(patch.ends_on !== undefined ? { ends_on: patch.ends_on } : {}),
        updated_at: NOW,
      };
      state.goals[idx] = updated;
      return respondJson(route, updated);
    }

    const goalTransitionMatch =
      /^\/reading-management\/goals\/([^/]+)\/transition$/.exec(pathname);
    if (goalTransitionMatch && method === "POST") {
      const targetId = decodeURIComponent(goalTransitionMatch[1]);
      const idx = state.goals.findIndex((g) => g.id === targetId);
      if (idx < 0) return respondJson(route, { detail: "Not found" }, 404);
      const body = (request.postDataJSON() ?? {}) as { status?: string };
      const nextStatus = body.status ?? "ACTIVE";
      const updated = {
        ...state.goals[idx],
        status: nextStatus,
        completed_at: nextStatus === "COMPLETED" ? NOW : null,
        phase:
          nextStatus === "COMPLETED" || nextStatus === "ENDED"
            ? "FINISHED"
            : "RUNNING",
        updated_at: NOW,
      };
      state.goals[idx] = updated;
      return respondJson(route, updated);
    }

    if (pathname === "/reading-management/plans") {
      if (method === "GET") {
        const reqChild = url.searchParams.get("child_id");
        return respondJson(
          route,
          state.plans.filter((p) => !reqChild || p.child_id === reqChild),
        );
      }
      if (method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        const newPlan = {
          id: `66666666-6666-4666-8666-${String(state.plans.length + 10).padStart(12, "0")}`,
          child_id: (body.child_id as string) ?? ids.child1,
          book_id: (body.book_id as string | null) ?? null,
          book_title: null,
          title: (body.title as string) ?? "Kế hoạch mới",
          target_minutes: Number(body.target_minutes ?? 15),
          weekdays: (body.weekdays as number[]) ?? [0, 2, 4],
          starts_on: (body.starts_on as string) ?? "2026-11-15",
          ends_on: (body.ends_on as string | null) ?? null,
          timezone: (body.timezone as string) ?? "Asia/Ho_Chi_Minh",
          status: "ACTIVE",
          scheduled_days_this_week: 3,
          completed_days_this_week: 0,
          progress_percent: 0,
          completed_at: null,
          created_at: NOW,
          updated_at: NOW,
          phase: "RUNNING",
          next_scheduled_date: "2026-11-16",
          is_scheduled_today: true,
          minutes_today: 0,
        };
        state.plans.unshift(newPlan);
        return respondJson(route, newPlan, 201);
      }
    }

    const planDetailMatch = /^\/reading-management\/plans\/([^/]+)$/.exec(
      pathname,
    );
    if (planDetailMatch && method === "PATCH") {
      const targetId = decodeURIComponent(planDetailMatch[1]);
      const idx = state.plans.findIndex((p) => p.id === targetId);
      if (idx < 0) return respondJson(route, { detail: "Not found" }, 404);
      const patch = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      const updated = {
        ...state.plans[idx],
        ...patch,
        updated_at: NOW,
      };
      state.plans[idx] = updated;
      return respondJson(route, updated);
    }

    const planTransitionMatch =
      /^\/reading-management\/plans\/([^/]+)\/transition$/.exec(pathname);
    if (planTransitionMatch && method === "POST") {
      const targetId = decodeURIComponent(planTransitionMatch[1]);
      const idx = state.plans.findIndex((p) => p.id === targetId);
      if (idx < 0) return respondJson(route, { detail: "Not found" }, 404);
      const body = (request.postDataJSON() ?? {}) as { status?: string };
      const nextStatus = body.status ?? "ACTIVE";
      const updated = {
        ...state.plans[idx],
        status: nextStatus,
        completed_at: nextStatus === "COMPLETED" ? NOW : null,
        phase:
          nextStatus === "COMPLETED" || nextStatus === "ENDED"
            ? "FINISHED"
            : "RUNNING",
        updated_at: NOW,
      };
      state.plans[idx] = updated;
      return respondJson(route, updated);
    }

    if (pathname === "/reading-management/collections" && method === "GET") {
      const reqChild = url.searchParams.get("child_id");
      return respondJson(
        route,
        state.collections.filter((c) => !reqChild || c.child_id === reqChild),
      );
    }

    const collectionBookMatch =
      /^\/reading-management\/collections\/([^/]+)$/.exec(pathname);
    if (collectionBookMatch) {
      const bookId = decodeURIComponent(collectionBookMatch[1]);
      if (method === "PUT") {
        const body = request.postDataJSON() as {
          child_id: string;
          collection_type: "FAVORITE" | "WANT_TO_READ";
        };
        const targetBook =
          defaultBooks.find((b) => b.id === bookId) ?? defaultBooks[0];
        const existing = state.collections.find(
          (c) =>
            c.child_id === body.child_id &&
            c.book_id === bookId &&
            c.collection_type === body.collection_type,
        );
        if (existing) {
          return respondJson(route, existing, 200);
        }
        const created = {
          id: `88888888-8888-4888-8888-${String(state.collections.length + 10).padStart(12, "0")}`,
          child_id: body.child_id,
          book_id: bookId,
          collection_type: body.collection_type,
          created_at: NOW,
          book: {
            id: targetBook.id,
            title: targetBook.title,
            author: targetBook.author,
            min_grade: targetBook.min_grade,
            max_grade: targetBook.max_grade,
            lifecycle_status: "ACTIVE",
            available_to_read: true,
          },
        };
        state.collections.push(created);
        return respondJson(route, created, 200);
      }
      if (method === "DELETE") {
        const reqChild = url.searchParams.get("child_id");
        const reqType = url.searchParams.get("collection_type");
        state.collections = state.collections.filter(
          (c) =>
            !(
              c.child_id === reqChild &&
              c.book_id === bookId &&
              (!reqType || c.collection_type === reqType)
            ),
        );
        return respondJson(route, { deleted: true });
      }
    }

    const occAckMatch =
      /^\/reading-management\/reminders\/occurrences\/([^/]+)\/acknowledge$/.exec(
        pathname,
      );
    if (occAckMatch && method === "POST") {
      const occId = decodeURIComponent(occAckMatch[1]);
      const activeRem = state.reminders[0] ?? null;
      return respondJson(route, {
        id: occId,
        reminder_id: activeRem ? (activeRem.id as string) : ids.reminder1,
        scheduled_local_date: "2026-11-15",
        scheduled_for: NOW,
        status: "ACKNOWLEDGED",
        acknowledged_at: NOW,
        email_status: "NOT_REQUESTED",
        email_attempts: 0,
        email_sent_at: null,
        email_error_code: null,
        reminder: activeRem,
      });
    }

    if (pathname === "/reading-management/reminders/due" && method === "GET") {
      const reqChild = url.searchParams.get("child_id");
      if (reqChild && reqChild !== ids.child1) return respondJson(route, []);
      const activeRem = state.reminders[0];
      if (!activeRem) return respondJson(route, []);
      return respondJson(route, [
        {
          id: ids.occurrence1,
          reminder_id: activeRem.id,
          scheduled_local_date: "2026-11-15",
          scheduled_for: NOW,
          status: "PENDING",
          acknowledged_at: null,
          email_status: "NOT_REQUESTED",
          email_attempts: 0,
          email_sent_at: null,
          email_error_code: null,
          reminder: activeRem,
        },
      ]);
    }

    if (pathname === "/reading-management/reminders") {
      if (method === "GET") {
        const reqChild = url.searchParams.get("child_id");
        return respondJson(
          route,
          state.reminders.filter((r) => !reqChild || r.child_id === reqChild),
        );
      }
      if (method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        const created = {
          id: `55555555-5555-4555-8555-${String(state.reminders.length + 10).padStart(12, "0")}`,
          child_id: (body.child_id as string) ?? ids.child1,
          remind_at: (body.remind_at as string) ?? "20:00:00",
          weekdays: (body.weekdays as number[]) ?? [0, 2, 4],
          timezone: (body.timezone as string) ?? "Asia/Ho_Chi_Minh",
          is_active: true,
          email_enabled: Boolean(body.email_enabled ?? false),
          deleted_at: null,
          created_at: NOW,
          updated_at: NOW,
        };
        state.reminders.unshift(created);
        return respondJson(route, created, 201);
      }
    }

    const remMatch = /^\/reading-management\/reminders\/([^/]+)$/.exec(
      pathname,
    );
    if (remMatch) {
      const remId = decodeURIComponent(remMatch[1]);
      if (method === "PATCH") {
        const patch = (request.postDataJSON() ?? {}) as Record<string, unknown>;
        state.reminders = state.reminders.map((r) =>
          r.id === remId ? { ...r, ...patch, updated_at: NOW } : r,
        );
        return respondJson(
          route,
          state.reminders.find((r) => r.id === remId) ?? {},
        );
      }
      if (method === "DELETE") {
        state.reminders = state.reminders.filter((r) => r.id !== remId);
        return respondJson(route, { deleted: true });
      }
    }

    // 7. Reading Presence
    if (pathname === "/reading-presence/settings") {
      return respondJson(route, { email_enabled: false, updated_at: NOW });
    }
    if (pathname.startsWith("/reading-presence/")) {
      return respondJson(route, { ok: true, cancelled: 0 });
    }

    // 8. Reading Sessions, Pages, Practice-State, Events, Compare, History
    if (pathname === "/reading/sessions" && method === "POST") {
      // CRITICAL: POST /reading/sessions returns PascalCase DTO!
      return respondJson(
        route,
        {
          Id: ids.session1,
          State: "IN_PROGRESS",
          SelectedPageId: ids.page1,
          SelectedPageRevisionId: ids.revision1,
          StartedAt: NOW,
        },
        201,
      );
    }

    const sessionBaseMatch = /^\/reading\/sessions\/([^/]+)$/.exec(pathname);
    if (sessionBaseMatch && method === "GET") {
      const sid = decodeURIComponent(sessionBaseMatch[1]);
      return respondJson(route, {
        id: sid,
        child_id: ids.child1,
        book_id: ids.book1,
        state: state.readingFinished ? "FINISHED" : "PAGE_READY",
        started_at: NOW,
        ended_at: state.readingFinished ? NOW : null,
        duration_ms: state.readingFinished ? 60000 : null,
      });
    }

    const sessionSubMatch = /^\/reading\/sessions\/([^/]+)\/(.+)$/.exec(
      pathname,
    );
    if (sessionSubMatch) {
      const sid = decodeURIComponent(sessionSubMatch[1]);
      const subPath = sessionSubMatch[2];

      if (subPath === "page" && method === "GET") {
        const pageNum = currentPageId === ids.page2 ? 2 : 1;
        const pageRev =
          currentPageId === ids.page2 ? ids.revision2 : ids.revision1;
        return respondJson(route, {
          page_id: currentPageId,
          page_revision_id: pageRev,
          page_number: pageNum,
          confidence: null,
          width: 600,
          height: 800,
          image_overlay_safe: true,
          image_url:
            state.readingImageMode === "missing"
              ? null
              : `${API_ORIGIN}/reading-source.svg`,
          text: readingWords.map((w) => w.text).join(" "),
          words: readingWords,
        });
      }

      if (subPath === "navigate" && method === "POST") {
        const body = request.postDataJSON() as { target_page_id?: string };
        if (body.target_page_id === ids.page2) {
          currentPageId = ids.page2;
        } else if (body.target_page_id === ids.page1) {
          currentPageId = ids.page1;
        }
      }

      const completePageMatch = /^pages\/([^/]+)\/complete$/.exec(subPath);
      if (completePageMatch && method === "POST") {
        completedPageIds.add(decodeURIComponent(completePageMatch[1]));
      }

      if (
        subPath === "progress" ||
        subPath === "navigate" ||
        completePageMatch
      ) {
        return respondJson(route, {
          session_id: sid,
          persisted: true,
          start_page_id: ids.page1,
          end_page_id: ids.page2,
          current_page_id: currentPageId,
          start_page_number: 1,
          end_page_number: 2,
          current_page_number: currentPageId === ids.page2 ? 2 : 1,
          current_index: currentPageId === ids.page2 ? 1 : 0,
          total_pages: 2,
          completed_pages: completedPageIds.size,
          pages: [
            {
              page_id: ids.page1,
              page_revision_id: ids.revision1,
              page_number: 1,
              page_order: 0,
              status: completedPageIds.has(ids.page1)
                ? "COMPLETED"
                : "IN_PROGRESS",
              started_at: NOW,
              completed_at: completedPageIds.has(ids.page1) ? NOW : null,
            },
            {
              page_id: ids.page2,
              page_revision_id: ids.revision2,
              page_number: 2,
              page_order: 1,
              status: completedPageIds.has(ids.page2) ? "COMPLETED" : "PENDING",
              started_at: currentPageId === ids.page2 ? NOW : null,
              completed_at: completedPageIds.has(ids.page2) ? NOW : null,
            },
          ],
        });
      }

      if (subPath === "practice-state" && method === "GET") {
        if (!options.restoredPracticeState) {
          return respondJson(route, {
            session_id: sid,
            legacy_evidence_present: false,
            pages: [],
            words: [],
          });
        }
        const targetWord = readingWords[1];
        const initialAssessment = readingWords.slice(0, 3).map((w, idx) => ({
          word_id: w.word_id,
          word_index: w.word_index,
          text: w.text,
          status: idx === 1 ? "MISPRONUNCIATION" : "CORRECT",
        }));
        return respondJson(route, {
          session_id: sid,
          legacy_evidence_present: false,
          pages: [
            {
              page_id: ids.page1,
              page_revision_id: ids.revision1,
              page_number: 1,
              transcript: "Bé chó đọc",
              initial_assessment: initialAssessment,
            },
          ],
          words: [
            {
              page_id: ids.page1,
              page_revision_id: ids.revision1,
              word_id: targetWord.word_id,
              retry_attempt_count: 1,
              incorrect_retry_count: 1,
              resolution_status: "RETRYING",
            },
          ],
        });
      }

      if (subPath === "completion-summary" && method === "GET") {
        return respondJson(route, {
          assessment: state.readingFinished
            ? {
                first_pass_correct: 3,
                first_pass_incorrect: 1,
                self_corrected_words: 1,
                unresolved_words: 0,
                retry_attempts: 1,
                skipped_after_retry_limit: 0,
                recognition_uncertain: 0,
              }
            : null,
          duration_minutes: state.readingFinished ? 2 : null,
          pages_explored: state.readingFinished ? 1 : 0,
          selected_range_pages: 2,
          practiced_words: state.readingFinished ? 4 : 0,
          score: state.readingFinished ? 85 : null,
          correct_words: state.readingFinished ? ["Bé", "đọc", "sách"] : [],
          mispronounced_words: state.readingFinished ? ["mèo"] : [],
          skipped_words: [],
          transcripts: state.readingFinished ? ["Bé mèo đọc sách"] : [],
          spoken_words: state.readingFinished
            ? ["Bé", "mèo", "đọc", "sách"]
            : [],
        });
      }

      if (subPath === "finish" && method === "POST") {
        state.readingFinished = true;
        return respondJson(route, {
          id: sid,
          child_id: ids.child1,
          book_id: ids.book1,
          state: "FINISHED",
          started_at: NOW,
          ended_at: NOW,
          duration_ms: 60000,
        });
      }

      if (subPath === "reports" && method === "GET") {
        if (!options.populatedSessionReports || sessionReportDeleted) {
          return respondJson(route, {
            session_id: sid,
            total: 0,
            reports: [],
          });
        }
        return respondJson(route, {
          assessment: {
            first_pass_correct: Math.max(0, readingWords.length - 1),
            first_pass_incorrect: 1,
            self_corrected_words: 1,
            unresolved_words: 0,
            retry_attempts: 1,
            skipped_after_retry_limit: 0,
            recognition_uncertain: 0,
          },
          session_id: sid,
          total: 1,
          reports: [
            {
              report_id: ids.report1,
              created_at: NOW,
              page_id: ids.page1,
              page_revision_id: ids.revision1,
              transcript: readingWords.map((w) => w.text).join(" "),
              distance: 0,
              alignment: readingWords.map((w) => ({
                book_word: w.text,
                spoken_word: w.text,
                book_index: w.word_index,
                spoken_index: w.word_index,
                status: "MATCH",
              })),
              summary: {
                assessment_version: 1,
                initial_assessment: readingWords.map((w, idx) => ({
                  word_id: w.word_id,
                  word_index: w.word_index,
                  text: w.text,
                  status: idx === 1 ? "MISPRONUNCIATION" : "CORRECT",
                })),
                missing_words: [],
                extra_words: [],
                substitutions: [],
                repeated_count: 0,
                repeated_words: [],
                hesitations: [],
                hesitation_seconds: null,
              },
              self_corrected_word_ids: readingWords[1]
                ? [readingWords[1].word_id]
                : [],
            },
          ],
        });
      }

      if (subPath === "compare" && method === "POST") {
        const body = (request.postDataJSON() ?? {}) as {
          initial_assessment?: Array<{ word_id: string; status: string }>;
        };
        const submitted = body.initial_assessment ?? [];
        const initialAssessment = readingWords.map((w) => ({
          ...w,
          status:
            submitted.find((item) => item.word_id === w.word_id)?.status ??
            "CORRECT",
        }));
        return respondJson(route, {
          session_id: sid,
          report_id: ids.report1,
          created_at: NOW,
          page_id: currentPageId,
          page_revision_id: ids.revision1,
          transcript: "Bé mèo đọc sách",
          distance: 0,
          alignment: readingWords.map((w) => ({
            book_word: w.text,
            spoken_word: w.text,
            book_index: w.word_index,
            spoken_index: w.word_index,
            status: "MATCH",
          })),
          summary: {
            assessment_version: 1,
            initial_assessment: initialAssessment,
            missing_words: [],
            extra_words: [],
            substitutions: [],
            repeated_count: 0,
            repeated_words: [],
            hesitations: [],
            hesitation_seconds: null,
          },
        });
      }
    }

    const readingPageByIdMatch = /^\/reading\/pages\/([^/]+)$/.exec(pathname);
    if (readingPageByIdMatch && method === "GET") {
      const targetPageId = decodeURIComponent(readingPageByIdMatch[1]);
      const revId =
        url.searchParams.get("revision_id") ??
        (targetPageId === ids.page2 ? ids.revision2 : ids.revision1);
      return respondJson(route, {
        page_id: targetPageId,
        page_revision_id: revId,
        page_number: targetPageId === ids.page2 ? 2 : 1,
        confidence: 0.95,
        width: 600,
        height: 800,
        image_url:
          state.readingImageMode === "missing"
            ? null
            : `${API_ORIGIN}/reading-source.svg`,
        text: readingWords.map((w) => w.text).join(" "),
        words: readingWords,
      });
    }

    const deleteReportMatch = /^\/reading\/reports\/([^/]+)$/.exec(pathname);
    if (deleteReportMatch && method === "DELETE") {
      sessionReportDeleted = true;
      return respondJson(route, { deleted: true });
    }

    if (pathname === "/reading/scan-page-ocr/jobs") {
      if (method === "GET") {
        return respondJson(route, {
          worker_online: true,
          jobs: ocrScanJobs,
        });
      }
      if (method === "POST") {
        const job = {
          job_id: ids.ocrJob1,
          status: "QUEUED",
          worker_online: true,
          created_at: NOW,
          updated_at: NOW,
          file_name: "book-page.jpg",
          queue_position: 1,
          error_code: null,
          error_message: null,
          result: null,
        };
        ocrScanJobs.unshift(job);
        return respondJson(route, job, 201);
      }
    }

    const ocrJobMatch = /^\/reading\/scan-page-ocr\/jobs\/([^/]+)$/.exec(
      pathname,
    );
    if (ocrJobMatch) {
      const jobId = decodeURIComponent(ocrJobMatch[1]);
      const found = ocrScanJobs.find((j) => j.job_id === jobId);
      if (method === "GET") {
        if (!found) {
          return respondJson(route, { detail: "Job not found" }, 404);
        }
        return respondJson(route, {
          ...found,
          status: "SUCCEEDED",
          updated_at: NOW,
          result: {
            scan_job_id: jobId,
            request_id: ids.ocrJob1,
            idempotency_key: null,
            status: "SUCCEEDED",
            ocr_text: readingWords.map((w) => w.text).join(" "),
            word_count: readingWords.length,
            words: readingWords.map((w) => ({
              word_index: w.word_index,
              line_index: w.line_index,
              text: w.text,
              normalized_text: w.text.toLocaleLowerCase("vi"),
              bbox: w.bbox,
              ocr_confidence: 0.96,
            })),
            provenance: {
              engine: "vietocr",
              device: "cpu",
              engine_statuses: { vietocr: "ready" },
              model_profile: "default",
              checkpoint_sha256: null,
              model_load_status: "loaded",
              cloud_ocr_used: false,
              elapsed_ms: 120,
            },
            matched: true,
            matched_book_id: ids.book1,
            matched_book_title: defaultBooks[0].title,
            match_confidence: 0.96,
            matched_page: {
              page_id: ids.page1,
              page_revision_id: ids.revision1,
              page_number: 1,
              confidence: 0.96,
              width: 600,
              height: 800,
              image_overlay_safe: true,
              image_url: `${API_ORIGIN}/reading-source.svg`,
              text: readingWords.map((w) => w.text).join(" "),
              words: readingWords,
            },
            message: "Đã nhận diện trang sách.",
          },
        });
      }
      if (method === "DELETE") {
        const updated = {
          ...(found ?? {
            job_id: jobId,
            worker_online: true,
            created_at: NOW,
            file_name: "book-page.jpg",
          }),
          status: "CANCELLED",
          updated_at: NOW,
        };
        return respondJson(route, updated);
      }
    }

    if (pathname === "/reading/scan-page-ocr" && method === "POST") {
      return respondJson(route, {
        scan_job_id: ids.ocrJob1,
        request_id: ids.ocrJob1,
        idempotency_key: null,
        status: "SUCCEEDED",
        ocr_text: readingWords.map((w) => w.text).join(" "),
        word_count: readingWords.length,
        words: readingWords.map((w) => ({
          word_index: w.word_index,
          line_index: w.line_index,
          text: w.text,
          normalized_text: w.text.toLocaleLowerCase("vi"),
          bbox: w.bbox,
          ocr_confidence: 0.96,
        })),
        provenance: {
          engine: "vietocr",
          device: "cpu",
          engine_statuses: { vietocr: "ready" },
          model_profile: "default",
          checkpoint_sha256: null,
          model_load_status: "loaded",
          cloud_ocr_used: false,
          elapsed_ms: 120,
        },
        matched: true,
        matched_book_id: ids.book1,
        matched_book_title: defaultBooks[0].title,
        match_confidence: 0.96,
        matched_page: {
          page_id: ids.page1,
          page_revision_id: ids.revision1,
          page_number: 1,
          confidence: 0.96,
          width: 600,
          height: 800,
          image_overlay_safe: true,
          image_url: `${API_ORIGIN}/reading-source.svg`,
          text: readingWords.map((w) => w.text).join(" "),
          words: readingWords,
        },
        message: "Đã nhận diện trang sách.",
      });
    }

    if (
      (pathname === "/reading/match-page" ||
        /^\/reading\/books\/([^/]+)\/match-page$/.test(pathname)) &&
      method === "POST"
    ) {
      return respondJson(route, {
        framing_valid: true,
        matched: true,
        book_id: ids.book1,
        status_code: "MATCHED",
        message: "Đã nhận diện trang sách.",
        confidence: 0.96,
        matched_page: {
          page_id: ids.page1,
          page_revision_id: ids.revision1,
          page_number: 1,
          confidence: 0.96,
          width: 600,
          height: 800,
          image_overlay_safe: true,
          image_url: `${API_ORIGIN}/reading-source.svg`,
          text: readingWords.map((w) => w.text).join(" "),
          words: readingWords,
        },
      });
    }

    if (pathname === "/reading/events" && method === "POST") {
      const event = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      state.readingEvents.push(event);
      return respondJson(
        route,
        {
          ...event,
          Id: ids.draftRevision,
          Confidence: null,
          CreatedAt: NOW,
        },
        201,
      );
    }

    if (pathname === "/reading/history" && method === "GET") {
      const cursor = url.searchParams.get("cursor");
      const reqChild = url.searchParams.get("child_id") ?? ids.child1;
      if (cursor === "page-2") {
        return respondJson(route, {
          sessions: [
            {
              id: ids.session2,
              child_id: reqChild,
              book_id: ids.book2,
              state: "FINISHED",
              started_at: "2026-11-10T08:00:00Z",
              ended_at: "2026-11-10T08:12:00Z",
              duration_ms: 720000,
            },
          ],
          next_cursor: null,
        });
      }
      return respondJson(route, {
        sessions: [
          {
            id: ids.session1,
            child_id: reqChild,
            book_id: ids.book1,
            state: "FINISHED",
            started_at: NOW,
            ended_at: "2026-11-15T08:10:00Z",
            duration_ms: 600000,
          },
        ],
        next_cursor: "page-2",
      });
    }

    const historyBookMatch = /^\/reading\/history\/([^/]+)\/book$/.exec(
      pathname,
    );
    if (historyBookMatch && method === "GET") {
      const sid = decodeURIComponent(historyBookMatch[1]);
      const targetBook =
        sid === ids.session2 ? defaultBooks[1] : defaultBooks[0];
      return respondJson(route, targetBook);
    }

    const historyDetailMatch = /^\/reading\/history\/([^/]+)$/.exec(pathname);
    if (historyDetailMatch && method === "GET") {
      const sid = decodeURIComponent(historyDetailMatch[1]);
      const targetBook =
        sid === ids.session2 ? defaultBooks[1] : defaultBooks[0];
      return respondJson(route, {
        id: sid,
        child_id: ids.child1,
        book_id: targetBook.id,
        state: "FINISHED",
        started_at: NOW,
        ended_at: "2026-11-15T08:10:00Z",
        duration_ms: 600000,
        selected_range_pages: 2,
        pages_completed: 2,
        selected_page_revision_ids: [ids.revision1],
        reference_page_revision_ids: [ids.revision1],
        events: [],
        fluency_assessment: null,
        comprehension: [],
        report_id: null,
        availability: {
          events: "absent",
          fluency: "absent",
          comprehension: "absent",
        },
      });
    }

    // 9. Voice & TTS / STT
    if (pathname === "/voice/status" && method === "GET") {
      return respondJson(route, readyVoiceStatus("Binh"));
    }
    if (pathname === "/voice/voices" && method === "GET") {
      return respondJson(route, {
        default_voice_id: "Binh",
        local_worker_ready: true,
        cached_voice_ids: ["Binh", "Mai", "Nam"],
        voices: [
          {
            voice_id: "Binh",
            name: "Cô Bình - Giọng Bắc dịu dàng",
            gender: "female",
            region: "north",
            region_label: "Miền Bắc",
            age: "young",
            provider: "local",
          },
          {
            voice_id: "Nam",
            name: "Thầy Nam - Giọng Bắc ấm áp",
            gender: "male",
            region: "north",
            region_label: "Miền Bắc",
            age: "young",
            provider: "local",
          },
          {
            voice_id: "Mai",
            name: "Cô Mai - Giọng Nam vui tươi",
            gender: "female",
            region: "south",
            region_label: "Miền Nam",
            age: "young",
            provider: "local",
          },
        ],
      });
    }
    if (pathname === "/voice/session-lock") {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      return respondJson(route, {
        session_id: (body.session_id as string) ?? ids.session1,
        voice_id: (body.voice_id as string) ?? "Binh",
        provider: (body.provider as string) ?? "local",
        locked: method !== "DELETE",
      });
    }
    if (pathname === "/voice/text-to-speech" && method === "POST") {
      state.ttsRequests += 1;
      return route.fulfill({
        status: 200,
        contentType: "audio/wav",
        headers: {
          ...makeCorsHeaders(route),
          "x-tts-provider": "local",
          "x-resolved-voice-id": "Binh",
        },
        body: silentWav,
      });
    }
    if (pathname === "/voice/text-to-speech/phonics" && method === "POST") {
      state.ttsRequests += 1;
      const body = (request.postDataJSON() ?? {}) as {
        steps?: Array<{ id?: string; spoken_text?: string }>;
      };
      const steps =
        Array.isArray(body.steps) && body.steps.length > 0
          ? body.steps
          : [{ id: "step-0" }];
      const stepDuration = Number((1.0 / steps.length).toFixed(4));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          ...makeCorsHeaders(route),
          "x-tts-provider": "local",
          "x-resolved-voice-id": "Binh",
        },
        body: JSON.stringify({
          audio_base64: silentWav.toString("base64"),
          content_type: "audio/wav",
          duration_seconds: 1.0,
          step_timings: steps.map((step, index) => ({
            id: step.id ?? `step-${index}`,
            index,
            start: Number((index * stepDuration).toFixed(4)),
            end: Number(((index + 1) * stepDuration).toFixed(4)),
          })),
          provider: "local",
          resolved_voice_id: "Binh",
          region: "north",
          model_version: "v1",
          cached_speed: 1.0,
        }),
      });
    }
    if (pathname === "/voice/text-to-speech/timed" && method === "POST") {
      state.ttsRequests += 1;
      const step =
        readingWords.length <= 4
          ? 0.25
          : Number((2.0 / readingWords.length).toFixed(4));
      const durationSeconds = Math.max(
        1.0,
        Number((readingWords.length * step).toFixed(3)),
      );
      const timedWav =
        durationSeconds > 1.0
          ? buildSilentWavBuffer(Math.ceil(durationSeconds), 8000)
          : silentWav;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          ...makeCorsHeaders(route),
          "x-tts-provider": "local",
          "x-resolved-voice-id": "Binh",
        },
        body: JSON.stringify({
          audio_base64: timedWav.toString("base64"),
          content_type: "audio/wav",
          duration_seconds: durationSeconds,
          resolved_voice_id: "Binh",
          provider: "local",
          region: "north",
          model_version: "v1",
          cached_speed: 1.0,
          words: readingWords.map((w, idx) => ({
            index: idx,
            start: Number((idx * step).toFixed(4)),
            end: Number(((idx + 1) * step).toFixed(4)),
          })),
        }),
      });
    }
    if (pathname === "/voice/speech-to-text" && method === "POST") {
      state.sttRequests += 1;
      const transcript = options.sttTranscript ?? "Bé mèo đọc sách";
      return respondJson(route, {
        text: transcript,
        language_code: "vi",
        language_probability: 0.99,
        words: transcript.split(/\s+/).map((text, idx) => ({
          text,
          start: idx * 0.2,
          end: (idx + 1) * 0.2,
          type: "word",
          logprob: -0.02,
        })),
      });
    }

    // 10. Tutor Comprehension & Progress Assessment
    const tutorGenMatch =
      /^\/tutor\/sessions\/([^/]+)\/questions\/generate$/.exec(pathname);
    if (tutorGenMatch && method === "POST") {
      return respondJson(route, {
        session_id: decodeURIComponent(tutorGenMatch[1]),
        total: 1,
        source: "RULE_BASED",
        created: true,
      });
    }

    const tutorNextMatch = /^\/tutor\/sessions\/([^/]+)\/questions\/next$/.exec(
      pathname,
    );
    if (tutorNextMatch && method === "GET") {
      if (state.comprehensionAnswered >= 1) {
        return respondJson(route, {
          question: null,
          choices: [],
          progress_label: "Câu 1/1",
          position: 1,
          total: 1,
          completed: true,
        });
      }
      return respondJson(route, {
        question: {
          id: ids.question1,
          type: "FACTUAL",
          prompt: "Nhân vật trong trang sách vừa đọc là ai?",
          page_revision_id: ids.revision1,
          source_span: {
            start_word_index: 0,
            end_word_index_exclusive: 2,
            sentence_index: 0,
          },
          difficulty: 1,
          answered: false,
        },
        choices: [
          { id: "choice-a", label: "Bé mèo", value: "Bé mèo" },
          { id: "choice-b", label: "Chú voi", value: "Chú voi" },
          { id: "choice-c", label: "Con cá", value: "Con cá" },
        ],
        progress_label: "Câu 1/1",
        position: 1,
        total: 1,
        completed: false,
      });
    }

    const tutorAnswerMatch =
      /^\/tutor\/sessions\/([^/]+)\/questions\/([^/]+)\/answer$/.exec(pathname);
    if (tutorAnswerMatch && method === "POST") {
      const qid = decodeURIComponent(tutorAnswerMatch[2]);
      const body = (request.postDataJSON() ?? {}) as { answer?: string };
      const answer = body.answer ?? "";
      const isCorrect = answer.includes("mèo");
      if (isCorrect) state.comprehensionAnswered += 1;
      return respondJson(route, {
        answer_id: ids.answer1,
        question_id: qid,
        submitted_answer: answer,
        is_correct: isCorrect,
        score: isCorrect ? 100 : 0,
        feedback_code: isCorrect ? "CORRECT" : "TRY_AGAIN",
        story_hint: isCorrect
          ? null
          : "Gợi ý: Hãy nhớ lại bạn nhỏ có bộ lông mềm.",
      });
    }

    const assessmentMatch =
      /^\/tutor\/children\/([^/]+)\/progress-assessment$/.exec(pathname);
    if (assessmentMatch && (method === "GET" || method === "POST")) {
      const targetChildId = decodeURIComponent(assessmentMatch[1]);
      if (state.reportStatus !== 200) {
        return respondJson(
          route,
          { detail: "Unavailable" },
          state.reportStatus,
        );
      }
      return respondJson(route, {
        child_id: targetChildId,
        period_start: "2026-10-17",
        period_end: "2026-11-15",
        days: 30,
        generated_at: NOW,
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
              score: 88,
              previous_score: 82,
              detail: "Bé đọc đúng phần lớn các từ quen thuộc.",
            },
          ],
        },
        metrics: {
          sessions: 4,
          active_days: 3,
          reading_minutes: 35,
          books: 2,
          pages_compared: 6,
          words_read: 180,
          coverage_pct: 92,
          accuracy_pct: 88,
          skipped_rate_pct: 2,
          substitution_rate_pct: 5,
          hesitations: 2,
          repeated_words: 1,
          hesitations_per_100_words: 1.1,
          words_per_minute: 68,
          comprehension_answered: 4,
          comprehension_first_try_pct: 75,
          comprehension_by_type: [
            { type: "FACTUAL", answered: 4, first_try_correct: 3 },
          ],
          retry_confirmed: 2,
          retry_failed: 0,
        },
        weekly: [
          {
            week_start: "2026-11-09",
            sessions: 4,
            minutes: 35,
            accuracy_pct: 88,
          },
        ],
        difficult_words: [{ word: "mèo", times: 2, heard_as: "chó" }],
        assessment: {
          source: "RULE_BASED",
          model: null,
          headline: "Bé tiến bộ đều qua từng buổi đọc",
          summary: "Bé duy trì thói quen đọc tốt và tự sửa được từ khó.",
          strengths: ["Đọc trôi chảy câu ngắn"],
          weaknesses: [{ area: "Âm đầu", detail: "Cần chú ý một số từ mới" }],
          actions: [
            {
              title: "Ôn từ khó",
              detail: "Luyện lại từ mèo cùng bé.",
              audience: "PARENT",
            },
          ],
          practice_words: ["mèo"],
          encouragement: "Con đọc tiến bộ lắm!",
        },
        ai_cached: false,
      });
    }

    // 11. System Progress & Difficult Words
    const periodsMatch = /^\/system\/progress\/([^/]+)\/periods$/.exec(
      pathname,
    );
    if (periodsMatch && method === "GET") {
      if (state.reportStatus !== 200) {
        return respondJson(
          route,
          { detail: "Unavailable" },
          state.reportStatus,
        );
      }
      const targetChildId = decodeURIComponent(periodsMatch[1]);
      return respondJson(route, {
        items: [
          {
            id: ids.session1,
            child_id: targetChildId,
            period_start: "2026-10-17",
            period_end: "2026-11-15",
            generated_at: NOW,
          },
        ],
        next_cursor: null,
      });
    }

    const progressMatch = /^\/system\/progress\/([^/]+)$/.exec(pathname);
    if (progressMatch && method === "GET") {
      if (state.reportStatus !== 200) {
        return respondJson(
          route,
          { detail: "Unavailable" },
          state.reportStatus,
        );
      }
      const targetChildId = decodeURIComponent(progressMatch[1]);
      return respondJson(route, {
        id: ids.session1,
        generated_at: NOW,
        legacy: null,
        data_status: "complete",
        availability: {
          metrics: "available",
          difficult_words: "available",
          comparison: "absent",
        },
        child_id: targetChildId,
        period_start: url.searchParams.get("period_start") ?? "2026-10-17",
        period_end: url.searchParams.get("period_end") ?? "2026-11-15",
        completed_sessions: 4,
        reading_duration_ms: 2100000,
        omission_count: 1,
        repetition_count: 1,
        long_pause_count: 2,
        omission_rate: 2.5,
        repetition_rate: 1.5,
        long_pause_rate: 3.0,
        comprehension_accuracy: 85,
        difficult_words: [difficultWordItem],
        previous_period: null,
        trend_deltas: {
          completed_sessions: null,
          reading_duration_ms: null,
          omission_rate: null,
          repetition_rate: null,
          long_pause_rate: null,
          comprehension_accuracy: null,
        },
      });
    }

    const diffHistoryMatch =
      /^\/system\/difficult-words\/([^/]+)\/practice\/history$/.exec(pathname);
    if (diffHistoryMatch && method === "GET") {
      return respondJson(route, {
        storage_ready: true,
        items: difficultPracticeAttempts,
      });
    }

    const diffStartMatch =
      /^\/system\/difficult-words\/([^/]+)\/practice\/start$/.exec(pathname);
    if (diffStartMatch && method === "POST") {
      const targetChildId = decodeURIComponent(diffStartMatch[1]);
      const body = request.postDataJSON() as {
        normalized_word: string;
        display_text?: string;
        evidence_word_ids?: string[];
      };
      const attemptId = `99999999-9999-4999-8999-${String(difficultPracticeAttempts.length + 1).padStart(12, "0")}`;
      const attempt = {
        attempt_id: attemptId,
        child_id: targetChildId,
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
        evidence_word_ids: body.evidence_word_ids ?? [ids.revision1],
        started_at: NOW,
        completed_at: null,
        feedback_message: null,
        word_progress: {
          normalized_word: body.normalized_word,
          practice_status: "IN_PROGRESS",
          practice_attempts_count: difficultPracticeAttempts.length,
          practice_correct_count: 0,
          practice_incorrect_count: 0,
          practice_uncertain_count: 0,
          consecutive_correct_count: 0,
          required_consecutive_correct: 2,
          last_practiced_at: null,
          last_practice_status: null,
        },
        next_recommended_word: null,
        evidence_count_unchanged: true,
      };
      difficultPracticeAttempts.unshift(attempt);
      return respondJson(route, attempt);
    }

    const diffEvalMatch =
      /^\/system\/difficult-words\/([^/]+)\/practice\/(?:evaluate|[^/]+\/evaluate-audio|[^/]+\/complete)$/.exec(
        pathname,
      );
    if (diffEvalMatch && method === "POST") {
      const targetChildId = decodeURIComponent(diffEvalMatch[1]);
      const attemptId = `99999999-9999-4999-8999-${String(difficultPracticeAttempts.length + 1).padStart(12, "0")}`;
      const attempt = {
        attempt_id: attemptId,
        child_id: targetChildId,
        normalized_word: "meo",
        display_text: "mèo",
        attempt_number: difficultPracticeAttempts.length + 1,
        state: "COMPLETED",
        assessment_status: "CORRECT",
        recognition_source: "SERVER_STT",
        spoken_transcript: "mèo",
        confidence: 0.98,
        audio_duration_ms: 820,
        assessment_version: 1,
        evidence_word_ids: [ids.revision1],
        persistence_backend: "READING_EVENT",
        resolved_in_session: true,
        started_at: NOW,
        completed_at: NOW,
        feedback_message: "Chính xác rồi! Con giỏi lắm!",
        word_progress: {
          normalized_word: "meo",
          practice_status: "COMPLETED",
          practice_attempts_count: 1,
          practice_correct_count: 1,
          practice_incorrect_count: 0,
          practice_uncertain_count: 0,
          consecutive_correct_count: 1,
          required_consecutive_correct: 1,
          last_practiced_at: NOW,
          last_practice_status: "CORRECT",
        },
        next_recommended_word: null,
        evidence_count_unchanged: true,
      };
      difficultWordItem.practice_status = "COMPLETED";
      difficultWordItem.practice_attempts_count = 1;
      difficultWordItem.practice_correct_count = 1;
      difficultWordItem.consecutive_correct_count = 1;
      difficultWordItem.last_practiced_at = NOW;
      difficultWordItem.last_practice_status = "CORRECT";
      difficultPracticeAttempts.unshift(attempt);
      return respondJson(route, attempt);
    }

    const diffListMatch = /^\/system\/difficult-words\/([^/]+)$/.exec(pathname);
    if (diffListMatch && method === "GET") {
      return respondJson(route, [difficultWordItem]);
    }

    // 12. Learning Analytics & Recommendations
    const recMatch = /^\/learning\/children\/([^/]+)\/recommendations$/.exec(
      pathname,
    );
    if (recMatch && method === "GET") {
      const targetChildId = decodeURIComponent(recMatch[1]);
      const targetChild =
        (state.children.find((c) => c.id === targetChildId) as
          { alias: string; grade: number } | undefined) ?? defaultChildren[0];
      return respondJson(route, {
        child_id: targetChildId,
        child_alias: targetChild.alias,
        child_grade: targetChild.grade,
        mascot_greeting_vi: `Chào ${targetChild.alias}! Hôm nay cùng vui học nhé!`,
        natural_break_reminder_vi:
          "Mỗi phiên chơi khoảng 10–15 phút là vừa đẹp để mắt bé luôn khỏe mạnh.",
        today_activities_count: 2,
        focus_difficult_words: ["mèo"],
        primary_recommendation: {
          game_key: "PICTURE_DESCRIPTION",
          zone_title_vi: "Thế giới kể chuyện",
          game_title_vi: "Kể chuyện qua tranh",
          reason_vi: "Luyện đặt câu và mở rộng vốn từ miêu tả sinh động.",
          suggested_mode: "VOCABULARY",
          suggested_difficulty: 2,
          target_words: ["mèo mướp", "lấp lánh"],
          href: "/entertainment/picture-description",
          priority: 1,
        },
        recommendations: [
          {
            game_key: "PICTURE_DESCRIPTION",
            zone_title_vi: "Thế giới kể chuyện",
            game_title_vi: "Kể chuyện qua tranh",
            reason_vi: "Luyện đặt câu và mở rộng vốn từ miêu tả sinh động.",
            suggested_mode: "VOCABULARY",
            suggested_difficulty: 2,
            target_words: ["mèo mướp", "lấp lánh"],
            href: "/entertainment/picture-description",
            priority: 1,
          },
          {
            game_key: "SENTENCE_SHOOTER",
            zone_title_vi: "Phiêu lưu cùng chữ",
            game_title_vi: "Xạ thủ ghép câu",
            reason_vi: "Ghép câu ngắn gắn với từ khó bé vừa đọc.",
            suggested_mode: "WORD_ORDER",
            suggested_difficulty: 1,
            target_words: ["sách"],
            href: "/entertainment/sentence-shooter",
            priority: 2,
          },
          {
            game_key: "KARAOKE",
            zone_title_vi: "Sân khấu âm nhạc",
            game_title_vi: "Hát vui cùng bé",
            reason_vi: "Cùng bé luyện nhịp điệu và câu hát rõ lời.",
            suggested_mode: "FULL_SONG",
            suggested_difficulty: 1,
            target_words: [],
            href: "/karaoke",
            priority: 3,
          },
          {
            game_key: "MEMORY_GAME",
            zone_title_vi: "Khám phá trí nhớ",
            game_title_vi: "Bé nhớ được gì?",
            reason_vi: "Quan sát tranh và kể tiếp câu chuyện sáng tạo.",
            suggested_mode: "GUIDED_RECALL",
            suggested_difficulty: 2,
            target_words: ["mèo mướp"],
            href: "/entertainment/memory-game",
            priority: 4,
          },
        ],
      });
    }

    const analyticsMatch =
      /^\/learning\/children\/([^/]+)\/parent-analytics$/.exec(pathname);
    if (analyticsMatch && method === "GET") {
      const targetChildId = decodeURIComponent(analyticsMatch[1]);
      return respondJson(route, {
        child_id: targetChildId,
        child_alias: defaultChildren[0].alias,
        child_grade: defaultChildren[0].grade,
        window_days: Number(url.searchParams.get("window_days") ?? "30") || 30,
        is_diagnostic: false,
        disclaimer_vi:
          "Báo cáo này tổng hợp hoạt động Học mà Chơi để hỗ trợ luyện đọc tại nhà, không phải đánh giá hay chẩn đoán y khoa.",
        observed_skills_count: 1,
        estimated_skills_count: 0,
        unknown_skills_count: 0,
        skills: [
          {
            skill_key: "sentence_ordering",
            label_vi: "Sắp xếp trật tự câu tiếng Việt",
            domain: "LANGUAGE_GRAMMAR",
            status: "OBSERVED",
            mastery_pct: 88,
            confidence: 0.9,
            evidence_count: 4,
            high_confidence_count: 4,
            last_observed_at: NOW,
            source_modules: ["SENTENCE_SHOOTER"],
          },
        ],
        practiced_difficult_words: [],
        module_activities: [
          {
            game_key: "SENTENCE_SHOOTER",
            title_vi: "Xạ thủ ghép câu",
            sessions_count: 2,
            recent_average_pct: 88,
            highlight_vi: "2 lượt chơi · ghép câu mạch lạc",
          },
        ],
        karaoke_weak_segments: [],
        home_support_tips_vi: ["Cùng bé ôn luyện 10 phút mỗi ngày."],
        generated_at: NOW,
      });
    }

    // 13. Games: Memory Game
    if (pathname === "/games/memory/themes" && method === "GET") {
      return respondJson(route, {
        themes: [
          {
            theme_key: "sunny_garden",
            name_vi: "Khu vườn nắng ấm",
            description_vi: "Chú mèo mướp, bướm vàng và hoa hướng dương.",
            badge_vi: "Quen thuộc",
            accent_hex: "#F59E0B",
            sprite_count: 7,
            sample_items_vi: ["mèo mướp", "hoa hướng dương"],
          },
        ],
        timer_options: [
          {
            mode: "20S",
            seconds: 20,
            label_vi: "20 giây",
            recommended_for_vi: "Nhịp vừa phải",
          },
          {
            mode: "UNLIMITED",
            seconds: null,
            label_vi: "Không giới hạn",
            recommended_for_vi: "Không áp lực",
          },
        ],
        grade_recommendations: [
          {
            grade: 2,
            min_objects: 3,
            max_objects: 5,
            recommended_timer: "20S",
            recommended_recall_mode: "GUIDED_RECALL",
            recommended_difficulty: 2,
            note_vi: "Gợi ý Lớp 2: quan sát 20 giây.",
          },
        ],
        total_sprites: 42,
      });
    }
    if (pathname === "/games/memory/sessions" && method === "GET") {
      return respondJson(route, []);
    }
    if (pathname === "/games/memory/sessions" && method === "POST") {
      return respondJson(route, memorySessionBase);
    }
    if (
      pathname === `/games/memory/sessions/${ids.memorySession1}` &&
      method === "GET"
    ) {
      return respondJson(route, memorySessionBase);
    }
    if (
      pathname === `/games/memory/sessions/${ids.memorySession1}/hint` &&
      method === "POST"
    ) {
      return respondJson(route, {
        session_id: ids.memorySession1,
        hints_used: 1,
        object_id: memoryFlower.id,
        tier: 1,
        hint_text_vi: memoryFlower.hint_tiers.tier_1,
        remaining_unmentioned_count: 1,
        has_more_tiers: true,
      });
    }
    if (
      pathname === `/games/memory/sessions/${ids.memorySession1}/peek` &&
      method === "POST"
    ) {
      return respondJson(route, {
        session_id: ids.memorySession1,
        peek_count: 1,
        peek_duration_seconds: 3,
        message_vi: "Xem lại tranh trong 3 giây.",
      });
    }
    if (
      pathname === `/games/memory/sessions/${ids.memorySession1}/attempts` &&
      method === "POST"
    ) {
      const body = request.postDataJSON() as { stage?: "RECALL" | "CREATIVE" };
      if (body.stage === "RECALL") {
        const evalRecall = {
          stage: "RECALL",
          factual_score: 80,
          creative_score: 0,
          stars: 2,
          matched_facts: [
            {
              object_id: memoryCat.id,
              sprite_key: memoryCat.sprite_key,
              name_vi: memoryCat.name_vi,
              color_vi: memoryCat.color_vi,
              count: memoryCat.count,
              position_zone: memoryCat.position_zone,
              matched_attributes: ["tên", "màu", "vị trí"],
              detail_vi: "1 mèo mướp cam ở dưới trái",
              bbox: memoryCat.bbox,
            },
          ],
          missed_facts: [
            {
              object_id: memoryFlower.id,
              sprite_key: memoryFlower.sprite_key,
              name_vi: memoryFlower.name_vi,
              color_vi: memoryFlower.color_vi,
              count: memoryFlower.count,
              position_zone: memoryFlower.position_zone,
              detail_vi: "2 hoa hướng dương vàng ở dưới phải",
              hint_tier_1: memoryFlower.hint_tiers.tier_1,
              bbox: memoryFlower.bbox,
            },
          ],
          creative_highlights: [],
          story_anchors: [],
          praise_message_vi: "Bé nhớ rất chính xác chú mèo mướp!",
          story_praise_vi: "Hãy cùng kể tiếp câu chuyện!",
          next_tip_vi: "Chạm thẻ để xem vị trí.",
          creative_followup_vi: "Chú mèo mướp sẽ làm gì tiếp theo?",
          support_summary_vi: null,
          used_focus_words: ["mèo mướp"],
          ai_provider: "deterministic",
        };
        const attempt = {
          id: ids.memoryAttemptRecall1,
          session_id: ids.memorySession1,
          attempt_number: 1,
          stage: "RECALL",
          input_mode: "TEXT",
          response_text: "Chú mèo mướp nằm ở góc dưới trái.",
          factual_score: 80,
          creative_score: 0,
          stars: 2,
          evaluation: evalRecall,
          ai_provider: "deterministic",
          created_at: NOW,
        };
        return respondJson(route, {
          attempt,
          session: {
            ...memorySessionBase,
            status: "CREATIVE",
            best_factual_score: 80,
            stars: 2,
            attempts_count: 1,
            attempts: [attempt],
          },
        });
      }
      const evalCreative = {
        stage: "CREATIVE",
        factual_score: 80,
        creative_score: 95,
        stars: 3,
        matched_facts: [],
        missed_facts: [],
        creative_highlights: ["Câu chuyện rất sinh động"],
        story_anchors: ["mèo mướp"],
        praise_message_vi: "Câu chuyện thật giàu trí tưởng tượng!",
        story_praise_vi: "Bé kể rất tự nhiên!",
        next_tip_vi: "Thử chủ đề mới nhé!",
        creative_followup_vi: "",
        support_summary_vi: null,
        used_focus_words: ["mèo mướp"],
        ai_provider: "gemini",
      };
      const attempt = {
        id: ids.memoryAttemptCreative1,
        session_id: ids.memorySession1,
        attempt_number: 2,
        stage: "CREATIVE",
        input_mode: "TEXT",
        response_text: "Chú mèo mướp vui chơi cùng hoa hướng dương.",
        factual_score: 80,
        creative_score: 95,
        stars: 3,
        evaluation: evalCreative,
        ai_provider: "gemini",
        created_at: NOW,
      };
      return respondJson(route, {
        attempt,
        session: {
          ...memorySessionBase,
          status: "COMPLETED",
          best_factual_score: 80,
          best_creative_score: 95,
          stars: 3,
          attempts_count: 2,
          attempts: [attempt],
        },
      });
    }

    // 14. Games: Picture Description
    if (pathname === "/games/picture-description/catalog" && method === "GET") {
      return respondJson(route, {
        samples: [
          {
            sample_key: "sunny-garden",
            title: "Khu vườn đầy nắng",
            theme: "Thiên nhiên",
            description: "Chú mèo mướp và chú bướm trong khu vườn đầy nắng.",
            image_url: "/images/picture-description/sunny-garden.jpg",
          },
        ],
        book_pages: [
          {
            book_id: ids.book1,
            book_title: defaultBooks[0].title,
            page_id: ids.pictureBookPage1,
            page_number: 1,
            image_url: "/images/picture-description/lakeside-picnic.jpg",
          },
        ],
      });
    }
    if (
      pathname === "/games/picture-description/sessions" &&
      method === "GET"
    ) {
      return respondJson(route, []);
    }
    if (
      pathname === "/games/picture-description/sessions" &&
      method === "POST"
    ) {
      return respondJson(route, pictureSessionBase);
    }
    if (
      pathname ===
        `/games/picture-description/sessions/${ids.pictureSession1}` &&
      method === "GET"
    ) {
      return respondJson(route, pictureSessionBase);
    }
    if (
      pathname ===
        `/games/picture-description/sessions/${ids.pictureSession1}/evaluate` &&
      method === "POST"
    ) {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      const attempt = {
        attempt_id: ids.pictureAttempt1,
        attempt_number: 1,
        input_mode: (body.input_mode as string) ?? "TEXT",
        transcript_text: String(body.transcript_text ?? ""),
        score_out_of_10: 9,
        stars: 3,
        evaluation_source: "AI",
        provider_tier: "GEMINI_PRIMARY",
        feedback: {
          is_relevant: true,
          score_out_of_10: 9,
          stars: 3,
          matched_details: ["Chú mèo mướp"],
          missed_details: [],
          praise_message: "Tuyệt vời! Bé quan sát rất tinh tế!",
          improvement_tip: "Bé kể thêm chi tiết nắng vàng nhé.",
          upgraded_sentences: ["Chú mèo mướp nằm sưởi nắng trong khu vườn."],
          vocabulary_highlights: ["mèo mướp"],
          teaching_mode: (body.teaching_mode as string) ?? "OBSERVE",
          scaffolding_step: "EXPAND",
          next_prompt_question: "Chú mèo mướp sẽ làm gì tiếp theo?",
          used_target_words: ["mèo mướp"],
          provider_tier: "GEMINI_PRIMARY",
        },
        created_at: NOW,
      };
      return respondJson(route, {
        session: {
          ...pictureSessionBase,
          attempts_count: 1,
          best_score: 9,
          best_stars: 3,
          attempts: [attempt],
        },
        latest_attempt: attempt,
      });
    }

    // 15. Games: Sentence Shooter
    if (pathname === "/games/sentence-shooter/books" && method === "GET") {
      return respondJson(route, [
        {
          id: ids.book1,
          name: defaultBooks[0].name,
          title: defaultBooks[0].title,
          author: defaultBooks[0].author,
          min_grade: 1,
          max_grade: 3,
          available_rounds: 3,
        },
      ]);
    }
    if (pathname === "/games/sentence-shooter/sessions" && method === "POST") {
      shooterResolvedShots = 0;
      shooterCurrentRound = 1;
      shooterHintCount = 0;
      return respondJson(route, {
        session_id: ids.shooterSession1,
        book: {
          id: ids.book1,
          name: defaultBooks[0].name,
          title: defaultBooks[0].title,
          author: defaultBooks[0].author,
          min_grade: 1,
          max_grade: 3,
          available_rounds: 3,
        },
        difficulty: "easy",
        learning_mode: "WORD_ORDER",
        total_rounds: 1,
        completed_rounds: 0,
        total_stars: 0,
        practiced_difficult_words: ["sách"],
        round: {
          round_id: ids.shooterRound1,
          round_number: shooterCurrentRound,
          token_count: 3,
          learning_mode: "WORD_ORDER",
          practiced_difficult_words: ["sách"],
          prompt_hint: "Ghép các từ thành câu hoàn chỉnh.",
          tokens: [shooterTokens[1], shooterTokens[0], shooterTokens[2]],
        },
      });
    }
    if (
      pathname ===
        `/games/sentence-shooter/sessions/${ids.shooterSession1}/shots` &&
      method === "POST"
    ) {
      const body = request.postDataJSON() as {
        token_id: string;
        client_shot_id?: string;
      };
      const expected = shooterTokens[shooterResolvedShots];
      const isCorrect = expected?.id === body.token_id;
      if (isCorrect) shooterResolvedShots += 1;
      const roundCompleted = shooterResolvedShots === shooterTokens.length;
      return respondJson(route, {
        is_correct: isCorrect,
        correct_count: shooterResolvedShots,
        token_count: shooterTokens.length,
        mistakes_total: isCorrect ? 0 : 1,
        completed_rounds: roundCompleted ? 1 : 0,
        total_stars: roundCompleted ? 3 : 0,
        round_completed: roundCompleted,
        session_completed: roundCompleted,
        next_expected_position: shooterResolvedShots,
        stars_awarded: roundCompleted ? 3 : 0,
        score: shooterResolvedShots * 10,
        completed_sentence: roundCompleted ? "Bé đọc sách." : null,
        next_round: null,
        message: roundCompleted
          ? "Hoàn thành câu tuyệt vời!"
          : "Chính xác! Chọn từ tiếp theo nhé.",
        client_shot_id: body.client_shot_id ?? null,
        learning_mode: "WORD_ORDER",
        grammar_tip: roundCompleted
          ? "Câu trần thuật ngắn gồm chủ ngữ 'Bé' + vị ngữ 'đọc sách'."
          : null,
        practiced_difficult_words: ["sách"],
      });
    }
    if (
      pathname ===
        `/games/sentence-shooter/sessions/${ids.shooterSession1}/hints` &&
      method === "POST"
    ) {
      shooterHintCount += 1;
      const targetToken =
        shooterTokens[shooterResolvedShots] ?? shooterTokens[0];
      return respondJson(route, {
        target_token_id: targetToken.id,
        hint_count: shooterHintCount,
        message: "Gợi ý: thử chọn từ tiếp theo nhé.",
      });
    }
    if (
      pathname ===
        `/games/sentence-shooter/sessions/${ids.shooterSession1}/result` &&
      method === "GET"
    ) {
      return respondJson(route, {
        session_id: ids.shooterSession1,
        book: {
          id: ids.book1,
          name: defaultBooks[0].name,
          title: defaultBooks[0].title,
          author: defaultBooks[0].author,
          min_grade: 1,
          max_grade: 3,
          available_rounds: 3,
        },
        difficulty: "easy",
        learning_mode: "WORD_ORDER",
        status: "COMPLETED",
        total_rounds: 1,
        completed_rounds: 1,
        correct_count: 3,
        mistakes_total: 0,
        hint_count: 0,
        total_stars: 3,
        duration_seconds: 6,
        started_at: NOW,
        completed_at: NOW,
        practiced_difficult_words: ["sách"],
      });
    }
    if (
      pathname ===
        `/games/sentence-shooter/sessions/${ids.shooterSession1}/abandon` &&
      method === "POST"
    ) {
      return respondJson(route, {
        session_id: ids.shooterSession1,
        status: "ABANDONED",
      });
    }

    // 16. Karaoke Library, Playback, Musical Profile & Practice Sessions
    if (pathname === "/karaoke/songs" && method === "GET") {
      return respondJson(route, {
        items: [
          {
            song_id: ids.song1,
            version_id: ids.version1,
            title: "Ngôi sao nhỏ",
            author: "Nhạc thiếu nhi",
            duration_ms: 103366,
            min_grade: 1,
            max_grade: 3,
            cover_url: null,
          },
        ],
        total: 1,
        limit: 12,
        offset: 0,
      });
    }

    if (
      pathname === `/karaoke/songs/${ids.song1}/playback` &&
      method === "GET"
    ) {
      return respondJson(route, {
        song_id: ids.song1,
        version_id: ids.version1,
        title: "Ngôi sao nhỏ",
        author: "Nhạc thiếu nhi",
        duration_ms: 103366,
        audio_url: "https://media.example.test/track.mp3?token=test-only",
        audio_url_expires_at: "2099-01-01T00:00:00Z",
        cover_url: null,
        lyrics: demo.lyrics,
      });
    }

    if (
      pathname === `/karaoke/songs/${ids.song1}/musical-profile` &&
      method === "GET"
    ) {
      return respondJson(route, {
        song_id: ids.song1,
        song_version_id: ids.version1,
        bpm: 108,
        audio_type: "VOCAL_FULL",
        has_pitch_contour: false,
        has_beat_grid: false,
        source_method: "LYRICS_TIMING",
        beat_grid_ms: [],
        pitch_contour: [],
        phrase_windows: [],
        updated_at: NOW,
      });
    }

    if (pathname === "/karaoke/practice-sessions" && method === "GET") {
      return respondJson(route, {
        child_id: ids.child1,
        song_id: ids.song1,
        best_full_song_score: null,
        best_full_song_stars: 0,
        total_sessions: state.karaokeSessionsSaved.length,
        items: state.karaokeSessionsSaved,
        storage_ready: true,
      });
    }

    if (pathname === "/karaoke/practice-sessions" && method === "POST") {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      const saved = {
        id: ids.karaokeSession1,
        child_id: (body.child_id as string) ?? ids.child1,
        song_id: (body.song_id as string) ?? ids.song1,
        song_version_id: (body.song_version_id as string) ?? ids.version1,
        practice_mode: (body.practice_mode as string) ?? "FULL_SONG",
        scoring_mode: (body.scoring_mode as string) ?? "LYRICS_ONLY",
        playback_rate: Number(body.playback_rate ?? 1),
        headphone_mode: Boolean(body.headphone_mode),
        overall_score: (body.overall_score as number | null) ?? 88,
        rhythm_score: (body.rhythm_score as number | null) ?? 90,
        pitch_score: (body.pitch_score as number | null) ?? null,
        lyrics_score: (body.lyrics_score as number | null) ?? 86,
        fluency_score: (body.fluency_score as number | null) ?? 88,
        stars: Number(body.stars ?? 3),
        segment_start_ms: (body.segment_start_ms as number | null) ?? null,
        segment_end_ms: (body.segment_end_ms as number | null) ?? null,
        report_payload: (body.report_payload as Record<string, unknown>) ?? {},
        created_at: NOW,
        persisted: true,
      };
      state.karaokeSessionsSaved.unshift(saved);
      return respondJson(route, saved, 201);
    }

    // Any unhandled backend path fails loudly!
    state.unexpected.push(`api:${method}:${pathname}`);
    return respondJson(route, { detail: "Unmocked endpoint" }, 404);
  });

  // Synthetic Web Audio / MediaRecorder / SpeechRecognition / SpeechSynthesis init script
  await page.addInitScript(
    ({ denyMic, silentMic, disableSpeechRec }) => {
      const probe = {
        microphoneRequests: 0,
        activeTracks: 0,
        recordingStarts: 0,
        spokenTexts: [] as string[],
      };
      Object.assign(window, { __e2eAudioProbe: probe });

      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          probe.microphoneRequests += 1;
          if (denyMic) {
            throw new DOMException("Denied by test fixture", "NotAllowedError");
          }
          const context = new AudioContext();
          await context.resume();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const destination = context.createMediaStreamDestination();
          oscillator.frequency.value = 240;
          gain.gain.value = 0;
          oscillator.connect(gain);
          gain.connect(destination);
          oscillator.start();

          const stream = destination.stream;
          const schedule = () => {
            const start = context.currentTime;
            gain.gain.cancelScheduledValues(start);
            gain.gain.setValueAtTime(0, start);
            if (silentMic) return;
            for (let n = 0; n < 12; n += 1) {
              gain.gain.setValueAtTime(
                n % 2 ? 0.03 : 0.1,
                start + 0.3 + n * 0.12,
              );
            }
            gain.gain.setValueAtTime(0, start + 2.0);
          };
          Object.assign(stream, { __schedule: schedule });

          for (const track of stream.getTracks()) {
            probe.activeTracks += 1;
            const stop = track.stop.bind(track);
            let stopped = false;
            track.stop = () => {
              if (!stopped) {
                stopped = true;
                probe.activeTracks -= 1;
                oscillator.stop();
                void context.close();
              }
              stop();
            };
          }
          return stream;
        },
      });

      const NativeRecorder = window.MediaRecorder;
      class SyntheticRecorder extends NativeRecorder {
        override start(timeslice?: number) {
          probe.recordingStarts += 1;
          (
            this.stream as MediaStream & { __schedule?: () => void }
          ).__schedule?.();
          super.start(timeslice);
        }
      }
      Object.defineProperty(window, "MediaRecorder", {
        configurable: true,
        value: SyntheticRecorder,
      });

      if (disableSpeechRec) {
        Object.defineProperty(window, "SpeechRecognition", {
          configurable: true,
          value: undefined,
        });
        Object.defineProperty(window, "webkitSpeechRecognition", {
          configurable: true,
          value: undefined,
        });
      } else {
        class MockSpeechRecognition {
          static active: MockSpeechRecognition | null = null;
          lang = "vi-VN";
          continuous = true;
          interimResults = true;
          maxAlternatives = 1;
          onresult: ((event: unknown) => void) | null = null;
          onend: (() => void) | null = null;
          onerror: ((event: { error?: string }) => void) | null = null;
          private running = false;
          resultsList: Array<{
            isFinal: boolean;
            length: number;
            0: { transcript: string; confidence: number };
          }> = [];

          start(): void {
            this.running = true;
            this.resultsList = [];
            MockSpeechRecognition.active = this;
          }

          stop(): void {
            if (this.running) {
              this.running = false;
              if (MockSpeechRecognition.active === this) {
                MockSpeechRecognition.active = null;
              }
              queueMicrotask(() => this.onend?.());
            }
          }

          abort(): void {
            this.running = false;
            if (MockSpeechRecognition.active === this) {
              MockSpeechRecognition.active = null;
            }
          }
        }

        Object.defineProperty(window, "__e2eSpeechControl", {
          configurable: true,
          value: {
            emitTranscript(text: string, isFinal = true): boolean {
              const active = MockSpeechRecognition.active;
              if (!active) return false;
              const idx = active.resultsList.length;
              active.resultsList.push({
                isFinal,
                length: 1,
                0: { transcript: text, confidence: 0.98 },
              });
              const resultsObj: Record<number, unknown> & { length: number } = {
                length: active.resultsList.length,
              };
              for (let i = 0; i < active.resultsList.length; i += 1) {
                resultsObj[i] = active.resultsList[i];
              }
              active.onresult?.({
                resultIndex: idx,
                results: resultsObj,
              });
              return true;
            },
            isActive(): boolean {
              return MockSpeechRecognition.active !== null;
            },
          },
        });

        Object.defineProperty(window, "SpeechRecognition", {
          configurable: true,
          value: MockSpeechRecognition,
        });
        Object.defineProperty(window, "webkitSpeechRecognition", {
          configurable: true,
          value: MockSpeechRecognition,
        });
      }

      // Mock SpeechSynthesis so browser TTS fallback never blocks in headless Chromium
      const fakeVoice = {
        default: true,
        lang: "vi-VN",
        localService: true,
        name: "Fixture Vietnamese Voice",
        voiceURI: "fixture-vi",
      } as SpeechSynthesisVoice;

      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          speaking: false,
          pending: false,
          paused: false,
          onvoiceschanged: null,
          getVoices: () => [fakeVoice],
          speak: (utterance: SpeechSynthesisUtterance) => {
            probe.spokenTexts.push(utterance.text);
            queueMicrotask(() => {
              utterance.onstart?.(new Event("start") as SpeechSynthesisEvent);
              queueMicrotask(() => {
                utterance.onend?.(new Event("end") as SpeechSynthesisEvent);
              });
            });
          },
          cancel: () => undefined,
          pause: () => undefined,
          resume: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => true,
        },
      });
    },
    {
      denyMic: options.denyMicrophone ?? false,
      silentMic: options.silentMicrophone ?? false,
      disableSpeechRec: options.disableBrowserSpeechRecognition ?? false,
    },
  );

  return state;
}

export function attachPageErrorCollector(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

export function assertCleanHarness(
  state: E2eSuiteState,
  pageErrors: readonly string[],
): void {
  expect(pageErrors, "Uncaught browser page errors").toEqual([]);
  expect(state.unexpected, "Unexpected/unmocked network calls").toEqual([]);
}
