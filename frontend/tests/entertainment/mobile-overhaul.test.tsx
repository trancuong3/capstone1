import fs from "node:fs";
import path from "node:path";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ButtonSizeProvider } from "@/components/common/button";
import { EntertainmentScreen } from "@/components/entertainment/entertainment-screen";
import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import { SentenceShooterScreen } from "@/components/entertainment/sentence-shooter/sentence-shooter-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  childFixture,
  TEST_BOOK_ID,
  TEST_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const recorderMock = vi.hoisted(() => ({
  isRecording: false,
  isSpeaking: false,
  audioLevel: 0,
  prepare: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => new Blob(["fake-audio"], { type: "audio/webm" })),
  cancel: vi.fn(),
  getStream: vi.fn(() => null),
  getIsSpeaking: vi.fn(() => false),
  getQuality: vi.fn(() => null),
  getSettings: vi.fn(() => ({})),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));
vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => recorderMock,
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

const shooterBooks = Array.from({ length: 11 }, (_, idx) => ({
  id: `13000000-0000-4000-8000-0000000000${String(idx + 1).padStart(2, "0")}`,
  name: `Sách ${idx + 1}`,
  title: `Cuốn sách số ${idx + 1}`,
  author: "Tác giả kiểm thử",
  min_grade: 1,
  max_grade: 3,
  available_rounds: 3,
}));

const shooterRound = {
  round_id: "22000000-0000-4000-8000-000000000001",
  round_number: 1,
  token_count: 3,
  tokens: [
    { id: "21000000-0000-4000-8000-000000000001", text: "Bé" },
    { id: "21000000-0000-4000-8000-000000000002", text: "đọc" },
    { id: "21000000-0000-4000-8000-000000000003", text: "sách." },
  ],
};

const pictureCatalog = {
  samples: [
    {
      sample_key: "sunny-garden",
      title: "Khu vườn đầy nắng",
      theme: "Thiên nhiên",
      description: "Chú mèo cam ngủ trưa.",
      image_url: "/images/picture-description/sunny-garden.jpg",
    },
  ],
  book_pages: [
    {
      book_id: TEST_BOOK_ID,
      book_title: "Trang sách thiên nhiên",
      page_id: "31000000-0000-4000-8000-000000000001",
      page_number: 1,
      image_url: "https://signed.example/book-page-1.png",
    },
  ],
};

const pictureAttempt1 = {
  attempt_id: "41000000-0000-4000-8000-000000000011",
  attempt_number: 1,
  input_mode: "TEXT",
  transcript_text: "Chú mèo ngủ trưa.",
  score_out_of_10: 7,
  stars: 2,
  evaluation_source: "AI",
  feedback: {
    is_relevant: true,
    score_out_of_10: 7,
    stars: 2,
    matched_details: ["Chú mèo đang ngủ"],
    missed_details: ["Hoa hướng dương"],
    praise_message: "Bé kể hay lắm!",
    improvement_tip: "Kể thêm về hoa nhé.",
    upgraded_sentences: ["Chú mèo cam nằm ngủ giữa vườn hoa."],
    vocabulary_highlights: ["cuộn tròn"],
  },
  created_at: "2026-11-15T08:05:00Z",
};

const pictureAttempt2 = {
  ...pictureAttempt1,
  attempt_id: "41000000-0000-4000-8000-000000000012",
  attempt_number: 2,
  score_out_of_10: 9,
  stars: 3,
};

const pictureSession = {
  session_id: TEST_SESSION_ID,
  child_id: TEST_CHILD_ID,
  child_grade: 2,
  source_type: "SAMPLE",
  sample_key: "sunny-garden",
  book_id: null,
  book_page_id: null,
  image_url: "/images/picture-description/sunny-garden.jpg",
  scene_title: "Chú mèo ngủ trưa trong vườn nắng",
  status: "COMPLETED",
  best_stars: 3,
  best_score: 9,
  attempts_count: 2,
  guide: {
    is_child_safe: true,
    scene_title: "Chú mèo ngủ trưa trong vườn nắng",
    scene_summary: "Chú mèo cam nằm ngủ.",
    guiding_questions: ["Bé thấy con vật nào?"],
    suggested_vocabulary: [
      { word: "cuộn tròn", hint: "Tư thế ngủ của chú mèo" },
    ],
    model_sample_sentences: ["Chú mèo cam đang ngủ ngon lành."],
  },
  attempts: [pictureAttempt2, pictureAttempt1],
  created_at: "2026-11-15T08:00:00Z",
  updated_at: "2026-11-15T08:08:00Z",
};

