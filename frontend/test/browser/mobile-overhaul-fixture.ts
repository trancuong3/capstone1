import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { previewDetail, songId, versionId } from "../karaoke-fixtures";
import {
  book as baseBook,
  ids,
  installApiFixture,
  readyVoiceStatus,
  type BrowserApiState,
} from "./real-data-fixture";

const TIMESTAMP = "2026-11-26T08:00:00Z";

export const MOBILE_IDS = {
  parent: ids.parent,
  childAn: ids.child,
  childBinh: "22222222-2222-4222-8222-222222222223",
  childLong: "22222222-2222-4222-8222-222222222224",
  bookPrimary: ids.book,
  bookSecondary: "33333333-3333-4333-8333-333333333334",
  bookLongTitle: "33333333-3333-4333-8333-333333333335",
  privateBook1: "aa000000-0000-4000-8000-000000000001",
  sessionPrimary: ids.session,
  sessionResumable: "44444444-4444-4444-8444-444444444445",
  pagePrimary: ids.page,
  revisionPrimary: ids.revision,
  report1: "bb000000-0000-4000-8000-000000000001",
  pictureSession1: "cc000000-0000-4000-8000-000000000001",
  shooterSession1: "dd000000-0000-4000-8000-000000000001",
  karaokeSongId: songId,
  karaokeVersionId: versionId,
} as const;

export function makeUuid(prefixHex: string, index: number): string {
  return `${prefixHex}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export function syntheticWavBuffer(seconds = 2): Buffer {
  const rate = 8000;
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

export interface MobileOverhaulFixtureOptions {
  readonly childrenPreset?: "default" | "long-names" | "empty";
  readonly catalogCount?: number;
  readonly longBookTitles?: boolean;
  readonly previewPagesCount?: number;
  readonly reportsCount?: number;
  readonly myBooksCount?: number;
  readonly shooterBooksCount?: number;
  readonly shooterChallengeTokens?: boolean;
  readonly ocrWorkerOnline?: boolean;
  readonly resumableSession?: boolean;
  readonly historySessionsCount?: number;
  readonly hasNextHistoryCursor?: boolean;
  readonly hasMorePeriods?: boolean;
}

export interface MobileOverhaulState {
  readonly base: BrowserApiState;
  readonly pageErrors: string[];
  readonly consoleErrors: string[];
  readonly unexpected: string[];
  readonly requests: string[];
  parentProfile: {
    id: string;
    role: "parent";
    display_name: string;
    email: string;
    contact_phone: string | null;
    email_verified: boolean;
    contact_info_status: "available";
    avatar_url: string | null;
    created_at: string;
  };
  children: Array<{
    id: string;
    parent_id: string;
    alias: string;
    grade: number;
    avatar_url?: string | null;
    settings: Record<string, unknown>;
    created_at: string;
  }>;
  catalogStatus: number;
  previewStatus: number;
  reportsStatus: number;
  reportDetailStatus: number;
  myBooksStatus: number;
  shooterStatus: number;
  shooterShotStatus: number;
  shooterResultStatus: number;
  pictureStatus: number;
  pictureEvaluateStatus: number;
  supportStatus: number;
  difficultWordsStatus: number;
  ocrWorkerOnline: boolean;
  ocrScanStatus: number;
  reports: Array<Record<string, unknown>>;
  collections: Array<Record<string, unknown>>;
  goals: Array<Record<string, unknown>>;
  plans: Array<Record<string, unknown>>;
  reminders: Array<Record<string, unknown>>;
  myBooks: Array<Record<string, unknown>>;
  shooterResultCalls: number;
  supportPayloads: Array<Record<string, unknown>>;
}

function makeChild(
  id: string,
  alias: string,
  grade: number,
): MobileOverhaulState["children"][number] {
  return {
    id,
    parent_id: MOBILE_IDS.parent,
    alias,
    grade,
    avatar_url: null,
    settings: {},
    created_at: TIMESTAMP,
  };
}

function makeBook(
  index: number,
  options: { longTitle?: boolean } = {},
): Record<string, unknown> {
  const id =
    index === 1
      ? MOBILE_IDS.bookPrimary
      : index === 2
        ? MOBILE_IDS.bookSecondary
        : makeUuid("33333333", index);
  const title = options.longTitle
    ? `Cuốn sách tiếng Việt siêu dài số ${index}: Hành trình khám phá khu rừng cổ tích đầy ánh nắng mùa xuân và những người bạn nhỏ thông minh chăm đọc mỗi ngày`
    : index === 1
      ? "Chào ngày mới cùng Bé An"
      : index === 2
        ? "Khu vườn mùa thu của Bé Bình"
        : `Truyện đọc thiếu nhi tập ${index}`;
  return {
    id,
    name: title,
    title,
    author:
      index === 1
        ? "Minh Anh"
        : index === 2
          ? "Lan Chi"
          : `Tác giả thiếu nhi ${index}`,
    min_grade: 1,
    max_grade: 5,
    lifecycle_status: "ACTIVE",
    visibility_scope: "CATALOG",
  };
}

function makePrivateBook(
  index: number,
  longTitle = false,
): Record<string, unknown> {
  const id =
    index === 1 ? MOBILE_IDS.privateBook1 : makeUuid("aa000000", index);
  return {
    id,
    title:
      longTitle && index === 1
        ? "Cuốn sách riêng gia đình có tiêu đề rất dài để kiểm tra xuống dòng và tràn ngang trên màn hình điện thoại nhỏ 360px"
        : `Sách Gia Đình #${String(index).padStart(2, "0")}`,
    author: `Gia đình ViRead (${index})`,
    min_grade: 1,
    max_grade: 3,
    lifecycle_status: "ACTIVE",
    visibility_scope: "PARENT_PRIVATE",
    moderation_status: "ACTIVE",
    suspended_reason: null,
    source_declaration: "[OWNED_PHYSICAL_BOOK] Sách giấy gia đình",
    committed_page_count: index === 1 ? 2 : 1,
    pending_submission_count: 0,
    flagged_submission_count: 0,
    failed_submission_count: 0,
    ready_to_add_count: 0,
    readable_for_children: true,
    has_held_multipage_batch: false,
    privacy_notice: "Chỉ bạn và các hồ sơ trẻ của bạn có thể đọc sách này.",
    created_at: TIMESTAMP,
  };
}

