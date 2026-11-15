import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  childFixture,
  TEST_BOOK_ID,
  TEST_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const PAGE_ID = "31000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "41000000-0000-4000-8000-000000000001";

const catalogPayload = {
  samples: [
    {
      sample_key: "sunny-garden",
      title: "Khu vườn đầy nắng",
      theme: "Thiên nhiên",
      description: "Chú mèo cam ngủ trưa trên ghế gỗ giữa vườn hoa.",
      image_url: "/images/picture-description/sunny-garden.jpg",
    },
  ],
  book_pages: [
    {
      book_id: TEST_BOOK_ID,
      book_title: "Khu vườn buổi sáng",
      page_id: PAGE_ID,
      page_number: 3,
      image_url: "https://signed.example/book-page-3.png",
    },
  ],
};

const baseSession = {
  session_id: TEST_SESSION_ID,
  child_id: TEST_CHILD_ID,
  child_grade: 2,
  source_type: "SAMPLE",
  sample_key: "sunny-garden",
  book_id: null,
  book_page_id: null,
  image_url: "/images/picture-description/sunny-garden.jpg",
  scene_title: "Chú mèo ngủ trưa trong vườn nắng",
  status: "ACTIVE",
  best_stars: 0,
  best_score: 0,
  attempts_count: 0,
  guide: {
    is_child_safe: true,
    scene_title: "Chú mèo ngủ trưa trong vườn nắng",
    scene_summary: "Chú mèo cam đang nằm ngủ trên ghế gỗ giữa khu vườn đầy nắng.",
    guiding_questions: [
      "Bé thấy con vật nào đang nằm ngủ trên ghế gỗ?",
      "Xung quanh ghế có những bông hoa gì?",
      "Mặt trời hôm nay trông như thế nào?",
    ],
    suggested_vocabulary: [
      { word: "nằm cuộn tròn", hint: "Tư thế ngủ ngoan của chú mèo" },
      { word: "hướng dương", hint: "Loài hoa màu vàng tươi" },
    ],
    model_sample_sentences: [
      "Chú mèo cam đang ngủ ngon lành trên chiếc ghế gỗ giữa vườn hoa.",
    ],
  },
  attempts: [],
  created_at: "2026-11-15T08:00:00Z",
  updated_at: "2026-11-15T08:00:00Z",
};

const evaluatedFeedback = {
  is_relevant: true,
  score_out_of_10: 9,
  stars: 3,
  matched_details: ["Chú mèo màu cam ngủ trên ghế gỗ", "Hoa hướng dương vàng"],
  missed_details: ["Chiếc bình tưới nước màu xanh"],
  praise_message: "Cô khen bé quan sát rất tinh mắt và viết câu trọn ý!",
  improvement_tip: "Lần sau bé kể thêm chiếc bình tưới cây bên góc cỏ nữa nhé.",
  upgraded_sentences: [
    "Dưới nắng mai ấm áp, chú mèo cam đang cuộn tròn ngủ ngon trên ghế gỗ.",
  ],
  vocabulary_highlights: ["cuộn tròn", "ấm áp"],
};

const fetchMock = vi.fn();

beforeEach(() => {
  navigation.replace.mockReset();
  navigation.push.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      writable: true,
      value: vi.fn(() => "blob:preview-picture"),
    });
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      writable: true,
      value: vi.fn(),
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setupDefaultResponses() {
  let completed = false;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const reqUrl = new URL(url);
    const path = reqUrl.pathname;
    if (path === `/profiles/children/${TEST_CHILD_ID}`) {
      return Response.json(childFixture);
    }
    if (path === "/voice/text-to-speech") {
      return new Response(null, { status: 503 });
    }
    if (path === "/games/picture-description/catalog") {
      return Response.json(catalogPayload);
    }
    if (path === "/games/picture-description/sessions" && (!init?.method || init.method === "GET")) {
      return Response.json(
        completed
          ? [
              {
                session_id: TEST_SESSION_ID,
                child_id: TEST_CHILD_ID,
                source_type: "SAMPLE",
                scene_title: baseSession.scene_title,
                image_url: baseSession.image_url,
                status: "COMPLETED",
                best_stars: 3,
                best_score: 9,
                attempts_count: 1,
                created_at: baseSession.created_at,
                updated_at: "2026-11-15T08:05:00Z",
              },
            ]
          : [],
      );
    }
    if (path === "/games/picture-description/sessions" && init?.method === "POST") {
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      const sourceType = form.get("source_type");
      return Response.json(
        {
          ...baseSession,
          source_type: sourceType,
        },
        { status: 201 },
      );
    }
    if (path === `/games/picture-description/sessions/${TEST_SESSION_ID}/evaluate`) {
      completed = true;
      const body = JSON.parse(String(init?.body)) as {
        transcript_text: string;
        input_mode: string;
      };
      const attempt = {
        attempt_id: ATTEMPT_ID,
        attempt_number: 1,
        input_mode: body.input_mode,
        transcript_text: body.transcript_text,
        score_out_of_10: 9,
        stars: 3,
        feedback: evaluatedFeedback,
        created_at: "2026-11-15T08:05:00Z",
      };
      return Response.json({
        session: {
          ...baseSession,
          status: "COMPLETED",
          best_stars: 3,
          best_score: 9,
          attempts_count: 1,
          attempts: [attempt],
        },
        latest_attempt: attempt,
      });
    }
    throw new Error(`Unexpected test route ${path}`);
  });
}

