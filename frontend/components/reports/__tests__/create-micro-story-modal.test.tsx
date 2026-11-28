import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CreateMicroStoryModal } from "@/components/reports/create-micro-story-modal";
import type {
  MicroStoryGenerateResponseDTO,
  MicroStoryPreviewDTO,
  MicroStoryService,
} from "@/lib/api/micro-story-service";
import { ServiceError } from "@/lib/api/service-error";
import type { ChildProfileDTO } from "@/types/child";

const SAMPLE_CHILD: ChildProfileDTO = {
  id: "child-bong-1",
  parent_id: "parent-1",
  alias: "Bé Bông",
  grade: 2,
  settings: {},
  created_at: "2026-11-28T07:00:00Z",
  avatar_url: null,
};

function makePreviewPayload(
  overrides?: Partial<MicroStoryPreviewDTO>,
): MicroStoryPreviewDTO {
  const words = [
    {
      normalized_word: "lung linh",
      display_text: "lung linh",
      source: "WEAK_WORD" as const,
      priority_score: 2.1,
      practice_count: 3,
      phonics_category: "l_n",
      phonics_label_vi: "Âm đầu l / n",
      reason_vi: "Bé cần ôn từ này",
      selected_by_default: true,
    },
    {
      normalized_word: "xinh xắn",
      display_text: "xinh xắn",
      source: "WEAK_WORD" as const,
      priority_score: 1.9,
      practice_count: 2,
      phonics_category: "s_x",
      phonics_label_vi: "Âm đầu s / x",
      reason_vi: "Bé cần ôn từ này",
      selected_by_default: true,
    },
    {
      normalized_word: "rộn ràng",
      display_text: "rộn ràng",
      source: "WEAK_WORD" as const,
      priority_score: 1.7,
      practice_count: 1,
      phonics_category: "r_d_gi",
      phonics_label_vi: "Âm đầu r / d / gi",
      reason_vi: "Bé cần ôn từ này",
      selected_by_default: true,
    },
    {
      normalized_word: "chim sẻ",
      display_text: "chim sẻ",
      source: "COLD_START_GRADE" as const,
      priority_score: 0.5,
      practice_count: 0,
      phonics_category: "tr_ch",
      phonics_label_vi: "Âm đầu tr / ch",
      reason_vi: "Gợi ý lớp 2",
      selected_by_default: true,
    },
    {
      normalized_word: "ngăn nắp",
      display_text: "ngăn nắp",
      source: "COLD_START_GRADE" as const,
      priority_score: 0.5,
      practice_count: 0,
      phonics_category: "coda_n_ng_t_c",
      phonics_label_vi: "Vần cuối n/ng · t/c",
      reason_vi: "Gợi ý lớp 2",
      selected_by_default: false,
    },
  ];
  return {
    child_id: SAMPLE_CHILD.id,
    child_alias: SAMPLE_CHILD.alias,
    child_grade: SAMPLE_CHILD.grade,
    recommended_words: words.filter((w) => w.selected_by_default),
    candidate_pool: words,
    cold_start_filled: true,
    privacy_notice_vi:
      "Truyện được lưu riêng tư tuyệt đối (PARENT_PRIVATE) trong Sách của tôi.",
    quota: {
      child_id: SAMPLE_CHILD.id,
      daily_limit: 2,
      used_today: 0,
      remaining_today: 2,
      quota_exceeded: false,
      resets_at_utc: "2026-11-29T00:00:00Z",
    },
    ...overrides,
  };
}

