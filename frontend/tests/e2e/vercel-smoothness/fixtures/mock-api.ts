import {
  expect,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";
import { stringToBase64URL } from "@supabase/ssr";

export const DEFAULT_TIMESTAMP = "2026-11-21T10:00:00Z";

export const IDS = {
  parent: "91000000-0000-4000-8000-000000000001",
  childA: "92000000-0000-4000-8000-000000000001",
  childB: "92000000-0000-4000-8000-000000000002",
  foreignChild: "92000000-0000-4000-8000-000000000099",
  book1: "82000000-0000-4000-8000-000000000010",
  book2: "82000000-0000-4000-8000-000000000020",
  privateBook: "82000000-0000-4000-8000-000000000030",
  page1: "83000000-0000-4000-8000-000000000011",
  page2: "83000000-0000-4000-8000-000000000012",
  privatePage1: "83000000-0000-4000-8000-000000000031",
  revision1: "84000000-0000-4000-8000-000000000011",
  revision2: "84000000-0000-4000-8000-000000000012",
  session1: "85000000-0000-4000-8000-000000000011",
  report1: "86000000-0000-4000-8000-000000000011",
  report2: "86000000-0000-4000-8000-000000000012",
  submission1: "87000000-0000-4000-8000-000000000011",
  batch1: "88000000-0000-4000-8000-000000000011",
  word1: "89000000-0000-4000-8000-000000000001",
  word2: "89000000-0000-4000-8000-000000000002",
  word3: "89000000-0000-4000-8000-000000000003",
  word4: "89000000-0000-4000-8000-000000000004",
  question1: "8c000000-0000-4000-8000-000000000001",
  answer1: "8d000000-0000-4000-8000-000000000001",
  delivery1: "8a000000-0000-4000-8000-000000000001",
} as const;

export const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n+UAAAAASUVORK5CYII=",
  "base64",
);

export const SILENT_WAV_BYTES = Buffer.from(
  "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
  "base64",
);

export const LEAK_PATTERNS: readonly RegExp[] = [
  /traceback\s*\(/i,
  /SELECT\s+.*\s+FROM/i,
  /psycopg/i,
  /postgresql:\/\//i,
  /<!DOCTYPE\s+html/i,
  /private sql token/i,
  /CRON_SECRET=/i,
  /at\s+[A-Za-z0-9_$.]+\s+\([^)]+:\d+:\d+\)/,
];

export function assertNoRawErrorLeak(text: string, label = "UI body"): void {
  for (const pattern of LEAK_PATTERNS) {
    expect(
      text,
      `[${label}] Leaked internal error pattern ${pattern}`,
    ).not.toMatch(pattern);
  }
}

export interface FaultAction {
  readonly status?: number;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
  readonly delayMs?: number;
  readonly abort?: boolean;
}

export interface FaultRule {
  readonly method?: string;
  readonly path: string | RegExp;
  readonly sequence: FaultAction[];
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly startedAt: number;
  readonly status: number;
}

export interface MockChild {
  id: string;
  parent_id: string;
  alias: string;
  grade: number;
  settings: Record<string, unknown>;
  created_at: string;
  avatar_url: string | null;
}

export interface MockBook {
  id: string;
  title: string;
  author: string | null;
  min_grade: number;
  max_grade: number;
  lifecycle_status: "ACTIVE" | "RETIRED";
  visibility_scope?: "CATALOG" | "PARENT_PRIVATE";
  cover_url?: string | null;
  cover_source_type?: "USER_UPLOAD" | "AI_GENERATED" | "METADATA_RENDER" | null;
}

export interface MockApiOptions {
  readonly faults?: FaultRule[];
  readonly emptyChildren?: boolean;
  readonly emptyCatalog?: boolean;
  readonly selectedChildId?: string | null;
  readonly comprehensionQuestionCount?: number;
  readonly initialChildren?: MockChild[];
  readonly initialBooks?: MockBook[];
  readonly difficultWordCount?: number;
  readonly reportDataStatus?: "complete" | "partial" | "unsupported";
  readonly includePrivateBooks?: boolean;
  readonly periodsHasMore?: boolean;
  readonly supabaseTokenShouldFail?: boolean;
  readonly supabaseUpdateUserShouldFail?: boolean;
}

export interface MockApiTracker {
  readonly requests: RecordedRequest[];
  readonly attemptCounts: Map<string, number>;
  readonly requestTimestamps: Map<string, number[]>;
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly serverErrors: string[];
  readonly failedImages: string[];
  readonly children: MockChild[];
  readonly books: MockBook[];
  readonly collections: Array<{
    id: string;
    child_id: string;
    book_id: string;
    collection_type: "FAVORITE" | "WANT_TO_READ";
    created_at: string;
    book: {
      id: string;
      title: string;
      author: string | null;
      min_grade: number;
      max_grade: number;
      lifecycle_status: "ACTIVE" | "RETIRED";
      available_to_read: boolean;
    };
  }>;
  readonly feedbackPayloads: Array<Record<string, unknown>>;
  emailPreferences: {
    weekly_digest_enabled: boolean;
    inactivity_alert_enabled: boolean;
    inactivity_days: number;
    milestone_enabled: boolean;
    digest_weekday: number;
    timezone: string;
    quiet_hours_start: number;
    quiet_hours_end: number;
    max_emails_per_week: number;
    delivery_configured: boolean;
    delivery_provider: string;
    updated_at: string | null;
  };
  setFaults(rules: FaultRule[]): void;
  getAttemptCount(method: string, path: string): number;
  getTimestamps(method: string, path: string): number[];
  assertCleanHealth(
    label: string,
    options?: { readonly expectedHttpStatuses?: readonly number[] },
  ): void;
}

function makeFakeJwt(sub: string, role: "admin" | "parent"): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      aud: "authenticated",
      exp: nowSec + 36000,
      iat: nowSec - 60,
      role: "authenticated",
      sub,
      user_metadata: { role, display_name: "Ba mẹ ViRead" },
    }),
  ).toString("base64url");
  return `${header}.${payload}.synthetic-e2e-signature`;
}

export async function seedParentSession(
  context: BrowserContext,
  options?: { readonly userId?: string; readonly email?: string },
): Promise<string> {
  const userId = options?.userId ?? IDS.parent;
  const email = options?.email ?? "parent@example.test";
  const accessToken = makeFakeJwt(userId, "parent");
  const nowSec = Math.floor(Date.now() / 1000);
  const sessionPayload = {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 36000,
    expires_at: nowSec + 36000,
    refresh_token: "synthetic-refresh-token",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email,
      user_metadata: { role: "parent", display_name: "Ba mẹ ViRead" },
      app_metadata: { provider: "email", providers: ["email"] },
      created_at: DEFAULT_TIMESTAMP,
    },
  };
  const encoded = `base64-${stringToBase64URL(JSON.stringify(sessionPayload))}`;
  await context.addCookies([
    {
      name: "sb-example-auth-token",
      value: encoded,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
      expires: nowSec + 36000,
    },
  ]);
  return accessToken;
}

function defaultChildren(): MockChild[] {
  return [
    {
      id: IDS.childA,
      parent_id: IDS.parent,
      alias: "Bé An",
      grade: 1,
      settings: {},
      created_at: DEFAULT_TIMESTAMP,
      avatar_url: null,
    },
    {
      id: IDS.childB,
      parent_id: IDS.parent,
      alias: "Bé Bình",
      grade: 2,
      settings: {},
      created_at: DEFAULT_TIMESTAMP,
      avatar_url: null,
    },
  ];
}

function defaultBooks(): MockBook[] {
  return [
    {
      id: IDS.book1,
      title: "Chú Mèo Nhỏ Đi Học",
      author: "Nguyễn Minh",
      min_grade: 1,
      max_grade: 2,
      lifecycle_status: "ACTIVE",
      visibility_scope: "CATALOG",
      cover_url: "http://127.0.0.1:8000/public-assets/cover-cat.png",
      cover_source_type: "USER_UPLOAD",
    },
    {
      id: IDS.book2,
      title: "Khu Vườn Mùa Xuân",
      author: "Trần Lan",
      min_grade: 2,
      max_grade: 3,
      lifecycle_status: "ACTIVE",
      visibility_scope: "CATALOG",
      cover_url: "http://127.0.0.1:8000/public-assets/cover-garden.png",
      cover_source_type: "USER_UPLOAD",
    },
  ];
}

