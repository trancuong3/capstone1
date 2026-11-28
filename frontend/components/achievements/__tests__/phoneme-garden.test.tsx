import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AchievementsScreen } from "@/components/achievements/achievements-screen";
import { BookStampPassportModal } from "@/components/achievements/book-stamp-passport-modal";
import { PhonemeGardenCard } from "@/components/achievements/phoneme-garden-card";
import {
  PhonemeGardenSummarySchema,
  type PhonemeGardenService,
  type PhonemeGardenSummaryDTO,
} from "@/lib/api/phoneme-garden-service";
import {
  phonemeGardenEn,
  phonemeGardenVi,
} from "@/messages/features/phoneme_garden_messages";
import type { ChildProfileDTO } from "@/types/child";

const CHILD_A: ChildProfileDTO = {
  id: "00000000-0000-0000-0000-000000000011",
  parent_id: "00000000-0000-0000-0000-000000000001",
  alias: "Bé Mây",
  grade: 2,
  settings: {},
  created_at: "2026-11-28T07:00:00Z",
};

const CHILD_B: ChildProfileDTO = {
  id: "00000000-0000-0000-0000-000000000022",
  parent_id: "00000000-0000-0000-0000-000000000001",
  alias: "Anh Khôi",
  grade: 4,
  settings: {},
  created_at: "2026-11-28T07:00:00Z",
};