export async function installMobileOverhaulFixture(
  page: Page,
  options: MobileOverhaulFixtureOptions = {},
): Promise<MobileOverhaulState> {
  const base = await installApiFixture(page);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  const childrenPreset = options.childrenPreset ?? "default";
  const children: MobileOverhaulState["children"] =
    childrenPreset === "empty"
      ? []
      : childrenPreset === "long-names"
        ? [
            makeChild(
              MOBILE_IDS.childAn,
              "Nguyễn Hoàng Minh Khôi Anh Thư Đọc Sách Giỏi Nhất Lớp",
              2,
            ),
            makeChild(MOBILE_IDS.childBinh, "Bé Bình", 1),
          ]
        : [
            makeChild(MOBILE_IDS.childAn, "Bé An", 2),
            makeChild(MOBILE_IDS.childBinh, "Bé Bình", 1),
          ];

  const parentProfile: MobileOverhaulState["parentProfile"] = {
    id: MOBILE_IDS.parent,
    role: "parent",
    display_name:
      childrenPreset === "long-names"
        ? "Phụ Huynh Nguyễn Trần Hoàng Gia Bảo Minh Thư"
        : "Ba mẹ API",
    email:
      childrenPreset === "long-names"
        ? "phu.huynh.nguyen.tran.hoang.gia.bao.rat.dai@example.test"
        : "parent@example.test",
    contact_phone: "+84900000000",
    email_verified: true,
    contact_info_status: "available",
    avatar_url: null,
    created_at: TIMESTAMP,
  };

  const catalogCount = options.catalogCount ?? 2;
  const catalogBooks = Array.from({ length: catalogCount }, (_, idx) =>
    makeBook(idx + 1, {
      longTitle: Boolean(options.longBookTitles && idx === 0),
    }),
  );

  const previewPagesCount = options.previewPagesCount ?? 4;
  const previewPages = Array.from({ length: previewPagesCount }, (_, idx) => ({
    page_id:
      idx === 0 ? MOBILE_IDS.pagePrimary : makeUuid("55555555", idx + 10),
    page_number: idx + 1,
    lifecycle_status: "ACTIVE",
    current_verified_revision_id:
      idx === 0 ? MOBILE_IDS.revisionPrimary : makeUuid("66666666", idx + 10),
    preview_url: "http://127.0.0.1:8000/test-page.svg",
  }));

  const reportsCount = options.reportsCount ?? 1;
  const reports: Array<Record<string, unknown>> = Array.from(
    { length: reportsCount },
    (_, idx) => ({
      id: idx === 0 ? MOBILE_IDS.report1 : makeUuid("bb000000", idx + 1),
      book_id: MOBILE_IDS.bookPrimary,
      book_title: String(catalogBooks[0]?.title ?? baseBook.title),
      reporter_name: parentProfile.display_name,
      page_id: MOBILE_IDS.pagePrimary,
      page_number: 1,
      page_revision_id: MOBILE_IDS.revisionPrimary,
      issue_type: "SPELLING_ERROR",
      description:
        idx === 0 && options.longBookTitles
          ? "Mô tả rất dài để kiểm tra xuống dòng trên màn hình hẹp 360px: chữ trên trang sách cần bổ sung dấu thanh tiếng Việt rõ ràng hơn ở đoạn mở đầu câu chuyện."
          : `Báo cáo lỗi chính tả mẫu số ${idx + 1}`,
      reported_text: "chu meo nho",
      suggested_correction: "chú mèo nhỏ",
      status: idx % 2 === 0 ? "OPEN" : "RESOLVED",
      scan_run_id: makeUuid("bc000000", idx + 1),
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    }),
  );

  const myBooksCount = options.myBooksCount ?? 2;
  const myBooks: Array<Record<string, unknown>> = Array.from(
    { length: myBooksCount },
    (_, idx) => makePrivateBook(idx + 1, Boolean(options.longBookTitles)),
  );
  const myBookDetails = new Map<
    string,
    { pages: unknown[]; submissions: unknown[] }
  >();
  for (const item of myBooks) {
    const id = String(item.id);
    myBookDetails.set(id, {
      pages: [
        {
          page_id: makeUuid("ab000000", 1),
          page_number: 1,
          current_verified_revision_id: MOBILE_IDS.revisionPrimary,
          verified_text: "Bé đọc sách cùng ba mẹ mỗi buổi tối.",
          verified_text_preview: "Bé đọc sách cùng ba mẹ mỗi buổi tối.",
          image_url: "http://127.0.0.1:8000/test-page.svg",
          created_at: TIMESTAMP,
        },
      ],
      submissions: [],
    });
  }

  const state: MobileOverhaulState = {
    base,
    pageErrors,
    consoleErrors,
    unexpected: [],
    requests: [],
    parentProfile,
    children,
    catalogStatus: 200,
    previewStatus: 200,
    reportsStatus: 200,
    reportDetailStatus: 200,
    myBooksStatus: 200,
    shooterStatus: 200,
    shooterShotStatus: 200,
    shooterResultStatus: 200,
    pictureStatus: 200,
    pictureEvaluateStatus: 200,
    supportStatus: 200,
    difficultWordsStatus: 200,
    ocrWorkerOnline: options.ocrWorkerOnline ?? true,
    ocrScanStatus: 200,
    reports,
    collections: [
      {
        id: makeUuid("88888888", 1),
        child_id: MOBILE_IDS.childAn,
        book_id: MOBILE_IDS.bookSecondary,
        collection_type: "WANT_TO_READ",
        created_at: TIMESTAMP,
        book: {
          id: MOBILE_IDS.bookSecondary,
          title: String(
            catalogBooks[1]?.title ?? "Khu vườn mùa thu của Bé Bình",
          ),
          author: "Lan Chi",
          min_grade: 1,
          max_grade: 3,
          lifecycle_status: "ACTIVE",
          available_to_read: true,
        },
      },
    ],
    goals: [
      {
        id: makeUuid("77777777", 1),
        child_id: MOBILE_IDS.childAn,
        metric: "MINUTES",
        target_value: 20,
        period: "DAILY",
        starts_on: "2026-11-01",
        ends_on: null,
        timezone: "Asia/Ho_Chi_Minh",
        status: "ACTIVE",
        current_value: 10,
        progress_percent: 50,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        phase: "RUNNING",
        streak_cycles: 3,
        cycle_starts_on: "2026-11-26",
        cycle_ends_on: "2026-11-26",
      },
    ],
    plans: [
      {
        id: makeUuid("66666666", 1),
        child_id: MOBILE_IDS.childAn,
        book_id: null,
        book_title: null,
        title: "Kế hoạch đọc buổi tối cùng gia đình",
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
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        phase: "RUNNING",
        next_scheduled_date: "2026-11-27",
        is_scheduled_today: true,
        minutes_today: 10,
      },
    ],
    reminders: [
      {
        id: makeUuid("55555555", 99),
        child_id: MOBILE_IDS.childAn,
        remind_at: "20:00:00",
        weekdays: [0, 1, 2, 3, 4],
        timezone: "Asia/Ho_Chi_Minh",
        is_active: true,
        email_enabled: true,
        deleted_at: null,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
      },
    ],
    myBooks,
    shooterResultCalls: 0,
    supportPayloads: [],
  };

  const difficultWordsByChild: Record<
    string,
    Array<Record<string, unknown>>
  > = {
    [MOBILE_IDS.childAn]: [
      {
        normalized_word: "ngập ngừng",
        display_text: "ngập ngừng",
        difficulty_score: 4,
        omission_count: 1,
        repetition_count: 0,
        long_pause_count: 1,
        read_example_count: 0,
        session_count: 2,
        last_seen_at: TIMESTAMP,
        evidence_word_ids: [MOBILE_IDS.revisionPrimary],
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
            book_id: MOBILE_IDS.bookPrimary,
            book_title: String(
              catalogBooks[0]?.title ?? "Chào ngày mới cùng Bé An",
            ),
            book_author: "Minh Anh",
            min_grade: 1,
            max_grade: 3,
            session_id: MOBILE_IDS.sessionPrimary,
            page_id: MOBILE_IDS.pagePrimary,
            page_revision_id: MOBILE_IDS.revisionPrimary,
            page_number: 1,
            context_phrase: "Bé ngập ngừng trước cửa lớp học mới.",
            last_seen_at: TIMESTAMP,
            visibility_scope: "PUBLIC_CATALOG",
          },
        ],
      },
      {
        normalized_word: "khúc khuỷu quanh co",
        display_text: "khúc khuỷu quanh co",
        difficulty_score: 3,
        omission_count: 0,
        repetition_count: 1,
        long_pause_count: 1,
        read_example_count: 0,
        session_count: 1,
        last_seen_at: TIMESTAMP,
        evidence_word_ids: [MOBILE_IDS.revisionPrimary],
        mispronunciation_count: 1,
        encounter_count: 1,
        practice_status: "IN_PROGRESS",
        practice_attempts_count: 1,
        practice_correct_count: 0,
        practice_incorrect_count: 1,
        practice_uncertain_count: 0,
        consecutive_correct_count: 0,
        last_practiced_at: TIMESTAMP,
        last_practice_status: "INCORRECT",
        sources: [
          {
            book_id: MOBILE_IDS.bookPrimary,
            book_title: String(
              catalogBooks[0]?.title ?? "Chào ngày mới cùng Bé An",
            ),
            book_author: "Minh Anh",
            min_grade: 1,
            max_grade: 3,
            session_id: MOBILE_IDS.sessionPrimary,
            page_id: MOBILE_IDS.pagePrimary,
            page_revision_id: MOBILE_IDS.revisionPrimary,
            page_number: 2,
            context_phrase: "Con đường nhỏ khúc khuỷu quanh co qua đồi xanh.",
            last_seen_at: TIMESTAMP,
            visibility_scope: "PUBLIC_CATALOG",
          },
        ],
      },
      {
        normalized_word: "rực rỡ",
        display_text: "rực rỡ",
        difficulty_score: 2,
        omission_count: 0,
        repetition_count: 0,
        long_pause_count: 1,
        read_example_count: 0,
        session_count: 1,
        last_seen_at: TIMESTAMP,
        evidence_word_ids: [MOBILE_IDS.revisionPrimary],
        mispronunciation_count: 0,
        encounter_count: 1,
        practice_status: "COMPLETED",
        practice_attempts_count: 1,
        practice_correct_count: 1,
        practice_incorrect_count: 0,
        practice_uncertain_count: 0,
        consecutive_correct_count: 1,
        last_practiced_at: TIMESTAMP,
        last_practice_status: "CORRECT",
        sources: [
          {
            book_id: MOBILE_IDS.bookPrimary,
            book_title: String(
              catalogBooks[0]?.title ?? "Chào ngày mới cùng Bé An",
            ),
            book_author: "Minh Anh",
            min_grade: 1,
            max_grade: 3,
            session_id: MOBILE_IDS.sessionPrimary,
            page_id: MOBILE_IDS.pagePrimary,
            page_revision_id: MOBILE_IDS.revisionPrimary,
            page_number: 3,
            context_phrase: "Ánh nắng ban mai rực rỡ trên sân trường.",
            last_seen_at: TIMESTAMP,
            visibility_scope: "PUBLIC_CATALOG",
          },
        ],
      },
    ],
    [MOBILE_IDS.childBinh]: [
      {
        normalized_word: "chuyến đi",
        display_text: "chuyến đi",
        difficulty_score: 2,
        omission_count: 0,
        repetition_count: 0,
        long_pause_count: 1,
        read_example_count: 0,
        session_count: 1,
        last_seen_at: TIMESTAMP,
        evidence_word_ids: [MOBILE_IDS.revisionPrimary],
        mispronunciation_count: 1,
        encounter_count: 1,
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
            book_id: MOBILE_IDS.bookSecondary,
            book_title: "Khu vườn mùa thu của Bé Bình",
            book_author: "Lan Chi",
            min_grade: 1,
            max_grade: 3,
            session_id: MOBILE_IDS.sessionPrimary,
            page_id: MOBILE_IDS.pagePrimary,
            page_revision_id: MOBILE_IDS.revisionPrimary,
            page_number: 1,
            context_phrase: "Chuyến đi mùa thu thật nhiều niềm vui.",
            last_seen_at: TIMESTAMP,
            visibility_scope: "PUBLIC_CATALOG",
          },
        ],
      },
    ],
  };

  const practiceHistoryByChild: Record<
    string,
    Array<Record<string, unknown>>
  > = {
    [MOBILE_IDS.childAn]: [],
    [MOBILE_IDS.childBinh]: [],
  };

  const shooterBooksCount = options.shooterBooksCount ?? 2;
  const shooterBooks = Array.from({ length: shooterBooksCount }, (_, idx) => ({
    id: idx === 0 ? MOBILE_IDS.bookPrimary : makeUuid("33333333", idx + 1),
    name: `Sách ghép câu #${idx + 1}`,
    title:
      idx === 0
        ? String(catalogBooks[0]?.title ?? "Chào ngày mới cùng Bé An")
        : `Sách ghép câu vui nhộn tập ${idx + 1}`,
    author: "Minh Anh",
    min_grade: 1,
    max_grade: 3,
    available_rounds: 5,
  }));

  let activeShooterSession: {
    sessionId: string;
    book: (typeof shooterBooks)[number];
    difficulty: "easy" | "medium" | "challenge";
    totalRounds: number;
    completedRounds: number;
    currentRoundIndex: number;
    nextExpectedPos: number;
    totalStars: number;
    correctCount: number;
    mistakesTotal: number;
    hintCount: number;
    rounds: Array<{
      round_id: string;
      round_number: number;
      tokens: Array<{ id: string; text: string }>;
    }>;
  } | null = null;

  function buildShooterRounds(
    totalRounds: number,
    challenge: boolean,
  ): NonNullable<typeof activeShooterSession>["rounds"] {
    const baseWords = challenge
      ? [
          "Những",
          "tia",
          "nắng",
          "vàng",
          "rực",
          "rỡ",
          "chiếu",
          "xuống",
          "khu",
          "vườn",
          "xanh",
          "mát",
        ]
      : ["Bé", "An", "đọc", "sách"];
    return Array.from({ length: totalRounds }, (_, rIdx) => ({
      round_id: makeUuid("de000000", rIdx + 1),
      round_number: rIdx + 1,
      tokens: baseWords.map((text, tIdx) => ({
        id: makeUuid("df000000", rIdx * 20 + tIdx + 1),
        text:
          rIdx > 0 && tIdx === baseWords.length - 1
            ? `${text} (${rIdx + 1})`
            : text,
      })),
    }));
  }

  const pictureSamples = [
    {
      sample_key: "sunny-garden",
      title: "Khu vườn đầy nắng",
      theme: "Thiên nhiên",
      description: "Những bông hoa rực rỡ và chú bướm nhỏ trong vườn.",
      image_url: "http://127.0.0.1:8000/test-page.svg",
    },
    {
      sample_key: "morning-school",
      title: "Buổi sáng tới trường",
      theme: "Trường học",
      description: "Các bạn nhỏ vui vẻ đi học dưới hàng cây xanh.",
      image_url: "http://127.0.0.1:8000/test-page.svg",
    },
  ];

  const pictureSessions = new Map<string, Record<string, unknown>>();

  const corsHeaders = {
    "access-control-allow-origin": "http://127.0.0.1:3106",
    "access-control-allow-headers": "authorization,content-type,accept",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  };

  async function respond(route: Route, json: unknown, status = 200) {
    await route.fulfill({
      status,
      headers: corsHeaders,
      contentType: "application/json",
      body: status === 204 ? undefined : JSON.stringify(json),
    });
  }

  await page
    .context()
    .route("https://example.supabase.co/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            ...corsHeaders,
            "access-control-allow-credentials": "true",
          },
        });
      }
      if (url.pathname === "/auth/v1/logout") {
        return route.fulfill({
          status: 204,
          headers: {
            ...corsHeaders,
            "access-control-allow-credentials": "true",
          },
        });
      }
      if (
        url.pathname === "/auth/v1/user" &&
        (req.method() === "GET" || req.method() === "PUT")
      ) {
        return route.fulfill({
          status: 200,
          headers: {
            ...corsHeaders,
            "access-control-allow-credentials": "true",
          },
          contentType: "application/json",
          body: JSON.stringify({
            id: parentProfile.id,
            aud: "authenticated",
            role: "authenticated",
            email: parentProfile.email,
            app_metadata: { provider: "email", providers: ["email"] },
            user_metadata: { display_name: parentProfile.display_name },
            created_at: TIMESTAMP,
            updated_at: TIMESTAMP,
          }),
        });
      }
      if (url.pathname === "/auth/v1/recover") {
        return route.fulfill({
          status: 200,
          headers: {
            ...corsHeaders,
            "access-control-allow-credentials": "true",
          },
          contentType: "application/json",
          body: JSON.stringify({}),
        });
      }
      return route.fallback();
    });

  await page.context().route("https://media.example.test/**", async (route) => {
    const bytes = syntheticWavBuffer(10);
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers().range ?? "",
    );
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(bytes.length - 1, Number(range[2]))
      : bytes.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: "audio/wav",
      body: bytes.subarray(start, end + 1),
      headers: {
        "access-control-allow-origin": "*",
        "accept-ranges": "bytes",
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${bytes.length}` }
          : {}),
      },
    });
  });

  await page.context().route("http://127.0.0.1:8000/**", async (route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    const url = new URL(req.url());
    const path = url.pathname;
    state.requests.push(`${method} ${path}${url.search}`);

    if (path === "/health") {
      return respond(route, {
        status: "ok",
        ocr_mode: "remote_worker",
        ocr: {
          mode: "remote_worker",
          ready: state.ocrWorkerOnline,
          workers: [{ id: "win-1", online: state.ocrWorkerOnline }],
          queue: { queued: 0 },
        },
      });
    }

    if (path === "/voice/status" && method === "GET") {
      return respond(route, readyVoiceStatus("Binh"));
    }

    if (path === "/voice/text-to-speech" && method === "POST") {
      return route.fulfill({
        status: 200,
        headers: corsHeaders,
        contentType: "audio/wav",
        body: syntheticWavBuffer(1),
      });
    }

    if (path === "/profiles/dashboard-summary" && method === "GET") {
      const latestByChild: Record<string, unknown> = {};
      if (options.resumableSession && state.children[0]) {
        latestByChild[state.children[0].id] = {
          id: MOBILE_IDS.sessionResumable,
          child_id: state.children[0].id,
          book_id: MOBILE_IDS.bookPrimary,
          book_title: String(
            catalogBooks[0]?.title ?? "Chào ngày mới cùng Bé An",
          ),
          state: "PAUSED",
          resumable: true,
          started_at: TIMESTAMP,
          ended_at: null,
        };
      }
      return respond(route, {
        profile: { ...parentProfile, children: state.children },
        children: state.children,
        latest_sessions_by_child: latestByChild,
      });
    }

    if (path === "/profiles/me") {
      if (method === "GET") {
        return respond(route, { ...parentProfile, children: state.children });
      }
      if (method === "PATCH") {
        const body = req.postDataJSON() as Record<string, unknown>;
        if (typeof body.display_name === "string" && body.display_name.trim()) {
          parentProfile.display_name = body.display_name.trim();
        }
        if (body.contact_phone !== undefined) {
          parentProfile.contact_phone =
            typeof body.contact_phone === "string" ? body.contact_phone : null;
        }
        return respond(route, { ...parentProfile, children: state.children });
      }
    }

    if (path === "/profiles/children") {
      if (method === "GET") {
        return respond(route, state.children);
      }
      if (method === "POST") {
        const body = req.postDataJSON() as { alias: string; grade: number };
        const created = makeChild(
          makeUuid("22222222", state.children.length + 10),
          body.alias.trim(),
          Number(body.grade),
        );
        state.children.push(created);
        return respond(route, created, 201);
      }
    }

    const childMatch = /^\/profiles\/children\/([^/]+)$/.exec(path);
    if (childMatch) {
      const targetId = decodeURIComponent(childMatch[1]);
      const idx = state.children.findIndex((c) => c.id === targetId);
      if (idx === -1) return respond(route, { detail: "Child not found" }, 404);
      if (method === "GET") return respond(route, state.children[idx]);
      if (method === "PATCH") {
        const body = req.postDataJSON() as { alias?: string; grade?: number };
        state.children[idx] = {
          ...state.children[idx],
          ...(typeof body.alias === "string"
            ? { alias: body.alias.trim() }
            : {}),
          ...(typeof body.grade === "number" ? { grade: body.grade } : {}),
        };
        return respond(route, state.children[idx]);
      }
      if (method === "DELETE") {
        state.children.splice(idx, 1);
        return respond(route, { deleted: true });
      }
    }

    // Books Catalog
    if (path === "/books/catalog" && method === "GET") {
      if (state.catalogStatus !== 200) {
        return respond(
          route,
          { detail: "private sql token" },
          state.catalogStatus,
        );
      }
      const search =
        url.searchParams.get("search")?.toLocaleLowerCase("vi") ?? "";
      const gradeParam = url.searchParams.get("grade");
      const grade = gradeParam ? Number(gradeParam) : null;
      const filtered = catalogBooks.filter((b) => {
        const titleMatch =
          !search ||
          `${b.title} ${b.author ?? ""}`
            .toLocaleLowerCase("vi")
            .includes(search);
        const gradeMatch =
          grade === null ||
          (Number(b.min_grade) <= grade && Number(b.max_grade) >= grade);
        return titleMatch && gradeMatch;
      });
      return respond(route, filtered);
    }

    const catalogDetailMatch = /^\/books\/catalog\/([^/]+)$/.exec(path);
    if (catalogDetailMatch && method === "GET") {
      const targetId = decodeURIComponent(catalogDetailMatch[1]);
      const found =
        catalogBooks.find((b) => b.id === targetId) ??
        state.myBooks.find((b) => b.id === targetId);
      if (!found) return respond(route, { detail: "Not found" }, 404);
      return respond(route, found);
    }

    const catalogPreviewMatch = /^\/books\/catalog\/([^/]+)\/preview$/.exec(
      path,
    );
    if (catalogPreviewMatch && method === "GET") {
      if (state.previewStatus !== 200) {
        return respond(
          route,
          { detail: "private sql token" },
          state.previewStatus,
        );
      }
      return respond(route, previewPages);
    }

    const createReportMatch = /^\/books\/catalog\/([^/]+)\/reports$/.exec(path);
    if (createReportMatch && method === "POST") {
      const targetBookId = decodeURIComponent(createReportMatch[1]);
      const found = catalogBooks.find((b) => b.id === targetBookId);
      const body = req.postDataJSON() as Record<string, unknown>;
      const newReport = {
        id: makeUuid("bb000000", state.reports.length + 1),
        book_id: targetBookId,
        book_title: String(found?.title ?? "Sách ViRead"),
        reporter_id: parentProfile.id,
        reporter_name: parentProfile.display_name,
        page_id: (body.page_id as string | undefined) ?? null,
        page_number: body.page_id ? 1 : null,
        page_revision_id: body.page_id ? MOBILE_IDS.revisionPrimary : null,
        issue_type: body.issue_type ?? "SPELLING_ERROR",
        description: String(body.description ?? ""),
        reported_text: (body.reported_text as string | undefined) ?? null,
        suggested_correction:
          (body.suggested_correction as string | undefined) ?? null,
        status: "OPEN",
        scan_run_id: makeUuid("bc000000", state.reports.length + 1),
        verified_text_snapshot: null,
        content_hash_snapshot: null,
        admin_resolution_note: null,
        reviewed_by: null,
        reviewed_by_name: null,
        resolved_at: null,
        history: [
          {
            actor_name: parentProfile.display_name,
            from_status: null,
            to_status: "OPEN",
            note: "Báo cáo mới từ phụ huynh",
            created_at: TIMESTAMP,
          },
        ],
        related_findings: [],
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
      };
      state.reports.unshift(newReport);
      return respond(route, newReport, 201);
    }

    if (path === "/books/reports/mine" && method === "GET") {
      if (state.reportsStatus !== 200) {
        return respond(
          route,
          { detail: "private sql token" },
          state.reportsStatus,
        );
      }
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      return respond(route, {
        items: state.reports.slice(offset, offset + limit),
        total: state.reports.length,
        limit,
        offset,
      });
    }

    const myReportDetailMatch = /^\/books\/reports\/mine\/([^/]+)$/.exec(path);
    if (myReportDetailMatch && method === "GET") {
      if (state.reportDetailStatus !== 200) {
        return respond(route, { detail: "Error" }, state.reportDetailStatus);
      }
      const reportId = decodeURIComponent(myReportDetailMatch[1]);
      const found = state.reports.find((r) => r.id === reportId);
      if (!found) return respond(route, { detail: "Not found" }, 404);
      return respond(route, {
        ...found,
        reporter_id: parentProfile.id,
        reporter_name: parentProfile.display_name,
        verified_text_snapshot: null,
        content_hash_snapshot: null,
        admin_resolution_note:
          "Admin đã ghi nhận góp ý của ba mẹ và đang rà soát lại trang sách.",
        reviewed_by: null,
        reviewed_by_name: "Admin ViRead",
        resolved_at: null,
        history: (found.history as unknown[] | undefined) ?? [
          {
            actor_name: "Admin ViRead",
            from_status: "OPEN",
            to_status: "UNDER_REVIEW",
            note: "Đã tiếp nhận kiểm tra",
            created_at: TIMESTAMP,
          },
        ],
        related_findings: [],
      });
    }

    // My Books (Private Books)
    if (path === "/books/my-books/paged" && method === "GET") {
      if (state.myBooksStatus !== 200) {
        return respond(
          route,
          { detail: "private sql token" },
          state.myBooksStatus,
        );
      }
      const limit = Number(url.searchParams.get("limit") ?? "9");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      return respond(route, {
        items: state.myBooks.slice(offset, offset + limit),
        total: state.myBooks.length,
        limit,
        offset,
      });
    }

    if (path === "/books/my-books") {
      if (method === "GET") {
        if (state.myBooksStatus !== 200) {
          return respond(route, { detail: "Error" }, state.myBooksStatus);
        }
        return respond(route, state.myBooks);
      }
      if (method === "POST") {
        const body = req.postDataJSON() as Record<string, unknown>;
        const newBook: Record<string, unknown> = {
          ...makePrivateBook(state.myBooks.length + 1),
          title: String(body.title ?? "Sách mới"),
          author: (body.author as string | null) ?? null,
          min_grade: Number(body.min_grade ?? 1),
          max_grade: Number(body.max_grade ?? 3),
          committed_page_count: 0,
          readable_for_children: false,
        };
        state.myBooks.unshift(newBook);
        myBookDetails.set(String(newBook.id), { pages: [], submissions: [] });
        return respond(route, newBook, 201);
      }
    }

    const myBookSubUploadMatch =
      /^\/books\/my-books\/([^/]+)\/submissions$/.exec(path);
    if (myBookSubUploadMatch && method === "POST") {
      const targetBookId = decodeURIComponent(myBookSubUploadMatch[1]);
      const subId = makeUuid("ac000000", 1);
      const batchId = makeUuid("ad000000", 1);
      const submission = {
        id: subId,
        book_id: targetBookId,
        batch_id: batchId,
        batch_total_pages: 1,
        source_page_number: 1,
        target_page_number: 1,
        source_file_name: "page-1.png",
        source_format: "PNG",
        image_width: 800,
        image_height: 1000,
        image_url: "http://127.0.0.1:8000/test-page.svg",
        source_type: "OWNED_PHYSICAL_BOOK",
        source_type_label: "Sách giấy gia đình đã mua để con luyện đọc tại nhà",
        source_note: null,
        submission_version: 1,
        optimistic_lock_version: 1,
        workflow_status: "PASSED_READY_TO_ADD",
        workflow_status_label: "Đạt kiểm tra · Sẵn sàng thêm vào sách",
        ocr_status: "COMPLETED",
        ocr_text: "Chú mèo con nằm sưởi nắng bên cửa sổ.",
        ocr_error_code: null,
        is_image_only: false,
        proofread_status: "COMPLETED",
        proofread_text: "Chú mèo con nằm sưởi nắng bên cửa sổ.",
        proofread_suggestions: [],
        uncertain_word_indices: [],
        proofread_error_code: null,
        spelling_accepted: true,
        candidate_text: "Chú mèo con nằm sưởi nắng bên cửa sổ.",
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
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
      };
      const entry = myBookDetails.get(targetBookId) ?? {
        pages: [],
        submissions: [],
      };
      entry.submissions.unshift(submission);
      myBookDetails.set(targetBookId, entry);
      return respond(route, {
        book_id: targetBookId,
        batch_id: batchId,
        source_format: "PNG",
        total_pages: 1,
        replayed_idempotency: false,
        submissions: [submission],
      });
    }

    const myBookAddPageMatch =
      /^\/books\/my-books\/([^/]+)\/submissions\/([^/]+)\/add-page$/.exec(path);
    if (myBookAddPageMatch && method === "POST") {
      const targetBookId = decodeURIComponent(myBookAddPageMatch[1]);
      const targetSubId = decodeURIComponent(myBookAddPageMatch[2]);
      const entry = myBookDetails.get(targetBookId);
      const bookItem = state.myBooks.find((b) => b.id === targetBookId);
      const pageId = makeUuid("ab000000", (entry?.pages.length ?? 0) + 2);
      const revId = makeUuid("ae000000", (entry?.pages.length ?? 0) + 2);
      const pageNumber = (entry?.pages.length ?? 0) + 1;
      if (entry) {
        entry.pages.push({
          page_id: pageId,
          page_number: pageNumber,
          current_verified_revision_id: revId,
          verified_text: "Chú mèo con nằm sưởi nắng bên cửa sổ.",
          verified_text_preview: "Chú mèo con nằm sưởi nắng bên cửa sổ.",
          image_url: "http://127.0.0.1:8000/test-page.svg",
          created_at: TIMESTAMP,
        });
      }
      if (bookItem) {
        bookItem.committed_page_count = entry?.pages.length ?? 1;
        bookItem.readable_for_children = true;
      }
      const subObj = (entry?.submissions[0] as
        Record<string, unknown> | undefined) ?? {
        id: targetSubId,
        book_id: targetBookId,
      };
      const updatedSub = {
        ...subObj,
        workflow_status: "ADDED_TO_BOOK",
        workflow_status_label: "Đã thêm vào sách đọc",
        can_add_to_book: false,
        committed_page_id: pageId,
        committed_revision_id: revId,
      };
      if (entry && entry.submissions.length > 0) {
        entry.submissions[0] = updatedSub;
      }
      return respond(route, {
        book_id: targetBookId,
        page_id: pageId,
        page_number: pageNumber,
        revision_id: revId,
        submission: updatedSub,
        book_readable_for_children: true,
      });
    }

    const myBookDetailMatch = /^\/books\/my-books\/([^/]+)$/.exec(path);
    if (myBookDetailMatch) {
      const targetBookId = decodeURIComponent(myBookDetailMatch[1]);
      const idx = state.myBooks.findIndex((b) => b.id === targetBookId);
      if (idx === -1) return respond(route, { detail: "Not found" }, 404);
      if (method === "GET") {
        const entry = myBookDetails.get(targetBookId) ?? {
          pages: [],
          submissions: [],
        };
        return respond(route, {
          book: state.myBooks[idx],
          pages: entry.pages,
          submissions: entry.submissions,
        });
      }
      if (method === "PATCH") {
        const body = req.postDataJSON() as Record<string, unknown>;
        state.myBooks[idx] = {
          ...state.myBooks[idx],
          ...(typeof body.title === "string"
            ? { title: body.title.trim() }
            : {}),
          ...(body.author !== undefined ? { author: body.author } : {}),
          ...(typeof body.min_grade === "number"
            ? { min_grade: body.min_grade }
            : {}),
          ...(typeof body.max_grade === "number"
            ? { max_grade: body.max_grade }
            : {}),
        };
        return respond(route, state.myBooks[idx]);
      }
      if (method === "DELETE") {
        state.myBooks.splice(idx, 1);
        return respond(route, {
          status: "deleted",
          book_id: targetBookId,
          retired_pages_count: 0,
          cancelled_submissions_count: 0,
        });
      }
    }

    // Book Scanner / Local OCR
    const matchedScanResult = {
      scan_job_id: makeUuid("af000000", 1),
      request_id: makeUuid("af000000", 2),
      idempotency_key: null,
      status: "SUCCEEDED",
      ocr_text: "Buổi sáng trên khu vườn đầy nắng và tiếng chim hót.",
      word_count: 11,
      words: [
        {
          word_index: 0,
          line_index: 0,
          text: "Buổi",
          normalized_text: "buoi",
          bbox: [0.1, 0.2, 0.1, 0.05],
          ocr_confidence: 0.95,
        },
      ],
      provenance: {
        engine: "VietOCR-V2",
        device: "cpu",
        engine_statuses: { vietocr: "ok" },
        model_profile: "v2",
        checkpoint_sha256: null,
        model_load_status: "ready",
        cloud_ocr_used: false,
        elapsed_ms: 210,
      },
      matched: true,
      matched_book_id: MOBILE_IDS.bookPrimary,
      matched_book_title: String(
        catalogBooks[0]?.title ?? "Chào ngày mới cùng Bé An",
      ),
      match_confidence: 0.94,
      matched_page: {
        page_id: MOBILE_IDS.pagePrimary,
        page_revision_id: MOBILE_IDS.revisionPrimary,
        page_number: 1,
        confidence: 0.94,
        width: 800,
        height: 1000,
        image_url: "http://127.0.0.1:8000/test-page.svg",
        text: "Buổi sáng trên khu vườn đầy nắng.",
        words: [
          {
            word_id: makeUuid("b1000000", 1),
            word_index: 0,
            text: "Buổi",
            bbox: [0.1, 0.2, 0.1, 0.05],
          },
        ],
      },
      message: "Đã khớp đúng trang sách trong thư viện.",
    };

    if (path === "/reading/scan-page-ocr/jobs" && method === "POST") {
      if (state.ocrScanStatus !== 200) {
        return respond(
          route,
          { detail: "private sql token" },
          state.ocrScanStatus,
        );
      }
      return respond(route, {
        job_id: makeUuid("af000000", 10),
        status: "SUCCEEDED",
        worker_online: state.ocrWorkerOnline,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        error_code: null,
        error_message: null,
        result: matchedScanResult,
      });
    }

    if (path.startsWith("/reading/scan-page-ocr/jobs/") && method === "GET") {
      return respond(route, {
        job_id: makeUuid("af000000", 10),
        status: "SUCCEEDED",
        worker_online: state.ocrWorkerOnline,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        error_code: null,
        error_message: null,
        result: matchedScanResult,
      });
    }

    if (path === "/reading/scan-page-ocr" && method === "POST") {
      if (state.ocrScanStatus !== 200) {
        return respond(
          route,
          { detail: "private sql token" },
          state.ocrScanStatus,
        );
      }
      return respond(route, matchedScanResult);
    }

    // Reading Management (Goals, Plans, Collections, Reminders)
    if (path === "/reading-management/collections" && method === "GET") {
      const childFilter = url.searchParams.get("child_id");
      const list = childFilter
        ? state.collections.filter((c) => c.child_id === childFilter)
        : state.collections;
      return respond(route, list);
    }

    const collectionBookMatch =
      /^\/reading-management\/collections\/([^/]+)$/.exec(path);
    if (collectionBookMatch) {
      const targetBookId = decodeURIComponent(collectionBookMatch[1]);
      if (method === "PUT") {
        const body = req.postDataJSON() as {
          child_id: string;
          collection_type: "FAVORITE" | "WANT_TO_READ";
        };
        const foundBook =
          catalogBooks.find((b) => b.id === targetBookId) ?? catalogBooks[0];
        const entry = {
          id: makeUuid("88888888", state.collections.length + 10),
          child_id: body.child_id,
          book_id: targetBookId,
          collection_type: body.collection_type,
          created_at: TIMESTAMP,
          book: {
            id: targetBookId,
            title: String(foundBook?.title ?? "Sách đã lưu"),
            author: (foundBook?.author as string | null) ?? null,
            min_grade: Number(foundBook?.min_grade ?? 1),
            max_grade: Number(foundBook?.max_grade ?? 3),
            lifecycle_status: "ACTIVE",
            available_to_read: true,
          },
        };
        state.collections.push(entry);
        return respond(route, entry);
      }
      if (method === "DELETE") {
        const childFilter = url.searchParams.get("child_id");
        const typeFilter = url.searchParams.get("collection_type");
        state.collections = state.collections.filter(
          (c) =>
            !(
              c.book_id === targetBookId &&
              (!childFilter || c.child_id === childFilter) &&
              (!typeFilter || c.collection_type === typeFilter)
            ),
        );
        return respond(route, { deleted: true });
      }
    }

    if (path === "/reading-management/goals") {
      if (method === "GET") {
        const childFilter = url.searchParams.get("child_id");
        return respond(
          route,
          childFilter
            ? state.goals.filter((g) => g.child_id === childFilter)
            : state.goals,
        );
      }
      if (method === "POST") {
        const body = req.postDataJSON() as Record<string, unknown>;
        const created = {
          id: makeUuid("77777777", state.goals.length + 10),
          child_id: String(body.child_id ?? MOBILE_IDS.childAn),
          metric: body.metric ?? "MINUTES",
          target_value: Number(body.target_value ?? 20),
          period: body.period ?? "DAILY",
          starts_on: String(body.starts_on ?? "2026-11-26"),
          ends_on: (body.ends_on as string | null) ?? null,
          timezone: String(body.timezone ?? "Asia/Ho_Chi_Minh"),
          status: "ACTIVE",
          current_value: 0,
          progress_percent: 0,
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP,
          phase: "RUNNING",
          streak_cycles: 0,
          cycle_starts_on: "2026-11-26",
          cycle_ends_on: "2026-11-26",
        };
        state.goals.unshift(created);
        return respond(route, created, 201);
      }
    }

    if (path === "/reading-management/plans") {
      if (method === "GET") {
        const childFilter = url.searchParams.get("child_id");
        return respond(
          route,
          childFilter
            ? state.plans.filter((p) => p.child_id === childFilter)
            : state.plans,
        );
      }
      if (method === "POST") {
        const body = req.postDataJSON() as Record<string, unknown>;
        const created = {
          id: makeUuid("66666666", state.plans.length + 10),
          child_id: String(body.child_id ?? MOBILE_IDS.childAn),
          book_id: (body.book_id as string | null) ?? null,
          book_title: null,
          title: String(body.title ?? "Kế hoạch mới"),
          target_minutes: Number(body.target_minutes ?? 15),
          weekdays: (body.weekdays as number[] | undefined) ?? [0, 2, 4],
          starts_on: String(body.starts_on ?? "2026-11-26"),
          ends_on: (body.ends_on as string | null) ?? null,
          timezone: String(body.timezone ?? "Asia/Ho_Chi_Minh"),
          status: "ACTIVE",
          scheduled_days_this_week: 3,
          completed_days_this_week: 0,
          progress_percent: 0,
          completed_at: null,
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP,
          phase: "RUNNING",
          next_scheduled_date: "2026-11-27",
          is_scheduled_today: true,
          minutes_today: 0,
        };
        state.plans.unshift(created);
        return respond(route, created, 201);
      }
    }

    if (path === "/reading-management/reminders") {
      if (method === "GET") {
        const childFilter = url.searchParams.get("child_id");
        return respond(
          route,
          childFilter
            ? state.reminders.filter((r) => r.child_id === childFilter)
            : state.reminders,
        );
      }
    }
    if (path === "/reading-management/reminders/due" && method === "GET") {
      return respond(route, []);
    }

    // Reports & Progress
    const progressPeriodsMatch = /^\/system\/progress\/([^/]+)\/periods$/.exec(
      path,
    );
    if (progressPeriodsMatch && method === "GET") {
      const targetChildId = decodeURIComponent(progressPeriodsMatch[1]);
      if (state.reportsStatus !== 200) {
        return respond(route, { detail: "Error" }, state.reportsStatus);
      }
      const cursor = url.searchParams.get("cursor");
      if (cursor === "page-2") {
        return respond(route, {
          items: [
            {
              id: makeUuid("44444444", 20),
              child_id: targetChildId,
              period_start: "2026-08-01",
              period_end: "2026-08-31",
              generated_at: TIMESTAMP,
            },
          ],
          next_cursor: null,
        });
      }
      return respond(route, {
        items: [
          {
            id: MOBILE_IDS.sessionPrimary,
            child_id: targetChildId,
            period_start: "2026-10-27",
            period_end: "2026-11-26",
            generated_at: TIMESTAMP,
          },
        ],
        next_cursor: options.hasMorePeriods ? "page-2" : null,
      });
    }

    const progressReportMatch = /^\/system\/progress\/([^/]+)$/.exec(path);
    if (progressReportMatch && method === "GET") {
      const targetChildId = decodeURIComponent(progressReportMatch[1]);
      if (state.reportsStatus !== 200) {
        return respond(route, { detail: "Error" }, state.reportsStatus);
      }
      const periodStart = url.searchParams.get("period_start") ?? "2026-10-27";
      const periodEnd = url.searchParams.get("period_end") ?? "2026-11-26";
      const words = difficultWordsByChild[targetChildId] ?? [];
      return respond(route, {
        id: MOBILE_IDS.sessionPrimary,
        generated_at: TIMESTAMP,
        legacy: null,
        data_status: "complete",
        availability: {
          metrics: "available",
          difficult_words: "available",
          comparison: "available",
        },
        child_id: targetChildId,
        period_start: periodStart,
        period_end: periodEnd,
        completed_sessions: targetChildId === MOBILE_IDS.childBinh ? 5 : 8,
        reading_duration_ms: 900_000,
        omission_count: 2,
        repetition_count: 1,
        long_pause_count: 1,
        omission_rate: 4.5,
        repetition_rate: 2.0,
        long_pause_rate: 1.5,
        comprehension_accuracy: 85,
        difficult_words: words,
        previous_period: {
          completed_sessions: 4,
          reading_duration_ms: 600_000,
          omission_count: 3,
          repetition_count: 2,
          long_pause_count: 2,
          omission_rate: 6.0,
          repetition_rate: 3.0,
          long_pause_rate: 2.5,
          comprehension_accuracy: 75,
        },
        trend_deltas: {
          completed_sessions: 4,
          reading_duration_ms: 300_000,
          omission_rate: -1.5,
          repetition_rate: -1.0,
          long_pause_rate: -1.0,
          comprehension_accuracy: 10,
        },
      });
    }

    const assessmentMatch =
      /^\/tutor\/children\/([^/]+)\/progress-assessment$/.exec(path);
    if (assessmentMatch && method === "GET") {
      const targetChildId = decodeURIComponent(assessmentMatch[1]);
      return respond(route, {
        child_id: targetChildId,
        period_start: "2026-10-27",
        period_end: "2026-11-26",
        days: 30,
        generated_at: TIMESTAMP,
        data_status: "OK",
        score: {
          overall: 82,
          previous_overall: 74,
          delta: 8,
          grade: "GOOD",
          grade_label: "Tiến bộ tốt",
          components: [
            {
              key: "ACCURACY",
              label: "Độ chính xác",
              score: 85,
              previous_score: 78,
              detail: "Đọc rõ tiếng và ít bỏ từ.",
            },
          ],
        },
        metrics: {
          sessions: 8,
          active_days: 5,
          reading_minutes: 45,
          books: 2,
          pages_compared: 12,
          words_read: 420,
          coverage_pct: 92,
          accuracy_pct: 88,
          skipped_rate_pct: 4.5,
          substitution_rate_pct: 2.1,
          hesitations: 3,
          repeated_words: 2,
          hesitations_per_100_words: 0.7,
          words_per_minute: 72,
          comprehension_answered: 6,
          comprehension_first_try_pct: 85,
          comprehension_by_type: [],
          retry_confirmed: 2,
          retry_failed: 0,
        },
        weekly: [
          {
            week_start: "2026-11-02",
            sessions: 2,
            minutes: 12,
            accuracy_pct: 82,
          },
          {
            week_start: "2026-11-09",
            sessions: 3,
            minutes: 18,
            accuracy_pct: 88,
          },
        ],
        difficult_words: [{ word: "ngập ngừng", times: 2, heard_as: null }],
        assessment: {
          source: "RULE_BASED",
          model: null,
          headline: "Bé giữ nhịp đọc đều và chính xác hơn",
          summary: "Số từ đọc trôi chảy tăng đều qua từng tuần.",
          strengths: ["Giữ nhịp đọc ổn định"],
          weaknesses: [
            { area: "Từ ghép dài", detail: "Cần luyện thêm từ láy" },
          ],
          actions: [
            {
              title: "Ôn mục Từ cần luyện",
              detail: "Luyện 3–5 phút mỗi ngày.",
              audience: "PARENT",
            },
          ],
          practice_words: ["ngập ngừng"],
          encouragement: "Bé làm rất tốt!",
        },
        ai_cached: true,
      });
    }

    // Difficult words & practice
    const dwHistoryMatch =
      /^\/system\/difficult-words\/([^/]+)\/practice\/history$/.exec(path);
    if (dwHistoryMatch && method === "GET") {
      const targetChildId = decodeURIComponent(dwHistoryMatch[1]);
      return respond(route, {
        storage_ready: true,
        items: practiceHistoryByChild[targetChildId] ?? [],
      });
    }

    const dwStartMatch =
      /^\/system\/difficult-words\/([^/]+)\/practice\/start$/.exec(path);
    if (dwStartMatch && method === "POST") {
      const targetChildId = decodeURIComponent(dwStartMatch[1]);
      const body = req.postDataJSON() as {
        normalized_word: string;
        display_text?: string;
      };
      const attempt = {
        attempt_id: makeUuid("99999999", 1),
        child_id: targetChildId,
        normalized_word: body.normalized_word,
        display_text: body.display_text ?? body.normalized_word,
        attempt_number: 1,
        state: "STARTED",
        assessment_status: null,
        recognition_source: null,
        spoken_transcript: null,
        confidence: null,
        audio_duration_ms: null,
        assessment_version: 1,
        evidence_word_ids: [MOBILE_IDS.revisionPrimary],
        started_at: TIMESTAMP,
        completed_at: null,
        feedback_message: null,
        word_progress: {
          normalized_word: body.normalized_word,
          practice_status: "IN_PROGRESS",
          practice_attempts_count: 0,
          practice_correct_count: 0,
          practice_incorrect_count: 0,
          practice_uncertain_count: 0,
          consecutive_correct_count: 0,
          required_consecutive_correct: 1,
          last_practiced_at: null,
          last_practice_status: null,
        },
        next_recommended_word: null,
        evidence_count_unchanged: true,
      };
      return respond(route, attempt);
    }

    const dwListMatch = /^\/system\/difficult-words\/([^/]+)$/.exec(path);
    if (dwListMatch && method === "GET") {
      const targetChildId = decodeURIComponent(dwListMatch[1]);
      if (state.difficultWordsStatus !== 200) {
        return respond(route, { detail: "Error" }, state.difficultWordsStatus);
      }
      return respond(route, difficultWordsByChild[targetChildId] ?? []);
    }

    // Sessions history
    if (path === "/reading/history" && method === "GET") {
      const targetChildId =
        url.searchParams.get("child_id") ?? MOBILE_IDS.childAn;
      const count = options.historySessionsCount ?? 2;
      const sessions = Array.from({ length: count }, (_, idx) => ({
        id:
          idx === 0
            ? MOBILE_IDS.sessionPrimary
            : makeUuid("44444444", idx + 20),
        child_id: targetChildId,
        book_id: MOBILE_IDS.bookPrimary,
        state: "FINISHED",
        started_at: TIMESTAMP,
        ended_at: TIMESTAMP,
        duration_ms: 180_000,
      }));
      return respond(route, {
        sessions,
        next_cursor: options.hasNextHistoryCursor ? "page-2" : null,
      });
    }

    const historyBookMatch = /^\/reading\/history\/([^/]+)\/book$/.exec(path);
    if (historyBookMatch && method === "GET") {
      return respond(route, catalogBooks[0] ?? baseBook);
    }

    const historyDetailMatch = /^\/reading\/history\/([^/]+)$/.exec(path);
    if (historyDetailMatch && method === "GET") {
      const sessionId = decodeURIComponent(historyDetailMatch[1]);
      const targetChildId = state.children[0]?.id ?? MOBILE_IDS.childAn;
      return respond(route, {
        id: sessionId,
        child_id: targetChildId,
        book_id: MOBILE_IDS.bookPrimary,
        state: "FINISHED",
        started_at: TIMESTAMP,
        ended_at: TIMESTAMP,
        duration_ms: 180_000,
        selected_range_pages: 2,
        pages_completed: 2,
        selected_page_revision_ids: [MOBILE_IDS.revisionPrimary],
        reference_page_revision_ids: [MOBILE_IDS.revisionPrimary],
        events: [
          {
            id: makeUuid("e1000000", 1),
            session_id: sessionId,
            page_id: MOBILE_IDS.pagePrimary,
            page_revision_id: MOBILE_IDS.revisionPrimary,
            page_revision_word_id: makeUuid("e2000000", 1),
            type: "OMISSION",
            status: "CONFIRMED",
            start_ms: 1200,
            end_ms: 1800,
            confidence: 0.9,
            metadata: { target_word: "ngập ngừng" },
          },
        ],
        fluency_assessment: {
          metrics: {
            active_reading_ms: 150_000,
            reference_words_attempted: 120,
            confirmed_error_words: 4,
            accuracy_percent: 96.7,
            reading_wpm: 72,
            repetition_rate: 1.5,
            long_pause_rate: 1.0,
            mean_pause_ms: 420,
            median_pause_ms: 350,
          },
          score: 92,
          uncertainty: 0.05,
          model_version: "v1",
        },
        comprehension: [
          {
            question: {
              id: makeUuid("e3000000", 1),
              type: "FACTUAL",
              prompt: "Nhân vật trong truyện làm gì vào buổi sáng?",
              page_revision_id: MOBILE_IDS.revisionPrimary,
              source_span: null,
              difficulty: "EASY",
              answered: true,
            },
            answer: {
              answer_id: makeUuid("e4000000", 1),
              question_id: makeUuid("e3000000", 1),
              submitted_answer: "Đọc sách cùng ba mẹ",
              is_correct: true,
              score: 100,
              feedback_code: "CORRECT",
            },
          },
        ],
        report_id: makeUuid("e5000000", 1),
        availability: {
          events: "available",
          fluency: "available",
          comprehension: "available",
        },
      });
    }

    const sessionReportsMatch = /^\/reading\/sessions\/([^/]+)\/reports$/.exec(
      path,
    );
    if (sessionReportsMatch && method === "GET") {
      return respond(route, {
        session_id: decodeURIComponent(sessionReportsMatch[1]),
        total: 0,
        reports: [],
      });
    }

    // Sentence Shooter
    if (path === "/games/sentence-shooter/books" && method === "GET") {
      if (state.shooterStatus !== 200) {
        return respond(
          route,
          { detail: "private sql token" },
          state.shooterStatus,
        );
      }
      return respond(route, shooterBooks);
    }

    if (path === "/games/sentence-shooter/sessions" && method === "POST") {
      if (state.shooterStatus !== 200) {
        return respond(
          route,
          { detail: "private sql token" },
          state.shooterStatus,
        );
      }
      const body = req.postDataJSON() as {
        book_id: string;
        difficulty: "easy" | "medium" | "challenge";
        total_rounds: number;
      };
      const bookMatch =
        shooterBooks.find((b) => b.id === body.book_id) ?? shooterBooks[0];
      const rounds = buildShooterRounds(
        body.total_rounds,
        Boolean(
          options.shooterChallengeTokens || body.difficulty === "challenge",
        ),
      );
      activeShooterSession = {
        sessionId: MOBILE_IDS.shooterSession1,
        book: bookMatch,
        difficulty: body.difficulty,
        totalRounds: body.total_rounds,
        completedRounds: 0,
        currentRoundIndex: 0,
        nextExpectedPos: 0,
        totalStars: 0,
        correctCount: 0,
        mistakesTotal: 0,
        hintCount: 0,
        rounds,
      };
      const r0 = rounds[0];
      return respond(route, {
        session_id: activeShooterSession.sessionId,
        book: activeShooterSession.book,
        difficulty: activeShooterSession.difficulty,
        total_rounds: activeShooterSession.totalRounds,
        completed_rounds: 0,
        total_stars: 0,
        round: {
          round_id: r0.round_id,
          round_number: r0.round_number,
          token_count: r0.tokens.length,
          tokens: r0.tokens,
        },
      });
    }

    const shooterShotMatch =
      /^\/games\/sentence-shooter\/sessions\/([^/]+)\/shots$/.exec(path);
    if (shooterShotMatch && method === "POST") {
      if (state.shooterShotStatus !== 200) {
        return respond(
          route,
          { detail: "private sql token" },
          state.shooterShotStatus,
        );
      }
      if (!activeShooterSession) {
        return respond(route, { detail: "Session not found" }, 404);
      }
      const body = req.postDataJSON() as { round_id: string; token_id: string };
      const currentRound =
        activeShooterSession.rounds[activeShooterSession.currentRoundIndex];
      const expectedToken =
        currentRound.tokens[activeShooterSession.nextExpectedPos];
      const isCorrect = expectedToken?.id === body.token_id;
      if (isCorrect) {
        activeShooterSession.nextExpectedPos += 1;
        activeShooterSession.correctCount += 1;
      } else {
        activeShooterSession.mistakesTotal += 1;
      }
      const roundCompleted =
        activeShooterSession.nextExpectedPos >= currentRound.tokens.length;
      if (roundCompleted) {
        activeShooterSession.completedRounds += 1;
        activeShooterSession.totalStars += 3;
      }
      const sessionCompleted =
        roundCompleted &&
        activeShooterSession.completedRounds >=
          activeShooterSession.totalRounds;
      return respond(route, {
        is_correct: isCorrect,
        correct_count: activeShooterSession.nextExpectedPos,
        token_count: currentRound.tokens.length,
        mistakes_total: activeShooterSession.mistakesTotal,
        completed_rounds: activeShooterSession.completedRounds,
        total_stars: activeShooterSession.totalStars,
        round_completed: roundCompleted,
        session_completed: sessionCompleted,
        next_expected_position: activeShooterSession.nextExpectedPos,
        stars_awarded: roundCompleted ? 3 : 0,
        completed_sentence: roundCompleted
          ? currentRound.tokens.map((t) => t.text).join(" ")
          : null,
        next_round: null,
        message: isCorrect ? "Chính xác!" : "Bé thử lại từ khác nhé!",
      });
    }

    const shooterHintMatch =
      /^\/games\/sentence-shooter\/sessions\/([^/]+)\/hints$/.exec(path);
    if (shooterHintMatch && method === "POST") {
      if (!activeShooterSession) {
        return respond(route, { detail: "Session not found" }, 404);
      }
      const currentRound =
        activeShooterSession.rounds[activeShooterSession.currentRoundIndex];
      const expectedToken =
        currentRound.tokens[activeShooterSession.nextExpectedPos] ??
        currentRound.tokens[0];
      activeShooterSession.hintCount += 1;
      return respond(route, {
        target_token_id: expectedToken.id,
        hint_count: activeShooterSession.hintCount,
        message: `Thử chọn từ "${expectedToken.text}" nhé!`,
      });
    }

    const shooterNextRoundMatch =
      /^\/games\/sentence-shooter\/sessions\/([^/]+)\/next-round$/.exec(path);
    if (shooterNextRoundMatch && method === "POST") {
      if (!activeShooterSession) {
        return respond(route, { detail: "Session not found" }, 404);
      }
      activeShooterSession.currentRoundIndex += 1;
      activeShooterSession.nextExpectedPos = 0;
      const nextR =
        activeShooterSession.rounds[activeShooterSession.currentRoundIndex];
      return respond(route, {
        session_id: activeShooterSession.sessionId,
        completed_rounds: activeShooterSession.completedRounds,
        total_rounds: activeShooterSession.totalRounds,
        total_stars: activeShooterSession.totalStars,
        round: {
          round_id: nextR.round_id,
          round_number: nextR.round_number,
          token_count: nextR.tokens.length,
          tokens: nextR.tokens,
        },
      });
    }

    const shooterResultMatch =
      /^\/games\/sentence-shooter\/sessions\/([^/]+)\/result$/.exec(path);
    if (shooterResultMatch && method === "GET") {
      state.shooterResultCalls += 1;
      if (state.shooterResultStatus !== 200) {
        return respond(
          route,
          { detail: "private sql token" },
          state.shooterResultStatus,
        );
      }
      if (!activeShooterSession) {
        return respond(route, { detail: "Session not found" }, 404);
      }
      return respond(route, {
        session_id: activeShooterSession.sessionId,
        book: activeShooterSession.book,
        difficulty: activeShooterSession.difficulty,
        status: "COMPLETED",
        total_rounds: activeShooterSession.totalRounds,
        completed_rounds: activeShooterSession.completedRounds,
        correct_count: activeShooterSession.correctCount,
        mistakes_total: activeShooterSession.mistakesTotal,
        hint_count: activeShooterSession.hintCount,
        total_stars: activeShooterSession.totalStars,
        duration_seconds: 45,
        started_at: TIMESTAMP,
        completed_at: TIMESTAMP,
      });
    }

    const shooterAbandonMatch =
      /^\/games\/sentence-shooter\/sessions\/([^/]+)\/abandon$/.exec(path);
    if (shooterAbandonMatch && method === "POST") {
      return respond(route, {
        session_id: decodeURIComponent(shooterAbandonMatch[1]),
        status: "ABANDONED",
      });
    }

    // Picture Description
    if (path === "/games/picture-description/catalog" && method === "GET") {
      if (state.pictureStatus !== 200) {
        return respond(route, { detail: "Error" }, state.pictureStatus);
      }
      return respond(route, {
        samples: pictureSamples,
        book_pages: [
          {
            book_id: MOBILE_IDS.bookPrimary,
            book_title: String(
              catalogBooks[0]?.title ?? "Chào ngày mới cùng Bé An",
            ),
            page_id: MOBILE_IDS.pagePrimary,
            page_number: 1,
            image_url: "http://127.0.0.1:8000/test-page.svg",
          },
        ],
      });
    }

    if (path === "/games/picture-description/sessions") {
      if (method === "GET") {
        return respond(route, []);
      }
      if (method === "POST") {
        const sessionObj = {
          session_id: MOBILE_IDS.pictureSession1,
          child_id: state.children[0]?.id ?? MOBILE_IDS.childAn,
          child_grade: 2,
          source_type: "SAMPLE",
          sample_key: "sunny-garden",
          book_id: null,
          book_page_id: null,
          image_url: "http://127.0.0.1:8000/test-page.svg",
          scene_title: "Khu vườn đầy nắng",
          status: "ACTIVE",
          best_stars: 0,
          best_score: 0,
          attempts_count: 0,
          guide: {
            is_child_safe: true,
            scene_title: "Khu vườn đầy nắng",
            scene_summary: "Một khu vườn rực rỡ hoa và ánh nắng.",
            guiding_questions: ["Trong tranh có những bông hoa màu gì?"],
            suggested_vocabulary: [
              { word: "rực rỡ", hint: "Ánh sáng hoặc màu sắc tươi đẹp" },
            ],
            model_sample_sentences: [
              "Trong khu vườn có nhiều bông hoa rực rỡ dưới nắng mai.",
            ],
          },
          attempts: [],
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP,
        };
        pictureSessions.set(MOBILE_IDS.pictureSession1, sessionObj);
        return respond(route, sessionObj);
      }
    }

    const pictureEvalMatch =
      /^\/games\/picture-description\/sessions\/([^/]+)\/evaluate$/.exec(path);
    if (pictureEvalMatch && method === "POST") {
      if (state.pictureEvaluateStatus !== 200) {
        return respond(route, { detail: "Error" }, state.pictureEvaluateStatus);
      }
      const targetId = decodeURIComponent(pictureEvalMatch[1]);
      const existing = pictureSessions.get(targetId);
      const body = req.postDataJSON() as {
        transcript_text: string;
        input_mode: "VOICE" | "TEXT";
      };
      const attempt = {
        attempt_id: makeUuid("cc100000", 1),
        attempt_number: 1,
        input_mode: body.input_mode,
        transcript_text: body.transcript_text,
        score_out_of_10: 9,
        stars: 3,
        evaluation_source: "AI",
        feedback: {
          is_relevant: true,
          score_out_of_10: 9,
          stars: 3,
          matched_details: ["Nhắc đến khu vườn và nắng mai"],
          missed_details: [],
          praise_message: "Bé kể chuyện thật sinh động và rõ ràng!",
          improvement_tip:
            "Bé có thể thêm tiếng chim hót cho câu văn thêm vui.",
          upgraded_sentences: [
            "Buổi sáng, khu vườn ngập tràn nắng vàng và hương hoa thơm.",
          ],
          vocabulary_highlights: ["rực rỡ", "nắng vàng"],
        },
        created_at: TIMESTAMP,
      };
      const updatedSession = {
        ...(existing ?? {}),
        session_id: targetId,
        status: "COMPLETED",
        best_stars: 3,
        best_score: 9,
        attempts_count: 1,
        attempts: [attempt],
        updated_at: TIMESTAMP,
      };
      pictureSessions.set(targetId, updatedSession);
      return respond(route, {
        session: updatedSession,
        latest_attempt: attempt,
      });
    }

    // Karaoke
    if (path === "/karaoke/songs" && method === "GET") {
      const card = {
        song_id: MOBILE_IDS.karaokeSongId,
        version_id: MOBILE_IDS.karaokeVersionId,
        title: "Bài hát của bé",
        author: "Tác giả",
        duration_ms: 20000,
        min_grade: 1,
        max_grade: 5,
        cover_url: null,
      };
      return respond(route, {
        items: [card],
        total: 1,
        limit: 12,
        offset: 0,
      });
    }

    if (
      path === `/karaoke/songs/${MOBILE_IDS.karaokeSongId}/playback` &&
      method === "GET"
    ) {
      const { revision, ...source } = previewDetail();
      void revision;
      return respond(route, source);
    }

    // Support
    if (path === "/support/feedback" && method === "POST") {
      if (state.supportStatus !== 200) {
        return respond(
          route,
          { detail: "SMTP unavailable" },
          state.supportStatus,
        );
      }
      state.supportPayloads.push(req.postDataJSON() as Record<string, unknown>);
      return respond(route, {
        accepted: true,
        delivery_status: "accepted_by_smtp",
        message_id: "msg-test-1",
      });
    }

    return route.fallback();
  });

  return state;
}

export function normalizeProjectBucket(projectName: string): string {
  if (projectName === "desktop") return "desktop-1440x1000";
  if (projectName === "mobile") return "mobile-390x844";
  return projectName;
}

export function isMobileViewport(page: Page): boolean {
  const width = page.viewportSize()?.width ?? 1440;
  return width < 768;
}

export function isCompactNavViewport(page: Page): boolean {
  const width = page.viewportSize()?.width ?? 1440;
  return width < 1280;
}

export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    metrics.scrollWidth,
    `Horizontal overflow detected: scrollWidth=${metrics.scrollWidth}, clientWidth=${metrics.clientWidth}, innerWidth=${metrics.innerWidth}`,
  ).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

export async function assertTouchTargetsMin44(
  page: Page,
  options?: {
    readonly scopeSelector?: string;
    readonly ignoreLabels?: ReadonlyArray<RegExp>;
  },
): Promise<void> {
  const viewportWidth = page.viewportSize()?.width ?? 1440;
  if (viewportWidth >= 1024) return;

  const scopeSelector = options?.scopeSelector ?? "body";
  const violations = await page.evaluate((selector) => {
    const root = document.querySelector(selector) ?? document.body;
    const candidates = Array.from(
      root.querySelectorAll(
        'button, a[href], [role="tab"], [role="menuitem"], [role="option"], summary, select, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
      ),
    );
    const results: Array<{
      label: string;
      width: number;
      height: number;
      tag: string;
    }> = [];
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        el.classList.contains("sr-only") ||
        el.getAttribute("aria-hidden") === "true"
      ) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width < 43.5 || rect.height < 43.5) {
        const label =
          el.getAttribute("aria-label") ||
          el.textContent?.trim().replace(/\s+/g, " ") ||
          el.getAttribute("href") ||
          el.tagName;
        results.push({
          tag: el.tagName.toLowerCase(),
          label: label.slice(0, 80),
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        });
      }
    }
    return results;
  }, scopeSelector);

  const filtered = options?.ignoreLabels?.length
    ? violations.filter(
        (v) => !options.ignoreLabels!.some((pattern) => pattern.test(v.label)),
      )
    : violations;

  expect(
    filtered,
    `Touch target(s) smaller than 44x44px at ${viewportWidth}px: ${JSON.stringify(filtered)}`,
  ).toEqual([]);
}

export async function assertAboveMobileBottomNav(
  page: Page,
  locator: Locator,
): Promise<void> {
  const bottomNav = page.getByTestId("mobile-bottom-nav");
  if (!(await bottomNav.isVisible())) return;

  await locator.scrollIntoViewIfNeeded();
  const [targetBox, navBox] = await Promise.all([
    locator.boundingBox(),
    bottomNav.boundingBox(),
  ]);
  expect(targetBox, "Target element must have a bounding box").not.toBeNull();
  expect(navBox, "Mobile bottom nav must have a bounding box").not.toBeNull();

  if (targetBox && navBox) {
    expect(
      targetBox.y + targetBox.height,
      `Element bottom (${targetBox.y + targetBox.height}) overlaps mobile-bottom-nav top (${navBox.y})`,
    ).toBeLessThanOrEqual(navBox.y + 1);
  }

  const hitNotOccluded = await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit !== null && (el === hit || el.contains(hit));
  });
  expect(
    hitNotOccluded,
    "Target element center is occluded by another layer",
  ).toBe(true);
}

export async function selectChildViaUi(
  page: Page,
  alias = "Bé An",
): Promise<void> {
  const quickSwitcher = page.getByRole("button", {
    name: /Bé đang chọn: .*, bấm để đổi|Đổi nhanh bé/,
  });
  if (await quickSwitcher.isVisible()) {
    await quickSwitcher.click();
    const listbox = page.getByRole("listbox", {
      name: "Chuyển nhanh hồ sơ bé",
    });
    await expect(listbox).toBeVisible();
    await listbox.getByRole("option", { name: new RegExp(alias) }).click();
    return;
  }

  if (!new URL(page.url()).pathname.endsWith("/dashboard")) {
    await page.goto("/dashboard");
  }
  const childBtn = page.getByRole("button", {
    name: new RegExp(`^${alias}, lớp`),
  });
  await expect(childBtn).toBeVisible();
  await childBtn.click();
}

export function assertZeroRuntimeErrors(state: MobileOverhaulState): void {
  expect(state.pageErrors, "Unexpected uncaught page errors").toEqual([]);
  expect(state.consoleErrors, "Unexpected console.error messages").toEqual([]);
  expect(state.unexpected, "Unexpected API/fixture calls").toEqual([]);
  expect(state.base.unexpected, "Unexpected base fixture calls").toEqual([]);
}

export async function assertNoRawBackendLeak(page: Page): Promise<void> {
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toMatch(
    /private sql token|traceback|sqlalchemy|stack trace/i,
  );
}
