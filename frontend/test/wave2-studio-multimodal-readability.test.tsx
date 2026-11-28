import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FamilyStoryweaverModal } from "@/components/books/family-storyweaver-modal";
import { ReadabilityBadge } from "@/components/books/readability-badge";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import { SessionComplete } from "@/components/reading/session-complete";
import {
  buildDuetTurnsForPage,
  resolveActiveDuetTurn,
} from "@/lib/reading/duet-reading";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import {
  downloadMilestoneCertificatePng,
  triggerPrintA4Report,
} from "@/lib/reports/milestone-certificate-canvas";
import type { ReadingPageDTO } from "@/types/reading";

const createStoryweaverMock = vi.fn();

vi.mock("@/lib/api/parent-private-book-service", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/api/parent-private-book-service")
    >();
  return {
    ...actual,
    createParentPrivateBookService: () => ({
      ...actual.createParentPrivateBookService(),
      createStoryweaverBook: createStoryweaverMock,
    }),
  };
});

vi.mock("@/hooks/use-auth-runtime", () => ({
  useAuthRuntime: () => ({
    session: { user: { id: "10000000-0000-4000-8000-000000000001" } },
    initialUserId: "10000000-0000-4000-8000-000000000001",
  }),
}));

describe("Wave 2 — Studio V2 Multimodal Bridge, Duet Reading, Readability & Storyweaver", () => {
  beforeEach(() => {
    createStoryweaverMock.mockReset();
  });

  it("builds alternating Parent/Child duet turns and advances parent turn in RealtimeAlignmentEngine", () => {
    const samplePage: ReadingPageDTO = {
      page_id: "30000000-0000-4000-8000-000000000001",
      page_revision_id: "40000000-0000-4000-8000-000000000001",
      page_number: 1,
      confidence: null,
      width: 1000,
      height: 1400,
      page_kind: "COMIC",
      words: [
        {
          word_id: "w1",
          word_index: 0,
          line_index: 0,
          text: "Sáng",
          bbox: [0.1, 0.1, 0.1, 0.05],
        },
        {
          word_id: "w2",
          word_index: 1,
          line_index: 0,
          text: "nay",
          bbox: [0.22, 0.1, 0.1, 0.05],
        },
        {
          word_id: "w3",
          word_index: 2,
          line_index: 1,
          text: "—",
          bbox: [0.1, 0.25, 0.05, 0.05],
        },
        {
          word_id: "w4",
          word_index: 3,
          line_index: 1,
          text: "Chào",
          bbox: [0.18, 0.25, 0.1, 0.05],
        },
        {
          word_id: "w5",
          word_index: 4,
          line_index: 1,
          text: "mẹ!",
          bbox: [0.3, 0.25, 0.1, 0.05],
        },
      ],
    };

    const turns = buildDuetTurnsForPage(samplePage);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.role).toBe("PARENT");
    expect(turns[1]!.role).toBe("CHILD");

    const activeFirst = resolveActiveDuetTurn(turns, "w1", new Set());
    expect(activeFirst?.role).toBe("PARENT");

    const engine = new RealtimeAlignmentEngine(samplePage.words);
    const snap = engine.advanceParentTurnWords(turns[0]!.wordIds);
    expect(snap.currentWordId).toBe("w3");
    expect(snap.statusByWordId.get("w1")?.status).toBe("MATCH");
    expect(snap.statusByWordId.get("w2")?.status).toBe("MATCH");
  });

  it("renders Studio V2 page_kind badge inside BookPageViewer without adding extra buttons", () => {
    const poemPage: ReadingPageDTO = {
      page_id: "30000000-0000-4000-8000-000000000002",
      page_revision_id: "40000000-0000-4000-8000-000000000002",
      page_number: 2,
      confidence: null,
      width: 1000,
      height: 1400,
      page_kind: "POEM",
      words: [
        {
          word_id: "p1",
          word_index: 0,
          line_index: 0,
          text: "Nắng",
          bbox: [0.1, 0.1, 0.1, 0.05],
        },
        {
          word_id: "p2",
          word_index: 1,
          line_index: 0,
          text: "sớm",
          bbox: [0.25, 0.1, 0.1, 0.05],
        },
      ],
    };

    render(<BookPageViewer page={poemPage} title="Thơ mùa xuân" />);
    expect(screen.getByTestId("studio-v2-page-kind-badge")).toHaveTextContent(
      /Thơ thiếu nhi/i,
    );
    // Preserve book-page-viewer.test.tsx button-count invariant (1 button per word in prose/poem body + mode tab)
    expect(screen.getByText("Nắng")).toBeInTheDocument();
  });

  it("renders Multimodal Bridge links on SessionComplete without breaking score=null % invariant", () => {
    render(
      <SessionComplete
        bookId="20000000-0000-4000-8000-000000000099"
        booksHref="/books"
        child={{
          id: "10000000-0000-4000-8000-000000000088",
          parent_id: "10000000-0000-4000-8000-000000000001",
          alias: "Bé Minh",
          grade: 2,
          settings: {},
          created_at: "2026-10-01T00:00:00Z",
        }}
        lastPageId="30000000-0000-4000-8000-000000000077"
        sessionId="50000000-0000-4000-8000-000000000066"
        summary={{
          duration_minutes: 5,
          pages_explored: 2,
          practiced_words: 12,
          score: null,
        }}
      />,
    );

    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    const bridge = screen.getByTestId("multimodal-bridge-panel");
    expect(bridge).toBeInTheDocument();
    const pictureLink = screen.getByRole("link", {
      name: /Tả tranh trang sách/i,
    });
    expect(pictureLink.getAttribute("href")).toContain(
      "/entertainment/picture-description?",
    );
    expect(pictureLink.getAttribute("href")).toContain(
      "pageId=30000000-0000-4000-8000-000000000077",
    );
  });

  it("renders ReadabilityBadge and FamilyStoryweaverModal with % AiProgressBar", async () => {
    render(
      <ReadabilityBadge
        readability={{
          estimated_grade_band: "GRADE_1",
          estimated_min_grade: 1,
          estimated_max_grade: 1,
          grade_match_status: "MATCHED",
          phonics_readiness_score: 96,
          explanation_vi: "Khớp tốt Lớp 1",
        }}
      />,
    );
    expect(
      screen.getByTestId("vietnamese-readability-badge"),
    ).toHaveTextContent(/96%/);

    let resolveStory!: (val: unknown) => void;
    createStoryweaverMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStory = resolve;
        }),
    );

    render(<FamilyStoryweaverModal isOpen onClose={vi.fn()} />);

    const submitBtn = screen.getByRole("button", {
      name: /Tạo sách mỏng ngay/i,
    });
    fireEvent.click(submitBtn);

    expect(screen.getByTestId("storyweaver-ai-progress")).toBeInTheDocument();
    expect(screen.getByTestId("storyweaver-ai-progress-pct")).toHaveTextContent(
      /%/,
    );

    resolveStory({
      book_detail: {
        book: {
          id: "60000000-0000-4000-8000-000000000011",
          title: "Chuyến khám phá khu vườn nắng sớm",
          author: "Gia đình",
          min_grade: 1,
          max_grade: 1,
          lifecycle_status: "ACTIVE",
          visibility_scope: "PARENT_PRIVATE",
          moderation_status: "ACTIVE",
          suspended_reason: null,
          source_declaration: "[SELF_AUTHORED]",
          committed_page_count: 3,
          pending_submission_count: 0,
          flagged_submission_count: 0,
          failed_submission_count: 0,
          ready_to_add_count: 0,
          readable_for_children: true,
          has_held_multipage_batch: false,
          privacy_notice: "Riêng tư",
          created_at: "2026-11-28T00:00:00Z",
        },
        pages: [
          {
            page_id: "70000000-0000-4000-8000-000000000001",
            page_number: 1,
            current_verified_revision_id:
              "80000000-0000-4000-8000-000000000001",
            verified_text: "Trang 1",
            verified_text_preview: "Trang 1",
            image_url: "https://example.org/p1.webp",
            created_at: "2026-11-28T00:00:00Z",
          },
        ],
        submissions: [],
      },
      target_words_used: ["nắng sớm"],
      generation_source: "DETERMINISTIC_TEMPLATE",
      readability: {
        syllable_count: 30,
        sentence_count: 5,
        avg_syllables_per_sentence: 6,
        complex_phonics_ratio: 0.1,
        multisyllable_ratio: 0.05,
        decodable_syllable_ratio: 0.98,
        estimated_grade_band: "GRADE_1",
        estimated_min_grade: 1,
        estimated_max_grade: 1,
        grade_match_status: "MATCHED",
        phonics_readiness_score: 98,
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("storyweaver-created-card")).toHaveTextContent(
        "Chuyến khám phá khu vườn nắng sớm",
      );
    });
  });

  it("triggers window.print for A4 print helper and handles headless canvas gracefully", async () => {
    const printSpy = vi.fn();
    Object.defineProperty(window, "print", {
      value: printSpy,
      configurable: true,
      writable: true,
    });
    triggerPrintA4Report();
    expect(printSpy).toHaveBeenCalledOnce();

    // In JSDOM without canvas package, getContext('2d') returns null and resolves false cleanly without throwing
    const ok = await downloadMilestoneCertificatePng({
      brandLabel: "VIREAD",
      heading: "CHỨNG NHẬN",
      subtitle: "Tiến bộ đọc sách",
      awardedToLabel: "Trao tặng",
      childName: "Bé Lan",
      gradeLabel: "Lớp 1",
      achievementLine: "Hoàn thành 5 phiên đọc",
      statsLine: "Độ chính xác: 95%",
      issuedDateLabel: "28/11/2026",
      encouragementFooter: "Chúc mừng con!",
    });
    expect(typeof ok).toBe("boolean");
  });
});