function makeCreatedResponse(): MicroStoryGenerateResponseDTO {
  return {
    book_id: "book-story-99",
    seeded_session_id: "session-seed-99",
    child_id: SAMPLE_CHILD.id,
    child_alias: SAMPLE_CHILD.alias,
    child_grade: SAMPLE_CHILD.grade,
    title: "Hành trình lung linh của Bé Bông",
    visibility_scope: "PARENT_PRIVATE",
    readable_for_children: true,
    reader_href: "/books/book-story-99",
    my_book_href: "/my-books/book-story-99",
    target_weak_words: makePreviewPayload().recommended_words,
    cold_start_filled: false,
    story_provider: "deterministic_wholesome_vi",
    illustration_provider: "cloudflare_flux",
    illustration_fallback_used: false,
    safety_status: "PASSED",
    pages: [1, 2, 3, 4].map((num) => ({
      page_id: `page-${num}`,
      page_number: num,
      revision_id: `rev-${num}`,
      text: `Nội dung trang ${num} có từ lung linh và xinh xắn rất vui tươi.`,
      word_count: 13,
      target_words_on_page: ["lung linh"],
      target_word_indices: [5, 6],
      image_url: `http://localhost:8000/books/my-books/book-story-99/pages/page-${num}/image`,
      illustration_provider: "cloudflare_flux",
      illustration_fallback_used: false,
    })),
    comprehension_questions: [
      {
        question_id: "q-1",
        page_number: 1,
        prompt: "Ai cùng Bé Bông dạo bước trong vườn?",
        choices: ["Bạn Mèo Mun", "Cá voi", "Tàu ngầm", "Bão tuyết"],
        correct_answer: "Bạn Mèo Mun",
        difficulty: "EASY",
      },
      {
        question_id: "q-2",
        page_number: 4,
        prompt: "Bé Bông cảm thấy thế nào sau chuyến đi?",
        choices: ["Tự tin và vui vẻ", "Buồn bã", "Lo lắng", "Giận dỗi"],
        correct_answer: "Tự tin và vui vẻ",
        difficulty: "EASY",
      },
    ],
    quota: {
      child_id: SAMPLE_CHILD.id,
      daily_limit: 2,
      used_today: 1,
      remaining_today: 1,
      quota_exceeded: false,
      resets_at_utc: "2026-11-29T00:00:00Z",
    },
  };
}