function buildDifficultWords(count: number, childId: string) {
  const words = [
    { normalized: "nghien", display: "Nghiêng" },
    { normalized: "khuya", display: "Khuya" },
    { normalized: "ngoan", display: "Ngoan" },
    { normalized: "thuyen", display: "Thuyền" },
    { normalized: "suong", display: "Sương" },
    { normalized: "khuat", display: "Khuất" },
    { normalized: "nguoi", display: "Người" },
    { normalized: "chuyen", display: "Chuyện" },
    { normalized: "thuong", display: "Thương" },
    { normalized: "quyen", display: "Quyển" },
  ];
  return Array.from({ length: count }, (_, idx) => {
    const sample = words[idx % words.length] ?? words[0];
    const suffix = idx >= words.length ? ` ${idx + 1}` : "";
    return {
      normalized_word: `${sample.normalized}${idx >= words.length ? idx : ""}`,
      display_text: `${sample.display}${suffix}`,
      difficulty_score: Math.max(1, 10 - idx),
      omission_count: 1 + (idx % 2),
      repetition_count: idx % 2,
      long_pause_count: 1,
      read_example_count: 0,
      session_count: 2,
      last_seen_at: DEFAULT_TIMESTAMP,
      evidence_word_ids: [IDS.word1],
      mispronunciation_count: 1,
      encounter_count: 2,
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
          book_id: IDS.book1,
          book_title: "Chú Mèo Nhỏ Đi Học",
          book_author: "Nguyễn Minh",
          min_grade: 1,
          max_grade: 2,
          book_cover_url: "http://127.0.0.1:8000/public-assets/cover-cat.png",
          session_id: IDS.session1,
          page_id: IDS.page1,
          page_revision_id: IDS.revision1,
          page_number: 1,
          word_id: IDS.word1,
          context_phrase: `${sample.display}${suffix} trong trang sách`,
          last_seen_at: DEFAULT_TIMESTAMP,
        },
      ],
      child_id: childId,
    };
  });
}

function makePrivateSubmission(
  bookId: string,
  overrideStatus = "PASSED_READY_TO_ADD",
) {
  return {
    id: IDS.submission1,
    book_id: bookId,
    batch_id: IDS.batch1,
    batch_total_pages: 1,
    source_page_number: 1,
    target_page_number: 1,
    source_file_name: "trang-1.png",
    source_format: "PNG",
    image_width: 800,
    image_height: 1000,
    image_url: `http://127.0.0.1:8000/books/my-books/${bookId}/pages/${IDS.privatePage1}/image`,
    source_type: "OWNED_PHYSICAL_BOOK",
    source_type_label: "Sách giấy gia đình đã mua để con luyện đọc tại nhà",
    source_note: "Sách gia đình",
    submission_version: 1,
    optimistic_lock_version: 1,
    workflow_status: overrideStatus,
    workflow_status_label: "Sẵn sàng thêm",
    ocr_status: "COMPLETED",
    ocr_text: "Chú mèo nhỏ đi học.",
    ocr_error_code: null,
    is_image_only: false,
    proofread_status: "PASSED",
    proofread_text: "Chú mèo nhỏ đi học.",
    proofread_suggestions: [],
    uncertain_word_indices: [],
    proofread_error_code: null,
    spelling_accepted: true,
    candidate_text: "Chú mèo nhỏ đi học.",
    candidate_hash: "a".repeat(64),
    tool_check_status: "PASSED",
    tool_check_suitability: "SUITABLE",
    tool_check_scope: {
      modality: "TEXT_ONLY",
      covers_all_chunks: true,
      chunks_checked: 1,
      total_chunks: 1,
      image_visual_safety_checked: false,
      requires_admin_visual_review: false,
      copyright_scanner_status: "NOT_CONFIGURED",
      local_ai_enforced: true,
    },
    tool_check_findings_count: 0,
    tool_check_parent_notice: null,
    tool_check_policy_blocked: false,
    tool_check_workflow_id: null,
    tool_check_error_code: null,
    provider_events: [],
    can_add_to_book: true,
    can_request_admin_review: false,
    can_retry: false,
    admin_decision: null,
    admin_decision_reason: null,
    approved_snapshot_hash: null,
    approved_submission_version: null,
    committed_page_id: null,
    committed_revision_id: null,
    created_at: DEFAULT_TIMESTAMP,
    updated_at: DEFAULT_TIMESTAMP,
  };
}