const MOCK_GARDEN_SUMMARY: PhonemeGardenSummaryDTO = {
  visibility: "PARENT_PRIVATE",
  child_id: CHILD_A.id,
  child_alias: "Bé Mây",
  child_grade: 2,
  beds: [
    {
      bed_key: "l_n",
      phonics_label_vi: "Âm đầu l / n",
      plant_name_vi: "Hoa Sen",
      plant_symbol: "lotus",
      stage: "BLOOM",
      stage_index: 3,
      practiced_words_count: 3,
      mastered_words_count: 3,
      mastered_words: ["lúa", "nắng", "lá"],
      practiced_words: ["lúa", "nắng", "lá"],
      next_stage: null,
      words_to_next_stage: 0,
      encouragement_vi:
        "Hoa Sen đã nở hoa rực rỡ trong khu vườn riêng của con.",
    },
    {
      bed_key: "s_x",
      phonics_label_vi: "Âm đầu s / x",
      plant_name_vi: "Hoa Mai",
      plant_symbol: "apricot",
      stage: "BUD",
      stage_index: 2,
      practiced_words_count: 2,
      mastered_words_count: 2,
      mastered_words: ["sáo", "xanh"],
      practiced_words: ["sáo", "xanh"],
      next_stage: "BLOOM",
      words_to_next_stage: 1,
      encouragement_vi: "Hoa Mai đã kết nụ tròn xinh với 2 từ vững vàng.",
    },
    {
      bed_key: "tr_ch",
      phonics_label_vi: "Âm đầu tr / ch",
      plant_name_vi: "Tre Xanh",
      plant_symbol: "bamboo",
      stage: "SPROUT",
      stage_index: 1,
      practiced_words_count: 1,
      mastered_words_count: 1,
      mastered_words: ["chim"],
      practiced_words: ["chim"],
      next_stage: "BUD",
      words_to_next_stage: 1,
      encouragement_vi: "Tre Xanh đã nhú mầm non xanh mát!",
    },
    {
      bed_key: "r_d_gi",
      phonics_label_vi: "Âm đầu r / d / gi",
      plant_name_vi: "Hoa Hướng Dương",
      plant_symbol: "sunflower",
      stage: "SEED",
      stage_index: 0,
      practiced_words_count: 0,
      mastered_words_count: 0,
      mastered_words: [],
      practiced_words: [],
      next_stage: "SPROUT",
      words_to_next_stage: 1,
      encouragement_vi: "Luống Hoa Hướng Dương đang ủ hạt giống êm đềm.",
    },
    {
      bed_key: "hoi_nga",
      phonics_label_vi: "Thanh hỏi / ngã",
      plant_name_vi: "Hoa Cúc",
      plant_symbol: "chrysanthemum",
      stage: "SEED",
      stage_index: 0,
      practiced_words_count: 0,
      mastered_words_count: 0,
      mastered_words: [],
      practiced_words: [],
      next_stage: "SPROUT",
      words_to_next_stage: 1,
      encouragement_vi: "Luống Hoa Cúc đang ủ hạt giống êm đềm.",
    },
    {
      bed_key: "coda_n_ng_t_c",
      phonics_label_vi: "Vần cuối n/ng · t/c",
      plant_name_vi: "Hoa Đào",
      plant_symbol: "peach",
      stage: "SPROUT",
      stage_index: 1,
      practiced_words_count: 1,
      mastered_words_count: 1,
      mastered_words: ["mát"],
      practiced_words: ["mát"],
      next_stage: "BUD",
      words_to_next_stage: 1,
      encouragement_vi: "Hoa Đào đã nhú mầm non xanh mát!",
    },
    {
      bed_key: "compound_reduplicative",
      phonics_label_vi: "Từ ghép & từ láy",
      plant_name_vi: "Hoa Phượng",
      plant_symbol: "flamboyant",
      stage: "BUD",
      stage_index: 2,
      practiced_words_count: 2,
      mastered_words_count: 2,
      mastered_words: ["lung linh", "rộn ràng"],
      practiced_words: ["lung linh", "rộn ràng"],
      next_stage: "BLOOM",
      words_to_next_stage: 1,
      encouragement_vi: "Hoa Phượng đã kết nụ tròn xinh.",
    },
  ],
  book_stamps: [
    {
      stamp_key: "book-10000000-0000-0000-0000-000000000001",
      book_id: "10000000-0000-0000-0000-000000000001",
      book_title: "Dế Mèn Phiêu Lưu Ký",
      completed_at: "2026-11-10T09:30:00Z",
      completed_sessions_count: 3,
      motif: "LOTUS_SEAL",
    },
    {
      stamp_key: "book-10000000-0000-0000-0000-000000000002",
      book_id: "10000000-0000-0000-0000-000000000002",
      book_title: "Bông Sen Trắng Mùa Hạ",
      completed_at: "2026-11-18T14:00:00Z",
      completed_sessions_count: 1,
      motif: "BAMBOO_SCROLL",
    },
  ],
  milestone_stamps: [
    {
      stamp_key: "first_session",
      category: "CALM_CYCLE",
      title_vi: "Buổi Đọc Đầu Tiên",
      description_vi: "Kỷ niệm buổi đọc sách trọn vẹn đầu tiên của con.",
      unlocked: true,
      progress_current: 1,
      progress_target: 1,
      unlocked_at: "2026-11-10T09:30:00Z",
    },
    {
      stamp_key: "five_sessions",
      category: "CALM_CYCLE",
      title_vi: "5 Buổi Đọc Tích Lũy",
      description_vi: "Đủ 5 buổi đọc cộng dồn theo nhịp riêng.",
      unlocked: false,
      progress_current: 4,
      progress_target: 5,
      unlocked_at: null,
    },
    {
      stamp_key: "ten_sessions",
      category: "CALM_CYCLE",
      title_vi: "10 Buổi Đọc Bền Bỉ",
      description_vi: "Đủ 10 buổi đọc ấm áp cùng sách.",
      unlocked: false,
      progress_current: 4,
      progress_target: 10,
      unlocked_at: null,
    },
    {
      stamp_key: "first_mastered_bed",
      category: "PHONEME_BLOOM",
      title_vi: "Luống Hoa Âm Vị Đầu Tiên Nở Rộ",
      description_vi: "Một nhóm âm vị tiếng Việt đã nở hoa rực rỡ.",
      unlocked: true,
      progress_current: 1,
      progress_target: 1,
      unlocked_at: "2026-11-20T08:00:00Z",
    },
  ],
  bloomed_beds_count: 1,
  total_practiced_words: 9,
  total_mastered_words: 9,
  total_completed_books: 2,
  total_completed_sessions: 4,
  unlocked_milestone_stamps_count: 2,
  gentle_message_vi:
    "Bé Mây đã chăm tưới thành thạo 9 từ tiếng Việt — từng luống hoa cứ thế lớn dần theo nhịp riêng của con.",
  calm_pedagogy_note_vi:
    "Vườn chữ và sổ tem chỉ lớn dần theo từng tiếng bé đọc và từng cuốn sách hoàn thành.",
};