const fetchMock = vi.fn();

beforeEach(() => {
  navigation.replace.mockReset();
  navigation.push.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Entertainment M3.4 mobile overhaul", () => {
  it("aligns EntertainmentScreen grids and avoids min-h-11/min-h-12 conflicts under compact ButtonSizeProvider", () => {
    const { container } = render(
      <ButtonSizeProvider size="compact">
        <EntertainmentScreen />
      </ButtonSizeProvider>,
    );

    const grid = container.querySelector("section > div.grid");
    expect(grid).toHaveClass("min-[640px]:grid-cols-2");

    const karaokeCard = screen
      .getByRole("heading", { name: "Hát vui cùng bé" })
      .closest("article");
    expect(karaokeCard).toHaveClass("min-[640px]:flex-row");

    const sentenceShooterLink = screen.getByRole("link", {
      name: "Bắt đầu chơi",
    });
    expect(sentenceShooterLink).toHaveClass("min-h-12");
    expect(sentenceShooterLink).not.toHaveClass("min-h-11");

    const karaokeLink = screen.getByRole("link", {
      name: "Mở thư viện bài hát",
    });
    expect(karaokeLink).toHaveClass("w-full", "min-[640px]:w-auto", "min-h-12");
    expect(karaokeLink).not.toHaveClass("min-h-11");
  });

  it("removes redundant horizontal padding, upgrades SentenceShooterScreen lobby to PageHeader, and keeps arena cannon row compact", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const pathName = new URL(String(url)).pathname;
      if (pathName === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (pathName === "/games/sentence-shooter/books") {
        return Response.json(shooterBooks);
      }
      if (pathName === "/games/sentence-shooter/sessions") {
        return Response.json(
          {
            session_id: TEST_SESSION_ID,
            book: shooterBooks[0],
            difficulty: "easy",
            total_rounds: 3,
            completed_rounds: 0,
            total_stars: 0,
            round: shooterRound,
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected path ${pathName}`);
    });

    const user = userEvent.setup();
    const { container } = render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <SentenceShooterScreen />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const lobbyHeading = await screen.findByRole("heading", {
      name: "Chọn sách và bắt đầu chơi",
    });
    expect(lobbyHeading).toHaveClass("text-xl");
    expect(
      container.querySelector("header p.hidden.md\\:block"),
    ).toBeInTheDocument();

    const lobbySection = container.querySelector("section");
    expect(lobbySection?.className).not.toMatch(/(?:^|\s)px-4(?:\s|$)/);

    const difficultyGrid = screen
      .getByRole("button", { name: /Dễ/ })
      .closest("div.grid");
    expect(difficultyGrid).toHaveClass("min-[640px]:grid-cols-3");

    const firstBookBtn = await screen.findByRole("button", {
      name: /Cuốn sách số 1/,
    });
    const booksGrid = firstBookBtn.closest("div.grid");
    expect(booksGrid).toHaveClass("min-[640px]:grid-cols-2", "lg:grid-cols-3");

    const nextBtn = screen.getByRole("button", { name: "Tiếp" });
    expect(nextBtn).toHaveClass("min-h-11");

    await user.click(firstBookBtn);
    await user.click(screen.getByRole("button", { name: /Bắt đầu chơi/ }));
    await screen.findByRole("button", { name: "Bé" });

    const playingSection = container.querySelector("section");
    expect(playingSection?.className).not.toMatch(/(?:^|\s)px-4(?:\s|$)/);

    const status = screen.getByRole("status");
    expect(status).not.toHaveClass("min-w-40");
    expect(status).toHaveClass("min-w-[min(100%,9rem)]", "flex-1");

    const hintButton = screen.getByRole("button", { name: /Gợi ý một từ/ });
    expect(hintButton).toHaveClass("min-h-11", "max-[640px]:w-full");

    const tokenBtn = screen.getByRole("button", { name: "Bé" });
    expect(tokenBtn).toHaveClass("min-h-12", "break-words");

    const pauseLabel = screen.getByText("Tạm dừng");
    expect(pauseLabel).toHaveClass("hidden", "min-[640px]:inline");
  });

  it("enforces >=44px tap targets and non-w-full inline buttons in PictureDescriptionScreen", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const pathName = new URL(String(url)).pathname;
      if (pathName === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (pathName === "/games/picture-description/catalog") {
        return Response.json(pictureCatalog);
      }
      if (pathName === "/games/picture-description/sessions") {
        return Response.json([
          {
            session_id: TEST_SESSION_ID,
            child_id: TEST_CHILD_ID,
            source_type: "SAMPLE",
            sample_key: "sunny-garden",
            scene_title: pictureSession.scene_title,
            image_url: pictureSession.image_url,
            status: "COMPLETED",
            best_stars: 3,
            best_score: 9,
            attempts_count: 2,
            created_at: pictureSession.created_at,
            updated_at: pictureSession.updated_at,
          },
        ]);
      }
      if (
        pathName === `/games/picture-description/sessions/${TEST_SESSION_ID}`
      ) {
        return Response.json(pictureSession);
      }
      throw new Error(`Unexpected path ${pathName}`);
    });

    const user = userEvent.setup();
    render(
      <ButtonSizeProvider size="compact">
        <AppServicesProvider>
          <WithSelectedChild childId={TEST_CHILD_ID}>
            <PictureDescriptionScreen />
          </WithSelectedChild>
        </AppServicesProvider>
      </ButtonSizeProvider>,
    );

    const sampleTitle = await screen.findByText("Khu vườn đầy nắng");
    expect(sampleTitle.closest("div.grid")).toHaveClass(
      "min-[640px]:grid-cols-2",
      "md:grid-cols-3",
    );

    const backLink = screen.getByRole("link", {
      name: /Quay lại góc Giải trí/,
    });
    expect(backLink).toHaveClass("min-h-11");

    await user.click(
      screen.getByRole("button", { name: "Xem kết quả & Kể tiếp" }),
    );

    const resultTab = await screen.findByRole("tab", {
      name: /Kết quả chấm điểm/,
    });
    const practiceTab = screen.getByRole("tab", { name: /Mô tả tranh/ });
    expect(resultTab).toHaveClass("min-h-11");
    expect(practiceTab).toHaveClass("min-h-11");

    const attemptPill = await screen.findByRole("button", {
      name: /Lượt #1 • 7\/10/,
    });
    expect(attemptPill).toHaveClass("min-h-11");

    const highlightChip = screen.getByRole("button", { name: "cuộn tròn" });
    expect(highlightChip).toHaveClass("min-h-11");

    const listenFeedbackBtn = screen.getByRole("button", {
      name: /Nghe nhận xét/,
    });
    expect(listenFeedbackBtn).toHaveClass("w-auto");
    expect(listenFeedbackBtn).not.toHaveClass("w-full");

    await user.click(practiceTab);

    const micBtn = screen.getByRole("button", { name: /Nói bằng Micro/ });
    expect(micBtn).toHaveClass("w-auto");
    expect(micBtn).not.toHaveClass("w-full");

    const hintsBtn = screen.getByRole("button", { name: /Mở gợi ý câu hỏi/ });
    expect(hintsBtn).toHaveClass("w-auto");
    expect(hintsBtn).not.toHaveClass("w-full");
    await user.click(hintsBtn);

    const vocabChip = await screen.findByRole("button", { name: /cuộn tròn/ });
    expect(vocabChip).toHaveClass("min-h-11");

    const sampleToggle = screen.getByRole("button", {
      name: /Xem câu mẫu tham khảo/,
    });
    expect(sampleToggle).toHaveClass("min-h-11");
    await user.click(sampleToggle);

    const listenSampleBtn = screen.getByRole("button", { name: "Nghe" });
    expect(listenSampleBtn).toHaveClass("w-auto");
    expect(listenSampleBtn).not.toHaveClass("w-full");
  });

  it("contains zero legacy sm:, max-sm:, max-[639px]:, or max-[767px]: classes across entertainment sources", () => {
    const rootDir = path.resolve(process.cwd(), "components/entertainment");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|css)$/.test(entry.name)) files.push(full);
      }
    };
    walk(rootDir);

    const violations: string[] = [];
    const forbidden = /(?<![\w-])(sm:|max-sm:|max-\[639px\]:|max-\[767px\]:)/;
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      if (forbidden.test(content)) {
        violations.push(path.relative(process.cwd(), file));
      }
    }
    expect(violations).toEqual([]);
  });
});