function renderScreen() {
  return render(
    <AppServicesProvider>
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <PictureDescriptionScreen />
      </WithSelectedChild>
    </AppServicesProvider>,
  );
}

describe("PictureDescriptionScreen", () => {
  it("loads catalog samples, starts a sample session, and evaluates child's description", async () => {
    setupDefaultResponses();
    const user = userEvent.setup();
    renderScreen();

    expect(
      await screen.findByRole("heading", { name: "Kể chuyện qua tranh" }),
    ).toBeInTheDocument();

    expect(await screen.findByText("Khu vườn đầy nắng")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Khám phá tranh này" }));

    expect(
      await screen.findByText("Chú mèo ngủ trưa trong vườn nắng"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Bé thấy con vật nào đang nằm ngủ trên ghế gỗ?"),
    ).toBeInTheDocument();

    // Tap suggested vocab chip to view definition hint
    await user.click(screen.getByRole("button", { name: /nằm cuộn tròn/i }));
    expect(
      await screen.findByText(/Tư thế ngủ ngoan của chú mèo/),
    ).toBeInTheDocument();

    const textarea = screen.getByLabelText("Nội dung bé mô tả bức tranh");
    await user.type(
      textarea,
      "Chú mèo màu cam đang ngủ ngon trên ghế gỗ giữa vườn hoa hướng dương.",
    );

    await user.click(
      screen.getByRole("button", { name: /Gửi cô giáo AI chấm bài/i }),
    );

    expect(
      await screen.findByText("Cô khen bé quan sát rất tinh mắt và viết câu trọn ý!"),
    ).toBeInTheDocument();
    expect(screen.getByText("9/10 điểm")).toBeInTheDocument();
    expect(screen.getByText("• Chú mèo màu cam ngủ trên ghế gỗ")).toBeInTheDocument();
  });

  it("supports custom upload tab validation and book page selection", async () => {
    setupDefaultResponses();
    const user = userEvent.setup();
    renderScreen();

    await screen.findByText("Khu vườn đầy nắng");

    // Switch to Book Page tab
    await user.click(screen.getByRole("tab", { name: /Tranh từ sách ViRead/i }));
    expect(await screen.findByText("Khu vườn buổi sáng")).toBeInTheDocument();

    // Switch to Custom Upload tab and upload a valid PNG file
    await user.click(screen.getByRole("tab", { name: /Tải ảnh từ máy/i }));
    const fileInput = screen.getByLabelText("Chọn tệp ảnh để mô tả");
    const validFile = new File(["fake-png"], "tranh-ve.png", {
      type: "image/png",
    });
    await user.upload(fileInput, validFile);

    await waitFor(() => {
      expect(screen.getByText("Đã chọn: tranh-ve.png")).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /Phân tích tranh & Bắt đầu/i }),
    );

    expect(
      await screen.findByText("Chú mèo ngủ trưa trong vườn nắng"),
    ).toBeInTheDocument();
  });

  it("shows a safe Vietnamese error when Gemini rejects an unsafe image", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/picture-description/catalog") {
        return Response.json(catalogPayload);
      }
      if (path === "/games/picture-description/sessions" && (!init?.method || init.method === "GET")) {
        return Response.json([]);
      }
      if (path === "/games/picture-description/sessions" && init?.method === "POST") {
        return Response.json({ detail: "UNSAFE_PICTURE" }, { status: 422 });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    const user = userEvent.setup();
    renderScreen();
    await screen.findByText("Khu vườn đầy nắng");

    await user.click(screen.getByRole("button", { name: "Khám phá tranh này" }));

    expect(
      await screen.findByText(/Bức tranh này chưa phù hợp cho trẻ tiểu học/i),
    ).toBeInTheDocument();
  });
});