describe("Feature #7: 7-Bed Vietnamese Phoneme Garden & Book Stamp Passport", () => {
  it("keeps phoneme_garden_messages.ts pure server-safe with 100% VI/EN parity", () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const messagesPath = path.resolve(
      currentDir,
      "../../../messages/features/phoneme_garden_messages.ts",
    );
    const rawSource = fs.readFileSync(messagesPath, "utf8");
    expect(rawSource).not.toContain('"use client"');
    expect(rawSource).not.toContain("'use client'");
    expect(Object.keys(phonemeGardenVi).sort()).toEqual(
      Object.keys(phonemeGardenEn).sort(),
    );
  });

  it("validates exact backend contract via Zod v4 PhonemeGardenSummarySchema", () => {
    const parsed = PhonemeGardenSummarySchema.parse(MOCK_GARDEN_SUMMARY);
    expect(parsed.visibility).toBe("PARENT_PRIVATE");
    expect(parsed.beds).toHaveLength(7);
    expect(parsed.book_stamps).toHaveLength(2);
    expect(parsed.milestone_stamps).toHaveLength(4);
  });

  it("renders all 7 Vietnamese phoneme beds, stages, mastered words, and calm non-wilting notice", () => {
    const onOpenPassport = vi.fn();
    render(
      <PhonemeGardenCard
        onViewPassport={onOpenPassport}
        summary={MOCK_GARDEN_SUMMARY}
      />,
    );

    expect(screen.getByTestId("phoneme-garden-card")).toBeInTheDocument();
    expect(screen.getByText("Hoa Sen")).toBeInTheDocument();
    expect(screen.getByText("Hoa Mai")).toBeInTheDocument();
    expect(screen.getByText("Tre Xanh")).toBeInTheDocument();
    expect(screen.getByText("Hoa Hướng Dương")).toBeInTheDocument();
    expect(screen.getByText("Hoa Cúc")).toBeInTheDocument();
    expect(screen.getByText("Hoa Đào")).toBeInTheDocument();
    expect(screen.getByText("Hoa Phượng")).toBeInTheDocument();

    expect(screen.getByTestId("phoneme-bed-stage-l_n")).toHaveTextContent(
      "Nở hoa",
    );
    expect(screen.getByTestId("phoneme-bed-stage-s_x")).toHaveTextContent(
      "Kết nụ",
    );
    expect(screen.getByTestId("phoneme-bed-stage-tr_ch")).toHaveTextContent(
      "Nảy mầm",
    );
    expect(screen.getByTestId("phoneme-bed-stage-r_d_gi")).toHaveTextContent(
      "Hạt giống",
    );

    // Mastered words per bed are visible
    expect(screen.getByText("lúa")).toBeInTheDocument();
    expect(screen.getByText("lung linh")).toBeInTheDocument();

    // Opening passport button works
    fireEvent.click(screen.getByTestId("open-book-stamp-passport-btn"));
    expect(onOpenPassport).toHaveBeenCalledTimes(1);
  });

  it("renders BookStampPassportModal with deduplicated book stamps, milestones, and Escape close", () => {
    const onClose = vi.fn();
    render(
      <BookStampPassportModal
        onClose={onClose}
        summary={MOCK_GARDEN_SUMMARY}
      />,
    );

    expect(screen.getByTestId("book-stamp-passport-modal")).toBeInTheDocument();
    expect(screen.getByText("Dế Mèn Phiêu Lưu Ký")).toBeInTheDocument();
    expect(screen.getByText("3 lần đọc trọn vẹn")).toBeInTheDocument();
    expect(screen.getByText("Bông Sen Trắng Mùa Hạ")).toBeInTheDocument();

    expect(screen.getByTestId("milestone-stamp-first_session")).toHaveAttribute(
      "data-milestone-unlocked",
      "true",
    );
    expect(screen.getByTestId("milestone-stamp-five_sessions")).toHaveAttribute(
      "data-milestone-unlocked",
      "false",
    );
    expect(
      screen.getByTestId("milestone-stamp-first_mastered_bed"),
    ).toHaveAttribute("data-milestone-unlocked", "true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("loads child garden in AchievementsScreen, opens stamp modal, and switches child profiles cleanly", async () => {
    const list = vi.fn().mockResolvedValue([CHILD_A, CHILD_B]);
    const getChildSummary = vi
      .fn<PhonemeGardenService["getChildSummary"]>()
      .mockImplementation(async (childId: string) => ({
        ...MOCK_GARDEN_SUMMARY,
        child_id: childId,
        child_alias: childId === CHILD_B.id ? "Anh Khôi" : "Bé Mây",
      }));

    render(
      <AchievementsScreen
        childService={{ list }}
        gardenService={{ getChildSummary }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("phoneme-garden-card")).toBeInTheDocument();
    });
    expect(getChildSummary).toHaveBeenCalledWith(
      CHILD_A.id,
      expect.any(AbortSignal),
    );

    // Open and close passport modal
    fireEvent.click(screen.getByTestId("open-book-stamp-passport-btn"));
    expect(screen.getByTestId("book-stamp-passport-modal")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("close-book-stamp-passport-btn"));
    expect(
      screen.queryByTestId("book-stamp-passport-modal"),
    ).not.toBeInTheDocument();

    // Switch child selector to CHILD_B
    fireEvent.change(screen.getByTestId("achievements-child-selector"), {
      target: { value: CHILD_B.id },
    });

    await waitFor(() => {
      expect(getChildSummary).toHaveBeenCalledWith(
        CHILD_B.id,
        expect.any(AbortSignal),
      );
    });
  });
});