export async function installMockApi(
  page: Page,
  options: MockApiOptions = {},
): Promise<MockApiTracker> {
  const context = page.context();
  await seedParentSession(context);

  const children = options.emptyChildren
    ? []
    : [...(options.initialChildren ?? defaultChildren())];
  const effectiveSelectedChildId =
    options.selectedChildId === undefined
      ? (children[0]?.id ?? null)
      : options.selectedChildId;
  if (effectiveSelectedChildId) {
    await context.addInitScript(
      ({ key, childId }) => {
        try {
          if (!window.sessionStorage.getItem(key)) {
            window.sessionStorage.setItem(key, childId);
          }
        } catch {
          // Ignore restricted sessionStorage errors
        }
      },
      {
        key: `viread:selected-child:${IDS.parent}`,
        childId: effectiveSelectedChildId,
      },
    );
  }
  await context.addInitScript(() => {
    try {
      const createSilentStream = (): MediaStream => {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (AudioCtx) {
          try {
            const ctx = new AudioCtx();
            if (typeof ctx.createMediaStreamDestination === "function") {
              const dest = ctx.createMediaStreamDestination();
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              gain.gain.value = 0;
              osc.connect(gain);
              gain.connect(dest);
              osc.start();
              (
                window as unknown as { __vireadMockAudioCtx?: AudioContext }
              ).__vireadMockAudioCtx = ctx;
              return dest.stream;
            }
          } catch {
            // Fall through to empty MediaStream if AudioContext is unavailable
          }
        }
        return new MediaStream();
      };

      const fakeMediaDevices = {
        getUserMedia: async () => createSilentStream(),
        enumerateDevices: async () => [
          {
            deviceId: "mock-mic-1",
            groupId: "mock-group-1",
            kind: "audioinput" as MediaDeviceKind,
            label: "Mock Microphone",
            toJSON() {
              return this;
            },
          },
        ],
        getSupportedConstraints: () => ({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }),
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      };

      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        get: () => fakeMediaDevices,
      });

      class MockE2ESpeechRecognition {
        continuous = true;
        interimResults = true;
        lang = "vi-VN";
        maxAlternatives = 1;
        onresult: ((ev: unknown) => void) | null = null;
        onerror: ((ev: unknown) => void) | null = null;
        onend: (() => void) | null = null;
        start(): void {}
        stop(): void {
          this.onend?.();
        }
        abort(): void {
          this.onend?.();
        }
      }

      const win = window as unknown as {
        SpeechRecognition?: unknown;
        webkitSpeechRecognition?: unknown;
      };
      if (!win.SpeechRecognition) {
        win.SpeechRecognition = MockE2ESpeechRecognition;
      }
      if (!win.webkitSpeechRecognition) {
        win.webkitSpeechRecognition = MockE2ESpeechRecognition;
      }
    } catch {
      // Ignore restricted window environments
    }
  });
  const books = options.emptyCatalog
    ? []
    : [...(options.initialBooks ?? defaultBooks())];
  interface MockPrivateBook {
    id: string;
    title: string;
    author: string | null;
    min_grade: number;
    max_grade: number;
    lifecycle_status: "ACTIVE" | "RETIRED";
    visibility_scope: "PARENT_PRIVATE";
    moderation_status: "ACTIVE" | "SUSPENDED";
    suspended_reason: string | null;
    source_declaration: string | null;
    committed_page_count: number;
    pending_submission_count: number;
    flagged_submission_count: number;
    failed_submission_count: number;
    ready_to_add_count: number;
    readable_for_children: boolean;
    has_held_multipage_batch: boolean;
    privacy_notice: string;
    ocr_contribution: null;
    created_at: string;
  }

  const privateBooks: MockPrivateBook[] =
    options.includePrivateBooks === false
      ? []
      : [
          {
            id: IDS.privateBook,
            title: "Truyện Gia Đình Bé An",
            author: "Ba mẹ",
            min_grade: 1,
            max_grade: 2,
            lifecycle_status: "ACTIVE" as const,
            visibility_scope: "PARENT_PRIVATE" as const,
            moderation_status: "ACTIVE" as const,
            suspended_reason: null,
            source_declaration: "[OWNED_PHYSICAL_BOOK] Sách giấy gia đình",
            committed_page_count: 1,
            pending_submission_count: 0,
            flagged_submission_count: 0,
            failed_submission_count: 0,
            ready_to_add_count: 0,
            readable_for_children: true,
            has_held_multipage_batch: false,
            privacy_notice:
              "Chỉ ba mẹ và các bé trong gia đình xem được sách này.",
            ocr_contribution: null,
            created_at: DEFAULT_TIMESTAMP,
          },
        ];

  let activeFaults: FaultRule[] = [...(options.faults ?? [])];
  const requests: RecordedRequest[] = [];
  const attemptCounts = new Map<string, number>();
  const requestTimestamps = new Map<string, number[]>();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  const failedImages: string[] = [];
  const collections: MockApiTracker["collections"] = [];
  const feedbackPayloads: Array<Record<string, unknown>> = [];

  const tracker: MockApiTracker = {
    requests,
    attemptCounts,
    requestTimestamps,
    consoleErrors,
    pageErrors,
    serverErrors,
    failedImages,
    children,
    books,
    collections,
    feedbackPayloads,
    emailPreferences: {
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
      updated_at: DEFAULT_TIMESTAMP,
    },
    setFaults(rules: FaultRule[]) {
      activeFaults = [...rules];
    },
    getAttemptCount(method: string, path: string) {
      return attemptCounts.get(`${method.toUpperCase()} ${path}`) ?? 0;
    },
    getTimestamps(method: string, path: string) {
      return requestTimestamps.get(`${method.toUpperCase()} ${path}`) ?? [];
    },
    assertCleanHealth(label, opts) {
      const allowed = opts?.expectedHttpStatuses ?? [];
      const unexpectedConsole = consoleErrors.filter((message) => {
        if (
          allowed.some((code) =>
            message.includes(
              `Failed to load resource: the server responded with a status of ${code}`,
            ),
          )
        ) {
          return false;
        }
        if (
          allowed.length > 0 &&
          message.includes("Failed to load resource: net::ERR_FAILED")
        ) {
          return false;
        }
        return true;
      });
      expect(pageErrors, `[${label}] Unexpected pageerror`).toEqual([]);
      expect(
        serverErrors.filter((entry) => {
          const status = Number(entry.split(" ")[0]);
          return !allowed.includes(status);
        }),
        `[${label}] Unexpected 5xx responses`,
      ).toEqual([]);
      expect(unexpectedConsole, `[${label}] Unexpected console.error`).toEqual(
        [],
      );
    },
  };

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  page.on("response", (res) => {
    if (res.status() >= 500) {
      serverErrors.push(`${res.status()} ${res.url()}`);
    }
    if (res.request().resourceType() === "image" && res.status() >= 400) {
      failedImages.push(`${res.status()} ${res.url()}`);
    }
  });

  const baseCorsHeaders: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "authorization,content-type,accept,x-viread-locale,x-voice-lock-update",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-expose-headers": "X-Request-ID,X-ViRead-Version",
    "x-request-id": "req-e2e-0001",
    "x-viread-version": "e2e-mock",
  };

  async function respondJson(
    route: Route,
    body: unknown,
    status = 200,
    extraHeaders: Record<string, string> = {},
  ) {
    await route.fulfill({
      status,
      headers: { ...baseCorsHeaders, ...extraHeaders },
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  }

  function popMatchingFault(method: string, path: string): FaultAction | null {
    for (const rule of activeFaults) {
      if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) {
        continue;
      }
      const matched =
        typeof rule.path === "string"
          ? rule.path === path
          : rule.path.test(path);
      if (matched && rule.sequence.length > 0) {
        return rule.sequence.shift() ?? null;
      }
    }
    return null;
  }

  await context.route("https://example.supabase.co/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    if (method === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        },
      });
    }
    if (url.pathname === "/auth/v1/token") {
      if (options.supabaseTokenShouldFail) {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            code: "invalid_credentials",
            error: "invalid_grant",
            error_description: "Invalid login credentials",
            msg: "Invalid login credentials",
          }),
        });
      }
      const token = makeFakeJwt(IDS.parent, "parent");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          access_token: token,
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "synthetic-refresh-token",
          user: {
            id: IDS.parent,
            aud: "authenticated",
            role: "authenticated",
            email: "parent@example.test",
            user_metadata: { role: "parent", display_name: "Ba mẹ ViRead" },
            app_metadata: { provider: "email" },
            created_at: DEFAULT_TIMESTAMP,
          },
        }),
      });
    }
    if (url.pathname === "/auth/v1/user" && method === "PUT") {
      if (options.supabaseUpdateUserShouldFail) {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ message: "Password update rejected" }),
        });
      }
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: IDS.parent,
        aud: "authenticated",
        role: "authenticated",
        email: "parent@example.test",
        user_metadata: { role: "parent", display_name: "Ba mẹ ViRead" },
        app_metadata: { provider: "email", providers: ["email"] },
        created_at: DEFAULT_TIMESTAMP,
      }),
    });
  });

  await context.route("http://127.0.0.1:8000/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    const path = url.pathname;

    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: baseCorsHeaders });
    }

    const startedAt = Date.now();
    const key = `${method} ${path}`;
    attemptCounts.set(key, (attemptCounts.get(key) ?? 0) + 1);
    const tsList = requestTimestamps.get(key) ?? [];
    tsList.push(startedAt);
    requestTimestamps.set(key, tsList);

    const fault = popMatchingFault(method, path);
    if (fault) {
      if (fault.delayMs && fault.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
      }
      if (fault.abort) {
        requests.push({
          method,
          path,
          search: url.search,
          url: request.url(),
          headers: request.headers(),
          startedAt,
          status: 0,
        });
        return route.abort("failed");
      }
      const faultStatus = fault.status ?? 500;
      requests.push({
        method,
        path,
        search: url.search,
        url: request.url(),
        headers: request.headers(),
        startedAt,
        status: faultStatus,
      });
      if (fault.contentType && fault.contentType !== "application/json") {
        return route.fulfill({
          status: faultStatus,
          headers: { ...baseCorsHeaders, ...(fault.headers ?? {}) },
          contentType: fault.contentType,
          body:
            typeof fault.body === "string"
              ? fault.body
              : String(fault.body ?? ""),
        });
      }
      return respondJson(
        route,
        fault.body ?? { detail: "Simulated upstream gateway error" },
        faultStatus,
        fault.headers ?? {},
      );
    }

    const recordAndRespond = async (
      body: unknown,
      status = 200,
      extraHeaders: Record<string, string> = {},
    ) => {
      requests.push({
        method,
        path,
        search: url.search,
        url: request.url(),
        headers: request.headers(),
        startedAt,
        status,
      });
      return respondJson(route, body, status, extraHeaders);
    };

    // Public catalog cover PNGs (no auth required, cacheable)
    if (method === "GET" && path.startsWith("/public-assets/")) {
      requests.push({
        method,
        path,
        search: url.search,
        url: request.url(),
        headers: request.headers(),
        startedAt,
        status: 200,
      });
      return route.fulfill({
        status: 200,
        headers: {
          ...baseCorsHeaders,
          "cache-control": "public, max-age=3600",
          "x-content-type-options": "nosniff",
        },
        contentType: "image/png",
        body: ONE_BY_ONE_PNG,
      });
    }

    // Private book page / submission image (auth required + private, no-store)
    if (
      method === "GET" &&
      /^\/books\/my-books\/[^/]+\/(pages|submissions)\/[^/]+\/image$/.test(path)
    ) {
      const auth = request.headers().authorization ?? "";
      if (!auth.startsWith("Bearer ")) {
        return recordAndRespond({ detail: "Unauthorized" }, 401);
      }
      requests.push({
        method,
        path,
        search: url.search,
        url: request.url(),
        headers: request.headers(),
        startedAt,
        status: 200,
      });
      return route.fulfill({
        status: 200,
        headers: {
          ...baseCorsHeaders,
          "cache-control":
            "private, no-store, no-cache, must-revalidate, max-age=0",
          pragma: "no-cache",
          vary: "Authorization",
          "x-content-type-options": "nosniff",
        },
        contentType: "image/png",
        body: ONE_BY_ONE_PNG,
      });
    }

    if (method === "GET" && path === "/health") {
      return recordAndRespond({
        status: "ok",
        ocr_mode: "remote_worker",
        ocr: { mode: "remote_worker", ready: true, workers: [], queue: {} },
      });
    }

    // Profile & Dashboard Summary
    if (method === "GET" && path === "/profiles/me") {
      return recordAndRespond({
        id: IDS.parent,
        role: "parent",
        display_name: "Ba mẹ ViRead",
        created_at: DEFAULT_TIMESTAMP,
        email: "parent@example.test",
        contact_phone: "+84900000000",
        email_verified: true,
        contact_info_status: "available",
        children,
        avatar_url: null,
      });
    }
    if (method === "GET" && path === "/profiles/dashboard-summary") {
      return recordAndRespond({
        profile: {
          id: IDS.parent,
          role: "parent",
          display_name: "Ba mẹ ViRead",
          created_at: DEFAULT_TIMESTAMP,
          email: "parent@example.test",
          contact_phone: "+84900000000",
          email_verified: true,
          contact_info_status: "available",
          avatar_url: null,
          children,
        },
        children,
        latest_sessions_by_child: {},
      });
    }

    // Children CRUD
    if (method === "GET" && path === "/profiles/children") {
      return recordAndRespond(children);
    }
    if (method === "POST" && path === "/profiles/children") {
      const payload = request.postDataJSON() as {
        alias?: string;
        grade?: number;
      };
      const created: MockChild = {
        id: `92000000-0000-4000-8000-${String(children.length + 10).padStart(12, "0")}`,
        parent_id: IDS.parent,
        alias: (payload.alias ?? "Bé Mới").trim() || "Bé Mới",
        grade: Number(payload.grade ?? 2),
        settings: {},
        created_at: DEFAULT_TIMESTAMP,
        avatar_url: null,
      };
      children.push(created);
      return recordAndRespond(created, 201);
    }
    const childMatch = /^\/profiles\/children\/([^/]+)$/.exec(path);
    if (childMatch) {
      const targetId = decodeURIComponent(childMatch[1]);
      const found = children.find((item) => item.id === targetId);
      if (!found) {
        return recordAndRespond({ detail: "Child not found" }, 404);
      }
      if (method === "GET") return recordAndRespond(found);
      if (method === "PUT") {
        const patch = request.postDataJSON() as {
          alias?: string;
          grade?: number;
        };
        if (typeof patch.alias === "string") found.alias = patch.alias;
        if (typeof patch.grade === "number") found.grade = patch.grade;
        return recordAndRespond(found);
      }
      if (method === "DELETE") {
        return recordAndRespond(null, 204);
      }
    }

    // Public Book Catalog & Previews
    if (method === "GET" && path === "/books/catalog") {
      const search = (url.searchParams.get("search") ?? "").toLocaleLowerCase(
        "vi",
      );
      const gradeParam = url.searchParams.get("grade");
      const grade = gradeParam ? Number(gradeParam) : null;
      const filtered = books.filter((item) => {
        if (
          search &&
          !`${item.title} ${item.author ?? ""}`
            .toLocaleLowerCase("vi")
            .includes(search)
        ) {
          return false;
        }
        if (
          grade !== null &&
          Number.isFinite(grade) &&
          (grade < item.min_grade || grade > item.max_grade)
        ) {
          return false;
        }
        return true;
      });
      return recordAndRespond(filtered);
    }
    const catalogBookMatch = /^\/books\/catalog\/([^/]+)$/.exec(path);
    if (method === "GET" && catalogBookMatch) {
      const bookId = decodeURIComponent(catalogBookMatch[1]);
      const found = books.find((item) => item.id === bookId);
      return found
        ? recordAndRespond(found)
        : recordAndRespond({ detail: "Book not found" }, 404);
    }
    const catalogPreviewMatch = /^\/books\/catalog\/([^/]+)\/preview$/.exec(
      path,
    );
    if (method === "GET" && catalogPreviewMatch) {
      const bookId = decodeURIComponent(catalogPreviewMatch[1]);
      const found = books.find((item) => item.id === bookId);
      if (!found) {
        return recordAndRespond({ detail: "Book not found" }, 404);
      }
      return recordAndRespond([
        {
          page_id: IDS.page1,
          page_number: 1,
          lifecycle_status: "ACTIVE",
          current_verified_revision_id: IDS.revision1,
          preview_url: "http://127.0.0.1:8000/public-assets/page-1.png",
        },
        {
          page_id: IDS.page2,
          page_number: 2,
          lifecycle_status: "ACTIVE",
          current_verified_revision_id: IDS.revision2,
          preview_url: "http://127.0.0.1:8000/public-assets/page-2.png",
        },
      ]);
    }
    if (method === "GET" && path === "/books/reports/mine") {
      return recordAndRespond({ items: [], total: 0, limit: 20, offset: 0 });
    }

    // Parent Private Books (/books/my-books)
    if (method === "GET" && path === "/books/my-books/paged") {
      return recordAndRespond({
        items: privateBooks,
        total: privateBooks.length,
        limit: 9,
        offset: 0,
      });
    }
    if (method === "GET" && path === "/books/my-books") {
      return recordAndRespond(privateBooks);
    }
    if (method === "POST" && path === "/books/my-books") {
      const payload = request.postDataJSON() as {
        title?: string;
        author?: string | null;
        min_grade?: number;
        max_grade?: number;
      };
      const created = {
        id: `82000000-0000-4000-8000-${String(privateBooks.length + 50).padStart(12, "0")}`,
        title: payload.title ?? "Sách riêng mới",
        author: payload.author ?? null,
        min_grade: payload.min_grade ?? 1,
        max_grade: payload.max_grade ?? 2,
        lifecycle_status: "ACTIVE" as const,
        visibility_scope: "PARENT_PRIVATE" as const,
        moderation_status: "ACTIVE" as const,
        suspended_reason: null,
        source_declaration: "[OWNED_PHYSICAL_BOOK]",
        committed_page_count: 0,
        pending_submission_count: 0,
        flagged_submission_count: 0,
        failed_submission_count: 0,
        ready_to_add_count: 0,
        readable_for_children: false,
        has_held_multipage_batch: false,
        privacy_notice: "Chỉ gia đình xem được sách này.",
        ocr_contribution: null,
        created_at: DEFAULT_TIMESTAMP,
      };
      privateBooks.push(created);
      return recordAndRespond(created, 201);
    }
    const myBookDetailMatch = /^\/books\/my-books\/([^/]+)$/.exec(path);
    if (method === "GET" && myBookDetailMatch) {
      const bookId = decodeURIComponent(myBookDetailMatch[1]);
      const found = privateBooks.find((item) => item.id === bookId);
      if (!found) return recordAndRespond({ detail: "Not found" }, 404);
      return recordAndRespond({
        book: found,
        pages: [
          {
            page_id: IDS.privatePage1,
            page_number: 1,
            current_verified_revision_id: IDS.revision1,
            verified_text: "Trang sách riêng của gia đình.",
            verified_text_preview: "Trang sách riêng của gia đình.",
            image_url: `http://127.0.0.1:8000/books/my-books/${found.id}/pages/${IDS.privatePage1}/image`,
            created_at: DEFAULT_TIMESTAMP,
          },
        ],
        submissions: [makePrivateSubmission(found.id)],
      });
    }
    if (
      method === "POST" &&
      /^\/books\/my-books\/[^/]+\/submissions$/.test(path)
    ) {
      const bookId = decodeURIComponent(path.split("/")[3] ?? IDS.privateBook);
      const submission = makePrivateSubmission(bookId);
      return recordAndRespond(
        {
          book_id: bookId,
          batch_id: IDS.batch1,
          source_format: "PNG",
          total_pages: 1,
          replayed_idempotency: false,
          submissions: [submission],
        },
        201,
      );
    }
    if (
      method === "GET" &&
      /^\/books\/my-books\/[^/]+\/ocr-contribution$/.test(path)
    ) {
      const bookId = decodeURIComponent(path.split("/")[3] ?? IDS.privateBook);
      return recordAndRespond({
        book_id: bookId,
        enabled: false,
        status: "OPTED_OUT",
        purpose: "FLOW2_ADMIN_VERIFIED_OCR",
        consent_version: 0,
        notice_version: "v1-2026-11-22",
        rights_confirmed: false,
        consented_at: null,
        revoked_at: null,
        revoke_reason: null,
        rights_basis: "OWNED_PHYSICAL_BOOK",
        rights_eligible_for_training: false,
        rights_ineligible_reason: "Sách giấy mua không dùng để huấn luyện.",
        pending_verification_count: 0,
        sync_queued_count: 0,
        synced_count: 0,
        rejected_count: 0,
        revoked_count: 0,
        status_notice: "Chưa bật chia sẻ dữ liệu OCR.",
      });
    }

    // Reading Management Collections
    if (method === "GET" && path === "/reading-management/collections") {
      const childId = url.searchParams.get("child_id") ?? IDS.childA;
      return recordAndRespond(
        collections.filter((item) => item.child_id === childId),
      );
    }
    const collectionBookMatch =
      /^\/reading-management\/collections\/([^/]+)$/.exec(path);
    if (method === "PUT" && collectionBookMatch) {
      const bookId = decodeURIComponent(collectionBookMatch[1]);
      const body = request.postDataJSON() as {
        child_id: string;
        collection_type: "FAVORITE" | "WANT_TO_READ";
      };
      const existing = collections.find(
        (item) =>
          item.child_id === body.child_id &&
          item.book_id === bookId &&
          item.collection_type === body.collection_type,
      );
      if (existing) {
        return recordAndRespond(existing, 200);
      }
      const foundBook = books.find((b) => b.id === bookId) ?? books[0];
      const entry = {
        id: `8b000000-0000-4000-8000-${String(collections.length + 1).padStart(12, "0")}`,
        child_id: body.child_id,
        book_id: bookId,
        collection_type: body.collection_type,
        created_at: DEFAULT_TIMESTAMP,
        book: {
          id: foundBook.id,
          title: foundBook.title,
          author: foundBook.author,
          min_grade: foundBook.min_grade,
          max_grade: foundBook.max_grade,
          lifecycle_status: "ACTIVE" as const,
          available_to_read: true,
        },
      };
      collections.push(entry);
      return recordAndRespond(entry, 200);
    }
    if (method === "DELETE" && collectionBookMatch) {
      const bookId = decodeURIComponent(collectionBookMatch[1]);
      const childId = url.searchParams.get("child_id");
      const collectionType = url.searchParams.get("collection_type");
      const idx = collections.findIndex(
        (item) =>
          item.child_id === childId &&
          item.book_id === bookId &&
          item.collection_type === collectionType,
      );
      if (idx >= 0) collections.splice(idx, 1);
      return recordAndRespond({ deleted: true });
    }
    if (
      path === "/reading-management/goals" ||
      path === "/reading-management/plans" ||
      path === "/reading-management/reminders" ||
      path === "/reading-management/reminders/due"
    ) {
      return recordAndRespond([]);
    }
    if (path === "/reading-presence/settings") {
      return recordAndRespond({
        email_enabled: false,
        updated_at: DEFAULT_TIMESTAMP,
      });
    }
    if (path.startsWith("/reading-presence/")) {
      return recordAndRespond({ ok: true, cancelled: 0 });
    }

    // Progress Reports & Difficult Words
    const periodsMatch = /^\/system\/progress\/([^/]+)\/periods$/.exec(path);
    if (method === "GET" && periodsMatch) {
      const targetChildId = decodeURIComponent(periodsMatch[1]);
      const cursor = url.searchParams.get("cursor");
      if (cursor === "page-2") {
        return recordAndRespond({
          items: [
            {
              id: IDS.report2,
              child_id: targetChildId,
              period_start: "2026-09-01",
              period_end: "2026-09-30",
              generated_at: DEFAULT_TIMESTAMP,
            },
          ],
          next_cursor: null,
        });
      }
      return recordAndRespond({
        items: [
          {
            id: IDS.report1,
            child_id: targetChildId,
            period_start: "2026-10-01",
            period_end: "2026-10-30",
            generated_at: DEFAULT_TIMESTAMP,
          },
        ],
        next_cursor: options.periodsHasMore ? "page-2" : null,
      });
    }
    const progressMatch = /^\/system\/progress\/([^/]+)$/.exec(path);
    if (method === "GET" && progressMatch) {
      const targetChildId = decodeURIComponent(progressMatch[1]);
      const pStart = url.searchParams.get("period_start") ?? "2026-10-01";
      const pEnd = url.searchParams.get("period_end") ?? "2026-10-30";
      const dataStatus = options.reportDataStatus ?? "complete";
      const wordCount = options.difficultWordCount ?? 10;
      return recordAndRespond({
        id: IDS.report1,
        generated_at: DEFAULT_TIMESTAMP,
        child_id: targetChildId,
        period_start: pStart,
        period_end: pEnd,
        completed_sessions: dataStatus === "partial" ? null : 4,
        reading_duration_ms: dataStatus === "partial" ? null : 480000,
        omission_count: dataStatus === "partial" ? null : 2,
        repetition_count: dataStatus === "partial" ? null : 1,
        long_pause_count: dataStatus === "partial" ? null : 1,
        omission_rate: dataStatus === "partial" ? null : 4.5,
        repetition_rate: dataStatus === "partial" ? null : 2.0,
        long_pause_rate: dataStatus === "partial" ? null : 1.5,
        comprehension_accuracy: dataStatus === "partial" ? null : 85,
        difficult_words:
          dataStatus === "partial"
            ? null
            : buildDifficultWords(wordCount, targetChildId),
        previous_period: null,
        trend_deltas: {
          completed_sessions: null,
          reading_duration_ms: null,
          omission_rate: null,
          repetition_rate: null,
          long_pause_rate: null,
          comprehension_accuracy: null,
        },
        legacy: null,
        data_status: dataStatus,
        availability: {
          metrics: dataStatus === "partial" ? "partial" : "available",
          difficult_words: dataStatus === "partial" ? "absent" : "available",
          comparison: "absent",
        },
      });
    }
    const assessmentMatch =
      /^\/tutor\/children\/([^/]+)\/progress-assessment$/.exec(path);
    if (method === "GET" && assessmentMatch) {
      const targetChildId = decodeURIComponent(assessmentMatch[1]);
      const day = DEFAULT_TIMESTAMP.slice(0, 10);
      return recordAndRespond({
        child_id: targetChildId,
        period_start: day,
        period_end: day,
        days: 30,
        generated_at: DEFAULT_TIMESTAMP,
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
    if (
      method === "GET" &&
      /^\/system\/difficult-words\/[^/]+\/practice\/history$/.test(path)
    ) {
      return recordAndRespond({ storage_ready: true, items: [] });
    }
    const difficultListMatch = /^\/system\/difficult-words\/([^/]+)$/.exec(
      path,
    );
    if (method === "GET" && difficultListMatch) {
      return recordAndRespond(
        buildDifficultWords(
          options.difficultWordCount ?? 4,
          decodeURIComponent(difficultListMatch[1]),
        ),
      );
    }

    // Parent Notifications & Support
    if (method === "GET" && path === "/parent-notifications/preferences") {
      return recordAndRespond(tracker.emailPreferences);
    }
    if (method === "PUT" && path === "/parent-notifications/preferences") {
      const patch = request.postDataJSON() as Record<string, unknown>;
      tracker.emailPreferences = {
        ...tracker.emailPreferences,
        ...patch,
        updated_at: DEFAULT_TIMESTAMP,
      };
      return recordAndRespond(tracker.emailPreferences);
    }
    if (method === "GET" && path === "/parent-notifications/history") {
      return recordAndRespond([
        {
          id: IDS.delivery1,
          category: "TEST_EMAIL",
          status: "SENT",
          subject: "Email thử nghiệm từ ViRead",
          sent_at: DEFAULT_TIMESTAMP,
          created_at: DEFAULT_TIMESTAMP,
          error_code: null,
        },
      ]);
    }
    if (method === "POST" && path === "/parent-notifications/test-email") {
      return recordAndRespond({
        status: "SENT",
        delivery_id: IDS.delivery1,
        provider: "resend",
        error_code: null,
        message: "Đã gửi email thử nghiệm tới hộp thư phụ huynh.",
      });
    }
    if (method === "POST" && path === "/support/feedback") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      feedbackPayloads.push(payload);
      return recordAndRespond({
        accepted: true,
        delivery_status: "accepted_by_smtp",
        detail: "Support request accepted.",
      });
    }

    // Voice Engine & Studio
    if (method === "GET" && path === "/voice/status") {
      return recordAndRespond({
        default_mode: "local_only",
        default_voice_id: "Binh",
        local: { available: false, stt_ready: false, tts_ready: false },
        google: {
          stt_configured: true,
          tts_configured: true,
          stt_cooldown: false,
          tts_cooldown: false,
        },
      });
    }
    if (method === "GET" && path === "/voice/voices") {
      return recordAndRespond({
        default_voice_id: "Binh",
        local_worker_ready: false,
        google_tts_available: true,
        cached_voice_ids: [],
        voices: [
          {
            voice_id: "Binh",
            name: "Cô Bình",
            provider: "google",
            region: "north",
            region_label: "Miền Bắc",
            gender: "female",
            age: "young_adult",
            is_default: true,
          },
          {
            voice_id: "Lan",
            name: "Cô Lan",
            provider: "google",
            region: "south",
            region_label: "Miền Nam",
            gender: "female",
            age: "young_adult",
            is_default: false,
          },
        ],
      });
    }

    // Adaptive Learning & Picture Description
    const recMatch = /^\/learning\/children\/([^/]+)\/recommendations$/.exec(
      path,
    );
    if (method === "GET" && recMatch) {
      const childId = decodeURIComponent(recMatch[1]);
      const found = children.find((c) => c.id === childId) ?? children[0];
      return recordAndRespond({
        child_id: childId,
        child_alias: found?.alias ?? "Bé An",
        child_grade: found?.grade ?? 1,
        mascot_greeting_vi: "Chào bé! Hôm nay cùng vui học nhé!",
        natural_break_reminder_vi:
          "Mỗi phiên chơi khoảng 10–15 phút là vừa đẹp để mắt bé luôn khỏe mạnh.",
        today_activities_count: 1,
        focus_difficult_words: ["Nghiêng"],
        primary_recommendation: {
          game_key: "PICTURE_DESCRIPTION",
          zone_title_vi: "Thế giới kể chuyện",
          game_title_vi: "Kể chuyện qua tranh",
          reason_vi: "Quan sát tranh và kể bằng câu tiếng Việt sinh động.",
          suggested_mode: "OBSERVE",
          suggested_difficulty: 1,
          target_words: ["Nghiêng"],
          href: "/entertainment/picture-description",
          priority: 1,
        },
        recommendations: [
          {
            game_key: "PICTURE_DESCRIPTION",
            zone_title_vi: "Thế giới kể chuyện",
            game_title_vi: "Kể chuyện qua tranh",
            reason_vi: "Quan sát tranh và kể bằng câu tiếng Việt sinh động.",
            suggested_mode: "OBSERVE",
            suggested_difficulty: 1,
            target_words: ["Nghiêng"],
            href: "/entertainment/picture-description",
            priority: 1,
          },
        ],
      });
    }
    const analyticsMatch =
      /^\/learning\/children\/([^/]+)\/parent-analytics$/.exec(path);
    if (method === "GET" && analyticsMatch) {
      const childId = decodeURIComponent(analyticsMatch[1]);
      const found = children.find((c) => c.id === childId) ?? children[0];
      const parsedWindow = Number(url.searchParams.get("window_days") ?? 30);
      const windowDays =
        Number.isFinite(parsedWindow) && parsedWindow >= 7 && parsedWindow <= 90
          ? Math.floor(parsedWindow)
          : 30;
      return recordAndRespond({
        child_id: childId,
        child_alias: found?.alias ?? "Bé An",
        child_grade: found?.grade ?? 1,
        window_days: windowDays,
        is_diagnostic: false,
        disclaimer_vi:
          "Số liệu mang tính tham khảo từ các hoạt động luyện tập gần đây của bé, không phải đánh giá chẩn đoán.",
        observed_skills_count: 1,
        estimated_skills_count: 1,
        unknown_skills_count: 0,
        skills: [
          {
            skill_key: "reading_fluency",
            label_vi: "Đọc trôi chảy",
            domain: "READING_WORDS",
            status: "OBSERVED",
            mastery_pct: 84,
            confidence: 0.82,
            evidence_count: 3,
            high_confidence_count: 2,
            last_observed_at: "2026-10-20T09:00:00Z",
            source_modules: ["PICTURE_DESCRIPTION"],
          },
          {
            skill_key: "story_observation",
            label_vi: "Quan sát & kể chuyện",
            domain: "OBSERVATION_MEMORY_CREATIVITY",
            status: "ESTIMATED",
            mastery_pct: 78,
            confidence: 0.65,
            evidence_count: 1,
            high_confidence_count: 1,
            last_observed_at: "2026-10-19T15:00:00Z",
            source_modules: ["PICTURE_DESCRIPTION"],
          },
        ],
        practiced_difficult_words: [
          {
            normalized_word: "nghiêng",
            display_text: "Nghiêng",
            priority_score: 0.9,
            practice_count: 2,
            last_practiced_at: "2026-10-20T09:00:00Z",
            days_since_practice: 2,
            recommended_game: "PICTURE_DESCRIPTION",
            reason_vi: "Luyện lại từ khó trong ngữ cảnh tranh sinh động.",
          },
        ],
        module_activities: [
          {
            game_key: "PICTURE_DESCRIPTION",
            title_vi: "Kể chuyện qua tranh",
            sessions_count: 2,
            recent_average_pct: 85,
            highlight_vi: "Bé mô tả tranh rất tự tin.",
          },
        ],
        karaoke_weak_segments: [],
        home_support_tips_vi: [
          "Dành 10 phút mỗi ngày cùng bé đọc thành tiếng và trò chuyện về nội dung tranh.",
        ],
        generated_at: DEFAULT_TIMESTAMP,
      });
    }
    if (method === "GET" && path === "/games/picture-description/catalog") {
      return recordAndRespond({
        samples: [
          {
            sample_key: "happy-classroom",
            title: "Lớp học vui vẻ",
            theme: "Trường học",
            description: "Các bạn nhỏ đang đọc sách cùng cô giáo.",
            image_url: "/images/picture-description/happy-classroom.jpg",
          },
          {
            sample_key: "lakeside-picnic",
            title: "Dã ngoại bên hồ",
            theme: "Gia đình",
            description: "Gia đình cùng dã ngoại bên bờ hồ xanh mát.",
            image_url: "/images/picture-description/lakeside-picnic.jpg",
          },
          {
            sample_key: "sunny-garden",
            title: "Khu vườn đầy nắng",
            theme: "Thiên nhiên",
            description: "Chú mèo và chú bướm trong khu vườn đầy nắng.",
            image_url: "/images/picture-description/sunny-garden.jpg",
          },
        ],
        book_pages: [],
      });
    }
    if (method === "GET" && path === "/games/picture-description/sessions") {
      return recordAndRespond([]);
    }

    // Studio & Reading endpoints
    if (method === "GET" && path === "/studio/tasks") {
      return recordAndRespond({
        actor_id: IDS.parent,
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
    if (method === "GET" && /^\/studio\/books\/[^/]+\/assets$/.test(path)) {
      return recordAndRespond({
        book_id: IDS.book1,
        title: "Chú Mèo Nhỏ Đi Học",
        author: "Nguyễn Minh",
        min_grade: 1,
        max_grade: 2,
        visibility_scope: "CATALOG",
        active_cover: null,
        effective_cover_source: "METADATA_RENDER",
        metadata_fallback: {
          palette_id: "sky-voyage",
          primary_color: "#1D4ED8",
          secondary_color: "#DBEAFE",
          accent_color: "#F59E0B",
          motif: "storybook",
          title: "Chú Mèo Nhỏ Đi Học",
          author: "Nguyễn Minh",
          grade_label: "Lớp 1–2",
          source_type: "METADATA_RENDER",
        },
        style_bible: null,
        page_illustrations: [],
        ai_image_provider_available: false,
        ai_image_provider_name: null,
        ai_image_provider_message_vi: "Chưa cấu hình.",
        v2_storage_degraded: false,
      });
    }
    if (method === "GET" && path === "/reading/history") {
      return recordAndRespond({ sessions: [], next_cursor: null });
    }
    if (method === "GET" && path === "/reading/scan-page-ocr/jobs") {
      return recordAndRespond({ worker_online: true, jobs: [] });
    }

    // Voice TTS & Phonics synthesis stubs (match speech-service.ts Zod schemas)
    if (method === "POST" && path === "/voice/text-to-speech") {
      requests.push({
        method,
        path,
        search: url.search,
        url: request.url(),
        headers: request.headers(),
        startedAt,
        status: 200,
      });
      return route.fulfill({
        status: 200,
        headers: {
          ...baseCorsHeaders,
          "x-resolved-voice-id": "Binh",
          "x-tts-provider": "google",
        },
        contentType: "audio/wav",
        body: SILENT_WAV_BYTES,
      });
    }
    if (method === "POST" && path === "/voice/text-to-speech/phonics") {
      const payload = (request.postDataJSON() ?? {}) as {
        steps?: Array<{
          id?: string;
          spoken_text?: string;
          pause_after_ms?: number;
        }>;
        voice_id?: string;
      };
      const steps = Array.isArray(payload.steps) ? payload.steps : [];
      let cursor = 0;
      const stepTimings = steps.map((step, index) => {
        const start = Number(cursor.toFixed(3));
        const end = Number((cursor + 0.25).toFixed(3));
        cursor = end + 0.05;
        return {
          id: step.id ?? `step-${index}`,
          index,
          start,
          end,
        };
      });
      return recordAndRespond({
        audio_base64: SILENT_WAV_BYTES.toString("base64"),
        content_type: "audio/wav",
        duration_seconds: Math.max(0.4, Number(cursor.toFixed(3))),
        step_timings: stepTimings,
        provider: "google",
        resolved_voice_id: payload.voice_id ?? "Binh",
        region: "north",
        model_version: "e2e-mock-v1",
        cached_speed: null,
      });
    }
    if (method === "POST" && path === "/voice/speech-to-text") {
      return recordAndRespond({
        text: "",
        language_code: "vi",
        language_probability: 0.99,
        words: [],
      });
    }

    // Reading Sessions & Pages
    const readingPagesFixture = [
      {
        page_id: IDS.page1,
        page_revision_id: IDS.revision1,
        page_number: 1,
        confidence: 0.96,
        width: 800,
        height: 1000,
        image_url: "http://127.0.0.1:8000/public-assets/page-1.png",
        text: "Mèo nhỏ đi học.",
        words: [
          {
            word_id: IDS.word1,
            word_index: 0,
            text: "Mèo",
            bbox: [0.1, 0.12, 0.14, 0.05] as [number, number, number, number],
            line_index: 0,
          },
          {
            word_id: IDS.word2,
            word_index: 1,
            text: "nhỏ",
            bbox: [0.26, 0.12, 0.14, 0.05] as [number, number, number, number],
            line_index: 0,
          },
          {
            word_id: IDS.word3,
            word_index: 2,
            text: "đi",
            bbox: [0.42, 0.12, 0.1, 0.05] as [number, number, number, number],
            line_index: 0,
          },
          {
            word_id: IDS.word4,
            word_index: 3,
            text: "học.",
            bbox: [0.54, 0.12, 0.14, 0.05] as [number, number, number, number],
            line_index: 0,
          },
        ],
      },
      {
        page_id: IDS.page2,
        page_revision_id: IDS.revision2,
        page_number: 2,
        confidence: 0.96,
        width: 800,
        height: 1000,
        image_url: "http://127.0.0.1:8000/public-assets/page-2.png",
        text: "Bé cùng đọc sách.",
        words: [
          {
            word_id: IDS.word1,
            word_index: 0,
            text: "Bé",
            bbox: [0.1, 0.12, 0.12, 0.05] as [number, number, number, number],
            line_index: 0,
          },
          {
            word_id: IDS.word2,
            word_index: 1,
            text: "cùng",
            bbox: [0.24, 0.12, 0.14, 0.05] as [number, number, number, number],
            line_index: 0,
          },
          {
            word_id: IDS.word3,
            word_index: 2,
            text: "đọc",
            bbox: [0.4, 0.12, 0.12, 0.05] as [number, number, number, number],
            line_index: 0,
          },
          {
            word_id: IDS.word4,
            word_index: 3,
            text: "sách.",
            bbox: [0.54, 0.12, 0.15, 0.05] as [number, number, number, number],
            line_index: 0,
          },
        ],
      },
    ];
    const getOrInitReadingState = (sessionId: string) => {
      const storeKey = `reading:${sessionId}`;
      const holder = tracker as unknown as {
        _readingStates?: Map<
          string,
          {
            currentIndex: number;
            completedIds: Set<string>;
            state: "PAGE_READY" | "FINISHED";
          }
        >;
      };
      if (!holder._readingStates) holder._readingStates = new Map();
      let st = holder._readingStates.get(storeKey);
      if (!st) {
        st = {
          currentIndex: 0,
          completedIds: new Set<string>(),
          state: "PAGE_READY",
        };
        holder._readingStates.set(storeKey, st);
      }
      return st;
    };
    const buildProgressPayload = (sessionId: string) => {
      const st = getOrInitReadingState(sessionId);
      const activePage =
        readingPagesFixture[st.currentIndex] ?? readingPagesFixture[0];
      return {
        session_id: sessionId,
        persisted: true,
        start_page_id: IDS.page1,
        end_page_id: IDS.page2,
        current_page_id: activePage.page_id,
        start_page_number: 1,
        end_page_number: 2,
        current_page_number: activePage.page_number,
        current_index: st.currentIndex,
        total_pages: readingPagesFixture.length,
        completed_pages: st.completedIds.size,
        pages: readingPagesFixture.map((p, idx) => ({
          page_id: p.page_id,
          page_revision_id: p.page_revision_id,
          page_number: p.page_number,
          page_order: idx,
          status: st.completedIds.has(p.page_id)
            ? ("COMPLETED" as const)
            : idx === st.currentIndex
              ? ("IN_PROGRESS" as const)
              : ("PENDING" as const),
          started_at: idx <= st.currentIndex ? DEFAULT_TIMESTAMP : null,
          completed_at: st.completedIds.has(p.page_id)
            ? DEFAULT_TIMESTAMP
            : null,
        })),
      };
    };

    if (method === "POST" && path === "/reading/sessions") {
      const payload = request.postDataJSON() as {
        selected_page_id?: string;
        selected_page_revision_id?: string;
      };
      return recordAndRespond(
        {
          Id: IDS.session1,
          State: "IN_PROGRESS",
          SelectedPageId: payload.selected_page_id ?? IDS.page1,
          SelectedPageRevisionId:
            payload.selected_page_revision_id ?? IDS.revision1,
          StartedAt: DEFAULT_TIMESTAMP,
        },
        201,
      );
    }

    const readingSessionMatch = /^\/reading\/sessions\/([^/]+)$/.exec(path);
    if (method === "GET" && readingSessionMatch) {
      const sessionId = decodeURIComponent(readingSessionMatch[1]);
      const st = getOrInitReadingState(sessionId);
      return recordAndRespond({
        id: sessionId,
        child_id: effectiveSelectedChildId ?? IDS.childA,
        book_id: IDS.book1,
        state: st.state,
        started_at: DEFAULT_TIMESTAMP,
        ended_at: st.state === "FINISHED" ? DEFAULT_TIMESTAMP : null,
        duration_ms: st.state === "FINISHED" ? 120000 : null,
      });
    }

    const readingPageMatch = /^\/reading\/sessions\/([^/]+)\/page$/.exec(path);
    if (method === "GET" && readingPageMatch) {
      const sessionId = decodeURIComponent(readingPageMatch[1]);
      const st = getOrInitReadingState(sessionId);
      return recordAndRespond(
        readingPagesFixture[st.currentIndex] ?? readingPagesFixture[0],
      );
    }

    const readingProgressMatch =
      /^\/reading\/sessions\/([^/]+)\/progress$/.exec(path);
    if (method === "GET" && readingProgressMatch) {
      const sessionId = decodeURIComponent(readingProgressMatch[1]);
      return recordAndRespond(buildProgressPayload(sessionId));
    }

    const readingNavigateMatch =
      /^\/reading\/sessions\/([^/]+)\/navigate$/.exec(path);
    if (method === "POST" && readingNavigateMatch) {
      const sessionId = decodeURIComponent(readingNavigateMatch[1]);
      const st = getOrInitReadingState(sessionId);
      const body = request.postDataJSON() as { target_page_id?: string };
      const nextIdx = readingPagesFixture.findIndex(
        (p) => p.page_id === body.target_page_id,
      );
      if (nextIdx >= 0) {
        st.currentIndex = nextIdx;
      }
      return recordAndRespond(buildProgressPayload(sessionId));
    }

    const readingCompletePageMatch =
      /^\/reading\/sessions\/([^/]+)\/pages\/([^/]+)\/complete$/.exec(path);
    if (method === "POST" && readingCompletePageMatch) {
      const sessionId = decodeURIComponent(readingCompletePageMatch[1]);
      const pageId = decodeURIComponent(readingCompletePageMatch[2]);
      const st = getOrInitReadingState(sessionId);
      st.completedIds.add(pageId);
      return recordAndRespond(buildProgressPayload(sessionId));
    }

    const readingCompletionMatch =
      /^\/reading\/sessions\/([^/]+)\/completion-summary$/.exec(path);
    if (method === "GET" && readingCompletionMatch) {
      return recordAndRespond({
        assessment: null,
        duration_minutes: 2,
        pages_explored: 2,
        selected_range_pages: 2,
        practiced_words: 4,
        spoken_words: ["Mèo", "nhỏ", "đi", "học"],
        transcripts: ["Mèo nhỏ đi học."],
        correct_words: ["Mèo", "nhỏ", "đi", "học"],
        mispronounced_words: [],
        skipped_words: [],
        score: 100,
      });
    }

    const readingPracticeMatch =
      /^\/reading\/sessions\/([^/]+)\/practice-state$/.exec(path);
    if (method === "GET" && readingPracticeMatch) {
      const sessionId = decodeURIComponent(readingPracticeMatch[1]);
      return recordAndRespond({
        session_id: sessionId,
        legacy_evidence_present: false,
        pages: [],
        words: [],
      });
    }

    const readingFinishMatch = /^\/reading\/sessions\/([^/]+)\/finish$/.exec(
      path,
    );
    if (method === "POST" && readingFinishMatch) {
      const sessionId = decodeURIComponent(readingFinishMatch[1]);
      const st = getOrInitReadingState(sessionId);
      st.state = "FINISHED";
      return recordAndRespond({
        id: sessionId,
        child_id: effectiveSelectedChildId ?? IDS.childA,
        book_id: IDS.book1,
        state: "FINISHED",
        started_at: DEFAULT_TIMESTAMP,
        ended_at: DEFAULT_TIMESTAMP,
        duration_ms: 120000,
      });
    }

    const readingReportsMatch = /^\/reading\/sessions\/([^/]+)\/reports$/.exec(
      path,
    );
    if (method === "GET" && readingReportsMatch) {
      const sessionId = decodeURIComponent(readingReportsMatch[1]);
      return recordAndRespond({
        assessment: null,
        session_id: sessionId,
        total: 0,
        reports: [],
      });
    }

    const readingDirectPageMatch = /^\/reading\/pages\/([^/]+)$/.exec(path);
    if (method === "GET" && readingDirectPageMatch) {
      const pageId = decodeURIComponent(readingDirectPageMatch[1]);
      const found =
        readingPagesFixture.find((p) => p.page_id === pageId) ??
        readingPagesFixture[0];
      return recordAndRespond(found);
    }

    // Tutor Comprehension Questions
    const tutorGenerateMatch =
      /^\/tutor\/sessions\/([^/]+)\/questions\/generate$/.exec(path);
    if (method === "POST" && tutorGenerateMatch) {
      const sessionId = decodeURIComponent(tutorGenerateMatch[1]);
      const total = options.comprehensionQuestionCount ?? 0;
      return recordAndRespond({
        session_id: sessionId,
        total,
        source: "RULE_BASED",
        created: total > 0,
      });
    }

    const tutorNextMatch = /^\/tutor\/sessions\/([^/]+)\/questions\/next$/.exec(
      path,
    );
    if (method === "GET" && tutorNextMatch) {
      return recordAndRespond({
        question: {
          id: IDS.question1,
          type: "FACTUAL",
          prompt: "Chú mèo nhỏ ngồi ở đâu?",
          page_revision_id: IDS.revision1,
          source_span: {
            start_word_index: 0,
            end_word_index_exclusive: 3,
            sentence_index: 0,
          },
          difficulty: 1,
          answered: false,
        },
        choices: [
          { id: "A", label: "Ngoài sân", value: "Ngoài sân" },
          { id: "B", label: "Bên cửa sổ", value: "Bên cửa sổ" },
          { id: "C", label: "Trong bếp", value: "Trong bếp" },
        ],
        progress_label: "Câu 1 / 1",
        position: 1,
        total: 1,
        completed: false,
      });
    }

    const tutorAnswerMatch =
      /^\/tutor\/sessions\/([^/]+)\/questions\/([^/]+)\/answer$/.exec(path);
    if (method === "POST" && tutorAnswerMatch) {
      const qId = decodeURIComponent(tutorAnswerMatch[2]);
      const body = request.postDataJSON() as { answer?: string };
      return recordAndRespond({
        answer_id: IDS.answer1,
        question_id: qId,
        submitted_answer: body.answer ?? "Bên cửa sổ",
        is_correct: true,
        score: 100,
        feedback_code: "CORRECT",
        story_hint: null,
      });
    }

    return recordAndRespond({ detail: `Unhandled mock path: ${path}` }, 404);
  });

  return tracker;
}
