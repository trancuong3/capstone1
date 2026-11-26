import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SmartOcrBlockReview } from "@/components/admin/smart-ocr-block-review";
import type { PageOcrExtractionDTO } from "@/types/ocr-extraction";

function makeFixtureExtraction(
  overrides: Partial<PageOcrExtractionDTO> = {},
): PageOcrExtractionDTO {
  return {
    extraction_id: "11111111-1111-4111-8111-111111111111",
    book_id: "22222222-2222-4222-8222-222222222222",
    book_page_id: "33333333-3333-4333-8333-333333333333",
    page_revision_id: "44444444-4444-4444-8444-444444444444",
    source_hash: "a".repeat(64),
    algorithm_version: "v2.0",
    filter_mode: "active",
    page_kind: "TEXT_AND_IMAGE",
    geometry_transform: {
      image_width: 1000,
      image_height: 1400,
      boundary_quad_norm: [
        [0.05, 0.05],
        [0.95, 0.05],
        [0.95, 0.95],
        [0.05, 0.95],
      ],
      boundary_quad_px: [
        [50, 70],
        [950, 70],
        [950, 1330],
        [50, 1330],
      ],
      boundary_bbox_norm: [0.05, 0.05, 0.9, 0.9],
      area_ratio: 0.81,
      confidence: 0.65,
      deskew_angle_deg: 1.5,
      auto_crop: false,
      requires_crop_review: true,
      clips_margin_text: false,
      transform_matrix: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      inverse_transform_matrix: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      output_width: 1000,
      output_height: 1400,
      gutter: {
        is_double_page: false,
        gutter_x_norm: null,
        confidence: 0.1,
        crossing_line_count: 0,
        split_recommended: false,
        reason_vi: "Trang đơn — không phát hiện nếp gấp gáy sách.",
      },
      lighting_profile: "NORMAL",
      processing_ms: 14.2,
      reason_vi:
        "Độ chắc chắn viền trang chưa đạt ngưỡng an toàn — giữ nguyên ảnh gốc để xác minh.",
    },
    blocks: [
      {
        block_id: "blk-0001",
        raw_text: "CHÚ MÈO NHỎ",
        display_text: "CHÚ MÈO NHỎ",
        bbox: [0.25, 0.12, 0.5, 0.05],
        reading_order: 0,
        column_index: 0,
        line_indices: [0],
        word_ids: ["w-0", "w-1", "w-2"],
        source_word_indices: [0, 1, 2],
        block_type: "MAIN_TITLE",
        decision: "KEEP",
        auto_decision: "KEEP",
        reason_vi: "Tiêu đề chính của trang truyện.",
        reason_code: "MAIN_TITLE",
        decision_source: "GEOMETRIC",
        confidence: 0.95,
        user_override: false,
        edited_text: null,
        cross_page_matches: [],
        in_canonical: true,
        audit_trail: [],
      },
      {
        block_id: "blk-0002",
        raw_text: "Bé có 2 quả táo chín đỏ trên bàn.",
        display_text: "Bé có 2 quả táo chín đỏ trên bàn.",
        bbox: [0.12, 0.25, 0.72, 0.04],
        reading_order: 1,
        column_index: 0,
        line_indices: [1],
        word_ids: ["w-3", "w-4", "w-5", "w-6", "w-7", "w-8", "w-9", "w-10"],
        source_word_indices: [3, 4, 5, 6, 7, 8, 9, 10],
        block_type: "STORY_BODY",
        decision: "KEEP",
        auto_decision: "KEEP",
        reason_vi: "Nội dung bài đọc chính.",
        reason_code: "STORY_BODY",
        decision_source: "GEOMETRIC",
        confidence: 0.94,
        user_override: false,
        edited_text: null,
        cross_page_matches: [],
        in_canonical: true,
        audit_trail: [],
      },
      {
        block_id: "blk-0003",
        raw_text: "I",
        display_text: "I",
        bbox: [0.48, 0.04, 0.03, 0.025],
        reading_order: 2,
        column_index: 0,
        line_indices: [2],
        word_ids: ["w-11"],
        source_word_indices: [11],
        block_type: "PAGE_NUMBER",
        decision: "REVIEW",
        auto_decision: "REVIEW",
        reason_vi:
          "Chưa chắc chắn đây là chú thích hay nội dung chính — mời xác minh.",
        reason_code: "PAGE_NUMBER_SINGLE_ROMAN_REVIEW",
        decision_source: "GEOMETRIC",
        confidence: 0.62,
        user_override: false,
        edited_text: null,
        cross_page_matches: [],
        in_canonical: true,
        audit_trail: [],
      },
      {
        block_id: "blk-0004",
        raw_text: "26",
        display_text: "26",
        bbox: [0.48, 0.94, 0.05, 0.025],
        reading_order: 3,
        column_index: 0,
        line_indices: [3],
        word_ids: ["w-12"],
        source_word_indices: [12],
        block_type: "PAGE_NUMBER",
        decision: "EXCLUDE",
        auto_decision: "EXCLUDE",
        reason_vi: "Số trang — không thuộc bài đọc.",
        reason_code: "PAGE_NUMBER_ARABIC",
        decision_source: "GEOMETRIC",
        confidence: 0.96,
        user_override: false,
        edited_text: null,
        cross_page_matches: [],
        in_canonical: false,
        audit_trail: [],
      },
    ],
    canonical_text: "CHÚ MÈO NHỎ\nBé có 2 quả táo chín đỏ trên bàn.\nI",
    canonical_words: [],
    stats: {
      total_blocks: 4,
      keep_blocks: 2,
      exclude_blocks: 1,
      review_blocks: 1,
      total_chars: 47,
      kept_chars: 44,
      excluded_chars: 2,
      review_chars: 1,
      retention_ratio: 0.9574,
      circuit_breaker_triggered: false,
      fast_path_ms: 4.5,
      cross_page_ms: 0.4,
      semantic_ai_ms: 0,
      total_ms: 5.1,
      semantic_ai_invoked: false,
      semantic_ai_fallback_used: false,
      semantic_ai_error_code: null,
    },
    requires_review: true,
    undo_available: false,
    undo_depth: 0,
    persisted: false,
    storage_degraded: false,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

describe("SmartOcrBlockReview", () => {
  it("renders all 5 Vietnamese view tabs and shows Vietnamese reasons per block", async () => {
    const user = userEvent.setup();
    render(
      <SmartOcrBlockReview
        extraction={makeFixtureExtraction()}
        pageImageUrl="https://example.test/page-26.png"
        pageNumber={26}
      />,
    );

    expect(screen.getByRole("tab", { name: /Ảnh gốc/i })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /Nội dung sạch/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /Phần bị loại/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /Phần cần xác minh/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /Xem trước bài đọc/i }),
    ).toBeInTheDocument();

    // Starts on "Phần cần xác minh" when review_blocks > 0
    expect(
      screen.getByText(
        "Chưa chắc chắn đây là chú thích hay nội dung chính — mời xác minh.",
      ),
    ).toBeInTheDocument();

    // Crop review notice shown
    expect(
      screen.getByText("Giữ nguyên khung ảnh gốc để tránh cắt mất chữ"),
    ).toBeInTheDocument();

    // Switch to Ảnh gốc
    await user.click(screen.getByRole("tab", { name: /Ảnh gốc/i }));
    expect(
      screen.getByRole("img", { name: "Ảnh gốc trang 26" }),
    ).toBeInTheDocument();

    // Switch to Phần bị loại
    await user.click(screen.getByRole("tab", { name: /Phần bị loại/i }));
    expect(
      screen.getByText("Số trang — không thuộc bài đọc."),
    ).toBeInTheDocument();

    // Switch to Xem trước bài đọc
    await user.click(screen.getByRole("tab", { name: /Xem trước bài đọc/i }));
    expect(screen.getByTestId("canonical-reading-preview")).toHaveTextContent(
      "CHÚ MÈO NHỎ",
    );
    expect(screen.getByTestId("canonical-reading-preview")).toHaveTextContent(
      "Bé có 2 quả táo chín đỏ trên bàn.",
    );
  });

  it("batch 'Chấp nhận các khối rõ ràng' NEVER bypasses REVIEW blocks", async () => {
    const user = userEvent.setup();
    render(<SmartOcrBlockReview extraction={makeFixtureExtraction()} />);

    await user.click(
      screen.getByRole("button", { name: /Chấp nhận các khối rõ ràng/i }),
    );

    // Must explicitly inform user that 1 REVIEW block still needs manual verification
    expect(
      screen.getByText(/Vẫn còn 1 khối cần bạn xác minh thủ công/i),
    ).toBeInTheDocument();

    // REVIEW block MUST remain in "Phần cần xác minh"
    const reviewTab = screen.getByRole("tab", { name: /Phần cần xác minh/i });
    expect(reviewTab).toHaveTextContent("1");
    expect(
      screen.getByText(
        "Chưa chắc chắn đây là chú thích hay nội dung chính — mời xác minh.",
      ),
    ).toBeInTheDocument();
  });

  it("supports Keep, Exclude, Restore, Edit, and Undo stack updating reading preview", async () => {
    const user = userEvent.setup();
    render(<SmartOcrBlockReview extraction={makeFixtureExtraction()} />);

    const undoButton = screen.getByRole("button", { name: /Hoàn tác/i });
    expect(undoButton).toBeDisabled();

    // 1. Restore excluded page number "26"
    await user.click(screen.getByRole("tab", { name: /Phần bị loại/i }));
    await user.click(screen.getByRole("button", { name: /Khôi phục/i }));
    expect(undoButton).toBeEnabled();

    await user.click(screen.getByRole("tab", { name: /Xem trước bài đọc/i }));
    expect(screen.getByTestId("canonical-reading-preview")).toHaveTextContent(
      "26",
    );

    // 2. Undo restores exclusion of "26"
    await user.click(undoButton);
    expect(
      screen.getByTestId("canonical-reading-preview"),
    ).not.toHaveTextContent("26");

    // 3. Exclude REVIEW block from "Phần cần xác minh"
    await user.click(screen.getByRole("tab", { name: /Phần cần xác minh/i }));
    await user.click(screen.getByRole("button", { name: /Loại bỏ/i }));
    expect(
      screen.getByText("Không còn khối nào cần xác minh thêm trên trang này."),
    ).toBeInTheDocument();

    // 4. Edit a block in "Nội dung sạch"
    await user.click(screen.getByRole("tab", { name: /Nội dung sạch/i }));
    const storyCard = screen
      .getByText("Bé có 2 quả táo chín đỏ trên bàn.")
      .closest("article");
    expect(storyCard).not.toBeNull();
    await user.click(
      within(storyCard as HTMLElement).getByRole("button", {
        name: /Sửa chữ/i,
      }),
    );
    const textarea = screen.getByLabelText("Chỉnh sửa chữ của khối");
    await user.clear(textarea);
    await user.type(textarea, "Bé có 3 quả táo chín đỏ.");
    await user.click(screen.getByRole("button", { name: /Lưu sửa/i }));

    await user.click(screen.getByRole("tab", { name: /Xem trước bài đọc/i }));
    expect(screen.getByTestId("canonical-reading-preview")).toHaveTextContent(
      "Bé có 3 quả táo chín đỏ.",
    );

    // 5. Undo reverts the edit back to original text
    await user.click(screen.getByRole("button", { name: /Hoàn tác/i }));
    expect(screen.getByTestId("canonical-reading-preview")).toHaveTextContent(
      "Bé có 2 quả táo chín đỏ trên bàn.",
    );
  });

  it("displays circuit breaker safety warning and delegates mutations to onPatchBlocks", async () => {
    const user = userEvent.setup();
    const initial = makeFixtureExtraction({
      stats: {
        ...makeFixtureExtraction().stats,
        circuit_breaker_triggered: true,
      },
    });
    const onPatchBlocks = vi.fn().mockResolvedValue({
      ...initial,
      undo_available: true,
      undo_depth: 1,
    });

    render(
      <SmartOcrBlockReview
        extraction={initial}
        onPatchBlocks={onPatchBlocks}
      />,
    );

    expect(
      screen.getByText("Đã bật cơ chế bảo vệ chống mất nội dung"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Giữ lại/i }));
    expect(onPatchBlocks).toHaveBeenCalledWith({
      actions: [{ block_id: "blk-0003", action: "KEEP" }],
    });
  });
});
