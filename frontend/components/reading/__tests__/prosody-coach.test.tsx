import fs from "node:fs";
import path from "node:path";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ProsodyAssessmentCard } from "@/components/reading/prosody-assessment-card";
import { ProsodyBreathingCuesBar } from "@/components/reading/prosody-breathing-cues-bar";
import { SessionComplete } from "@/components/reading/session-complete";
import * as prosodyService from "@/lib/api/fluency-prosody-service";
import {
  AnnotateCuesResponseSchema,
  ProsodyAnalysisResponseSchema,
  annotateBreathingCuesLocal,
} from "@/lib/api/fluency-prosody-service";
import {
  childFixture,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";

const SAMPLE_PROSODY_RESPONSE: prosodyService.ProsodyAnalysisResponse = {
  child_id: childFixture.id,
  session_id: TEST_SESSION_ID,
  visibility_scope: "PARENT_PRIVATE",
  comma_pause_score: 91.5,
  period_pause_score: 94.0,
  intonation_contour_score: 88.2,
  overall_prosody_score: 91.2,
  grade_band_verdict: "EXCELLENT",
  coaching_tip_vi:
    "Tuyệt vời lắm! Con biết nghỉ hơi nhẹ ở dấu phẩy (•), dừng rõ ở dấu chấm (••) và đọc rất truyền cảm!",
  clauses: [
    {
      clause_index: 0,
      clause_text: "Mẹ ơi,",
      start_word_idx: 0,
      end_word_idx: 2,
      start_ms: 0,
      end_ms: 460,
      terminal_punct: ",",
      punctuation_kind: "COMMA",
      observed_pause_ms: 225,
      relative_pause_ratio: 4.1,
      expected_pause_ratio: 1.6,
      pause_score: 96,
      terminal_f0_delta_semitones: -0.8,
      intonation_score: 86,
    },
    {
      clause_index: 1,
      clause_text: "hôm nay con vui không?",
      start_word_idx: 2,
      end_word_idx: 7,
      start_ms: 685,
      end_ms: 1920,
      terminal_punct: "?",
      punctuation_kind: "QUESTION",
      observed_pause_ms: 420,
      relative_pause_ratio: 7.6,
      expected_pause_ratio: 2.5,
      pause_score: 95,
      terminal_f0_delta_semitones: 3.4,
      intonation_score: 92,
    },
  ],
  median_inter_word_gap_ms: 55,
  noise_floor_rms: 0.0082,
  audio_analyzed: true,
  model_version: "feat5-dsp-v1",
  persisted: true,
};

describe("Feature #5 Prosody Coach & Breathing Cues", () => {
  it("keeps prosody_coach_messages.ts strictly server-safe without use client or React hooks", () => {
    const messagesFile = path.resolve(
      process.cwd(),
      "messages/features/prosody_coach_messages.ts",
    );
    const raw = fs.readFileSync(messagesFile, "utf8");
    expect(raw).not.toContain('"use client"');
    expect(raw).not.toContain("'use client'");
    expect(raw).not.toMatch(/from\s+["']react["']/);
  });

  it("annotates Vietnamese punctuation breathing cues deterministically and validates Zod schemas", () => {
    const annotated = annotateBreathingCuesLocal(
      "Hôm nay, trời nắng đẹp. Con có vui không? Thật tuyệt vời!",
    );
    const parsedCues = AnnotateCuesResponseSchema.parse(annotated);
    expect(parsedCues.annotated_text).toBe(
      "Hôm nay, • trời nắng đẹp. •• Con có vui không? ↗ Thật tuyệt vời! ✦",
    );
    expect(parsedCues.cue_counts["•"]).toBe(1);
    expect(parsedCues.cue_counts["••"]).toBe(1);
    expect(parsedCues.cue_counts["↗"]).toBe(1);
    expect(parsedCues.cue_counts["✦"]).toBe(1);

    const parsedAnalysis = ProsodyAnalysisResponseSchema.parse(
      SAMPLE_PROSODY_RESPONSE,
    );
    expect(parsedAnalysis.grade_band_verdict).toBe("EXCELLENT");
    expect(parsedAnalysis.visibility_scope).toBe("PARENT_PRIVATE");
  });

  it("toggles ProsodyBreathingCuesBar legend and annotated rhythm preview for Grade 2–5", async () => {
    const user = userEvent.setup();
    render(
      <ProsodyBreathingCuesBar text="Mẹ ơi, hôm nay trời đẹp. Bé vui không? Thích quá!" />,
    );

    const toggleBtn = screen.getByTestId("prosody-breathing-cues-toggle");
    expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByTestId("prosody-breathing-cues-panel"),
    ).not.toBeInTheDocument();

    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByTestId("prosody-breathing-cues-panel"),
    ).toBeInTheDocument();
    expect(screen.getByText("Nghỉ hơi ngắn")).toBeInTheDocument();
    expect(screen.getByText("Nghỉ hơi dài")).toBeInTheDocument();
    expect(screen.getByText("Lên giọng nhẹ")).toBeInTheDocument();
    expect(screen.getByText("Đọc diễn cảm")).toBeInTheDocument();

    const preview = screen.getByTestId("prosody-annotated-preview");
    expect(preview.textContent).toContain("Mẹ ơi, •");
    expect(preview.textContent).toContain("trời đẹp. ••");
    expect(preview.textContent).toContain("Bé vui không? ↗");
    expect(preview.textContent).toContain("Thích quá! ✦");
  });

  it("renders ProsodyAssessmentCard meters, grade band verdict, and encouraging coaching tip", () => {
    render(<ProsodyAssessmentCard result={SAMPLE_PROSODY_RESPONSE} />);

    expect(screen.getByTestId("prosody-assessment-card")).toBeInTheDocument();
    expect(screen.getByTestId("prosody-overall-score")).toHaveTextContent(
      "91/100",
    );
    expect(screen.getByTestId("prosody-grade-verdict")).toHaveTextContent(
      "Xuất sắc",
    );
    expect(
      screen.getByRole("progressbar", { name: "Ngắt nhịp dấu phẩy (,)" }),
    ).toHaveAttribute("aria-valuenow", "92");
    expect(
      screen.getByRole("progressbar", { name: "Ngắt nhịp dấu chấm (.)" }),
    ).toHaveAttribute("aria-valuenow", "94");
    expect(
      screen.getByRole("progressbar", { name: "Ngữ điệu diễn cảm (↗ ✦)" }),
    ).toHaveAttribute("aria-valuenow", "88");
    expect(screen.getByTestId("prosody-coaching-tip")).toHaveTextContent(
      /Tuyệt vời lắm!/,
    );
  });

  it("runs prosody sample analysis inside SessionComplete and displays ProsodyAssessmentCard", async () => {
    const user = userEvent.setup();
    const analyzeSpy = vi
      .spyOn(prosodyService, "analyzeProsody")
      .mockResolvedValueOnce(SAMPLE_PROSODY_RESPONSE);

    try {
      render(
        <SessionComplete
          booksHref="/books"
          bookId={TEST_SESSION_ID}
          child={childFixture}
          referenceText="Mẹ ơi, hôm nay con vui không? Con thích đọc sách lắm."
          sessionId={TEST_SESSION_ID}
          summary={{
            duration_minutes: 4,
            pages_explored: 2,
            practiced_words: 12,
            spoken_words: ["Mẹ", "ơi", "hôm", "nay"],
            transcripts: ["Mẹ ơi, hôm nay con vui không?"],
          }}
        />,
      );

      const triggerBox = screen.getByTestId("session-prosody-coach-trigger");
      expect(triggerBox).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: /Xem đánh giá nhịp đọc/i }),
      );

      await waitFor(() => {
        expect(
          screen.getByTestId("prosody-assessment-card"),
        ).toBeInTheDocument();
      });
      expect(analyzeSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("prosody-grade-verdict")).toHaveTextContent(
        "Xuất sắc",
      );
    } finally {
      analyzeSpy.mockRestore();
    }
  });
});