describe("CreateMicroStoryModal", () => {
  it("loads preview words, displays remaining daily quota, and supports toggling & adding custom words", async () => {
    const service: MicroStoryService = {
      getQuota: vi.fn(),
      previewWords: vi.fn().mockResolvedValue(makePreviewPayload()),
      generateStory: vi.fn().mockResolvedValue(makeCreatedResponse()),
    };

    render(
      <CreateMicroStoryModal
        child={SAMPLE_CHILD}
        isOpen
        onClose={vi.fn()}
        service={service}
      />,
    );

    expect(
      await screen.findByTestId("micro-story-quota-badge"),
    ).toHaveTextContent("2/2");
    expect(screen.getByTestId("micro-story-selected-count")).toHaveTextContent(
      "4/5",
    );
    expect(screen.getByText("lung linh")).toBeInTheDocument();
    expect(screen.getByText("xinh xắn")).toBeInTheDocument();

    // Toggle off 1 word -> 3/5 selected
    fireEvent.click(screen.getByTestId("micro-story-word-chip-chim sẻ"));
    expect(screen.getByTestId("micro-story-selected-count")).toHaveTextContent(
      "3/5",
    );

    // Cannot toggle below minimum 3 words
    fireEvent.click(screen.getByTestId("micro-story-word-chip-rộn ràng"));
    expect(screen.getByTestId("micro-story-selected-count")).toHaveTextContent(
      "3/5",
    );

    // Add a custom Vietnamese word -> 4/5 selected
    const customInput = screen.getByLabelText(/Thêm từ muốn bé luyện đọc/i);
    fireEvent.change(customInput, { target: { value: "trong trẻo" } });
    fireEvent.keyDown(customInput, { key: "Enter" });

    expect(screen.getByTestId("micro-story-selected-count")).toHaveTextContent(
      "4/5",
    );
    expect(screen.getByText("trong trẻo")).toBeInTheDocument();
  });

  it("disables generation and shows friendly notice when daily quota is exceeded", async () => {
    const service: MicroStoryService = {
      getQuota: vi.fn(),
      previewWords: vi.fn().mockResolvedValue(
        makePreviewPayload({
          quota: {
            child_id: SAMPLE_CHILD.id,
            daily_limit: 2,
            used_today: 2,
            remaining_today: 0,
            quota_exceeded: true,
            resets_at_utc: "2026-11-29T00:00:00Z",
          },
        }),
      ),
      generateStory: vi.fn(),
    };

    render(
      <CreateMicroStoryModal
        child={SAMPLE_CHILD}
        isOpen
        onClose={vi.fn()}
        service={service}
      />,
    );

    expect(
      await screen.findByText(
        /Hôm nay bé đã tạo đủ số truyện tranh mini miễn phí/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("generate-micro-story-submit")).toBeDisabled();
    expect(service.generateStory).not.toHaveBeenCalled();
  });

  it("shows progress during generation and renders 1-click open-book link upon completion", async () => {
    let resolveGenerate!: (val: MicroStoryGenerateResponseDTO) => void;
    const generatePromise = new Promise<MicroStoryGenerateResponseDTO>(
      (resolve) => {
        resolveGenerate = resolve;
      },
    );

    const onStoryCreated = vi.fn();
    const service: MicroStoryService = {
      getQuota: vi.fn(),
      previewWords: vi.fn().mockResolvedValue(makePreviewPayload()),
      generateStory: vi.fn().mockReturnValue(generatePromise),
    };

    render(
      <CreateMicroStoryModal
        child={SAMPLE_CHILD}
        isOpen
        onClose={vi.fn()}
        onStoryCreated={onStoryCreated}
        service={service}
      />,
    );

    const submitBtn = await screen.findByTestId("generate-micro-story-submit");
    const themeInput = screen.getByLabelText(/Chủ đề câu chuyện yêu thích/i);
    fireEvent.change(themeInput, {
      target: { value: "Khu vườn mùa xuân của mèo con" },
    });
    fireEvent.click(submitBtn);

    // Progress bar appears while generating
    expect(
      await screen.findByTestId("micro-story-generating-progress"),
    ).toBeInTheDocument();
    expect(service.generateStory).toHaveBeenCalledWith(SAMPLE_CHILD.id, {
      selected_words: ["lung linh", "xinh xắn", "rộn ràng", "chim sẻ"],
      theme_hint: "Khu vườn mùa xuân của mèo con",
    });

    // Resolve generation -> renders 4-page created summary + 1-click reader href
    resolveGenerate(makeCreatedResponse());

    const openLink = await screen.findByTestId("open-created-micro-story-link");
    expect(openLink).toHaveAttribute("href", "/books/book-story-99");
    expect(
      screen.getByText("Hành trình lung linh của Bé Bông"),
    ).toBeInTheDocument();
    expect(onStoryCreated).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId("micro-story-quota-badge")).toHaveTextContent(
        "1/2",
      );
    });
  });

  it("handles 429 quota error during generate gracefully", async () => {
    const service: MicroStoryService = {
      getQuota: vi.fn(),
      previewWords: vi.fn().mockResolvedValue(makePreviewPayload()),
      generateStory: vi.fn().mockRejectedValue(
        new ServiceError({
          code: "STT_RATE_LIMITED",
          message: "Quota exceeded",
          status: 429,
          request_id: "req-429",
          retryable: false,
        }),
      ),
    };

    render(
      <CreateMicroStoryModal
        child={SAMPLE_CHILD}
        isOpen
        onClose={vi.fn()}
        service={service}
      />,
    );

    const submitBtn = await screen.findByTestId("generate-micro-story-submit");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByTestId("generate-micro-story-submit")).toBeDisabled();
    });
  });

  it("displays child-safety message when 422 CHILD_SAFETY_REJECTED is returned", async () => {
    const safetyMessage =
      "Từ ngữ hoặc chủ đề gợi ý chưa phù hợp với tiêu chuẩn an toàn trẻ em tiểu học. Ba mẹ vui lòng chỉnh lại nhé.";
    const service: MicroStoryService = {
      getQuota: vi.fn(),
      previewWords: vi.fn().mockResolvedValue(makePreviewPayload()),
      generateStory: vi
        .fn()
        .mockRejectedValueOnce(
          new ServiceError({
            code: "VALIDATION_ERROR",
            message: safetyMessage,
            status: 422,
            request_id: "req-422-safety",
            retryable: false,
          }),
        )
        .mockRejectedValueOnce(
          new ServiceError({
            code: "VALIDATION_ERROR",
            message: "Có lỗi xảy ra. Vui lòng thử lại sau.",
            status: 422,
            request_id: "req-422-generic",
            retryable: false,
          }),
        ),
    };

    render(
      <CreateMicroStoryModal
        child={SAMPLE_CHILD}
        isOpen
        onClose={vi.fn()}
        service={service}
      />,
    );

    const submitBtn = await screen.findByTestId("generate-micro-story-submit");
    fireEvent.click(submitBtn);

    expect(await screen.findByText(safetyMessage)).toBeInTheDocument();

    // Generic 422 message falls back to localized errorSafetyRejected
    fireEvent.click(screen.getByTestId("generate-micro-story-submit"));
    await waitFor(() => {
      expect(service.generateStory).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText(safetyMessage)).toBeInTheDocument();
  });

  it("submits custom word and theme hint cleanly and syncs when child prop changes", async () => {
    const secondChild: ChildProfileDTO = {
      ...SAMPLE_CHILD,
      id: "child-minh-2",
      alias: "Bé Minh",
      grade: 3,
    };

    const previewWords = vi
      .fn()
      .mockResolvedValueOnce(makePreviewPayload())
      .mockResolvedValueOnce(
        makePreviewPayload({
          child_id: secondChild.id,
          child_alias: secondChild.alias,
          child_grade: secondChild.grade,
        }),
      );

    const generateStory = vi.fn().mockResolvedValue(makeCreatedResponse());
    const service: MicroStoryService = {
      getQuota: vi.fn(),
      previewWords,
      generateStory,
    };

    const { rerender } = render(
      <CreateMicroStoryModal
        child={SAMPLE_CHILD}
        childrenProfiles={[SAMPLE_CHILD, secondChild]}
        isOpen
        onClose={vi.fn()}
        service={service}
      />,
    );

    await screen.findByTestId("micro-story-quota-badge");

    // Switching explicit child prop updates active child & triggers new preview
    rerender(
      <CreateMicroStoryModal
        child={secondChild}
        childrenProfiles={[SAMPLE_CHILD, secondChild]}
        isOpen
        onClose={vi.fn()}
        service={service}
      />,
    );

    await waitFor(() => {
      expect(previewWords).toHaveBeenCalledWith(
        secondChild.id,
        expect.any(AbortSignal),
      );
    });

    // Add a custom word (replaces last default when 5 words would be exceeded -> stays <= 5)
    const customInput = screen.getByLabelText(/Thêm từ muốn bé luyện đọc/i);
    fireEvent.change(customInput, { target: { value: "óng ánh" } });
    fireEvent.click(screen.getByRole("button", { name: /Thêm từ/i }));

    const themeInput = screen.getByLabelText(/Chủ đề câu chuyện yêu thích/i);
    fireEvent.change(themeInput, {
      target: { value: "  Buổi sáng bên hồ sen  " },
    });

    fireEvent.click(screen.getByTestId("generate-micro-story-submit"));

    await waitFor(() => {
      expect(generateStory).toHaveBeenCalledWith(secondChild.id, {
        selected_words: [
          "lung linh",
          "xinh xắn",
          "rộn ràng",
          "chim sẻ",
          "óng ánh",
        ],
        theme_hint: "Buổi sáng bên hồ sen",
      });
    });

    expect(
      await screen.findByTestId("open-created-micro-story-link"),
    ).toBeInTheDocument();
  });
});
