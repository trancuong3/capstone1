import { describe, expect, it } from "vitest";
import {
  getWordGeometryLabel,
  getWordGeometryQuality,
  getWordPunctuationLabel,
  getWordReviewBadgeColor,
  getWordReviewColor,
  getWordReviewColorGroup,
  getWordReviewLabel,
  getWordReviewStatus,
} from "@/components/admin/admin-ocr-review-screen";
import { adminRevisionDetailSchema } from "@/lib/api/ocr-review-service";
import {
  normalizeVietnameseWord,
  syncPageTextToWords,
  tokenizePageText,
} from "@/lib/ocr/sync-page-text-words";
import { adjudicateWord } from "@/lib/ocr/word-adjudication";
import type {
  AdminOcrReviewStatus,
  AdminOcrWordEvidenceDTO,
  AdminRevisionWordDTO,
} from "@/types/admin";
import parityCases from "./fixtures/ocr-color-parity.json";

type Color = "green" | "yellow" | "red";
type ParityCase = {
  id: string;
  text: string;
  ocr_review_status: AdminOcrReviewStatus;
  ocr_evidence: AdminOcrWordEvidenceDTO | null;
  expected_color: Color;
};

const cases = parityCases as unknown as ParityCase[];

function word(
  text: string,
  overrides: Partial<AdminRevisionWordDTO> = {},
  index = 0,
): AdminRevisionWordDTO {
  return {
    word_index: index,
    line_index: 0,
    text,
    normalized_text: text.toLocaleLowerCase("vi"),
    bbox: [0.05 + index * 0.1, 0.1, 0.08, 0.05],
    ocr_confidence: null,
    ...overrides,
  };
}

function evidence(
  overrides: Partial<AdminOcrWordEvidenceDTO> = {},
): AdminOcrWordEvidenceDTO {
  return {
    contract: "hybrid_ocr_evidence_v4",
    engine_outputs: { paddleocr: "SANG", vietocr: "SÁNG" },
    engine_statuses: {
      paddleocr: "success",
      vietocr: "success",
      tesseract: "not_run",
    },
    paddle_token_index: 0,
    vietocr_token_index: 0,
    source_text: "SÁNG",
    alignment: "substitute",
    engine_agreement_score: null,
    calibrated_word_accuracy: null,
    verification_source: null,
    reference_text: null,
    reference_alignment: null,
    selected_engine: "vietocr",
    bbox_quality: "valid",
    crop_quality: "usable",
    crop_evidence: { status: "skipped" },
    review_reason: "test",
    ...overrides,
  };
}

const withReference = (
  reference: string,
  alignment: string,
  source: string,
): AdminOcrWordEvidenceDTO =>
  evidence({
    source_text: source,
    engine_outputs: { paddleocr: source, vietocr: source },
    alignment: "match",
    verification_source: "verified_revision",
    reference_text: reference,
    reference_alignment: alignment,
  });

describe("frontend classifier agrees with the backend on every exported case", () => {
  it("has a large, three-color parity set", () => {
    expect(cases.length).toBeGreaterThanOrEqual(700);
    for (const color of ["green", "red", "yellow"] as const) {
      expect(
        cases.filter((item) => item.expected_color === color).length,
      ).toBeGreaterThanOrEqual(150);
    }
  });

  it.each(cases.map((item) => [item.id, item] as const))("%s", (_id, item) => {
    const legacyPayload = word(item.text, {
      ocr_review_status: item.ocr_review_status,
      ocr_evidence: item.ocr_evidence,
    });
    // Without the server color the client must derive the same one.
    expect(getWordReviewColorGroup(item.ocr_review_status, legacyPayload)).toBe(
      item.expected_color,
    );
    // With the server color the client never overrides it.
    expect(
      getWordReviewColorGroup(item.ocr_review_status, {
        ...legacyPayload,
        review_color_group: item.expected_color,
      }),
    ).toBe(item.expected_color);
  });
});

describe("server color is authoritative and never downgraded", () => {
  const groups: Color[] = ["green", "yellow", "red"];
  const statuses: AdminOcrReviewStatus[] = [
    "needs_review",
    "engine_agreement",
    "engine_disagreement",
    "reference_match",
    "confirmed_mismatch",
    "verified",
  ];

  it.each(groups.flatMap((group) => statuses.map((status) => [group, status])))(
    "keeps %s when the word status is %s",
    (group, status) => {
      for (const missing of [
        undefined,
        null,
        evidence(),
        evidence({ engine_statuses: undefined, crop_evidence: null }),
      ]) {
        expect(
          getWordReviewColorGroup(
            status as AdminOcrReviewStatus,
            word("BỪA", {
              review_color_group: group as Color,
              ocr_evidence: missing,
            }),
          ),
        ).toBe(group);
      }
    },
  );

  it("renders red, green and yellow with distinct box and badge classes", () => {
    const classes = groups.map((group) =>
      getWordReviewColor(
        "needs_review",
        word("x", { review_color_group: group }),
      ),
    );
    expect(classes[0]).toContain("border-green-600");
    expect(classes[1]).toContain("border-amber-600");
    expect(classes[2]).toContain("border-red-600");
    expect(new Set(classes).size).toBe(3);
    const badges = groups.map((group) =>
      getWordReviewBadgeColor(
        "needs_review",
        word("x", { review_color_group: group }),
      ),
    );
    expect(new Set(badges).size).toBe(3);
  });
});

describe("page status never recolors or relabels a word", () => {
  const red = word("BỪA", {
    review_color_group: "red",
    ocr_review_status: "confirmed_mismatch",
    ocr_evidence: withReference("BỮA", "substitute", "BỪA"),
  });
  const green = word("SÁNG", {
    review_color_group: "green",
    ocr_review_status: "reference_match",
    ocr_evidence: withReference("SÁNG", "match", "SÁNG"),
  });
  const yellow = word("zzq", {
    review_color_group: "yellow",
    ocr_review_status: "needs_review",
    ocr_evidence: evidence({
      verification_source: "verified_revision",
      reference_alignment: "insert",
    }),
  });

  it.each(["NEEDS_REVIEW", "VERIFIED", "PROCESSING"] as const)(
    "keeps a mixed page mixed when the revision is %s",
    (revisionStatus) => {
      const colors = [red, green, yellow].map((item) =>
        getWordReviewColorGroup(
          getWordReviewStatus(item, revisionStatus),
          item,
        ),
      );
      expect(colors).toEqual(["red", "green", "yellow"]);
    },
  );

  it("labels a confirmed mismatch as such even on a VERIFIED page", () => {
    expect(getWordReviewStatus(red, "VERIFIED")).toBe("confirmed_mismatch");
    expect(getWordReviewStatus(green, "VERIFIED")).toBe("verified");
    expect(getWordReviewLabel(getWordReviewStatus(red, "VERIFIED"), red)).toBe(
      "Sai so với reference đã xác minh",
    );
  });

  it("derives red from evidence when a legacy payload has no server color", () => {
    const legacy = { ...red, review_color_group: undefined };
    for (const status of ["VERIFIED", "NEEDS_REVIEW"] as const) {
      expect(getWordReviewStatus(legacy, status)).toBe("confirmed_mismatch");
      expect(
        getWordReviewColorGroup(getWordReviewStatus(legacy, status), legacy),
      ).toBe("red");
    }
  });
});

describe("editing a token re-evaluates only that token", () => {
  const page = [
    word(
      "BỮA",
      {
        review_color_group: "green",
        ocr_review_status: "reference_match",
        ocr_evidence: withReference("BỮA", "match", "BỮA"),
      },
      0,
    ),
    word(
      "SANG",
      {
        review_color_group: "red",
        ocr_review_status: "confirmed_mismatch",
        ocr_evidence: withReference("SÁNG", "substitute", "SANG"),
      },
      1,
    ),
    word(
      "CỦA",
      {
        review_color_group: "green",
        ocr_review_status: "reference_match",
        ocr_evidence: withReference("CỦA", "match", "CỦA"),
      },
      2,
    ),
  ];
  const colorsOf = (words: readonly AdminRevisionWordDTO[]) =>
    words.map((item) =>
      getWordReviewColorGroup(getWordReviewStatus(item, "NEEDS_REVIEW"), item),
    );

  it("starts green, red, green", () => {
    expect(colorsOf(page)).toEqual(["green", "red", "green"]);
  });

  it("turns the corrected token green and keeps its OCR history", () => {
    const result = syncPageTextToWords("BỮA SÁNG CỦA", page);
    expect(result.status).toBe("synchronized");
    expect(colorsOf(result.words)).toEqual(["green", "green", "green"]);
    expect(result.words[1].ocr_evidence?.source_text).toBe("SANG");
    expect(result.words[1].ocr_evidence?.reference_text).toBe("SÁNG");
    expect(result.words[0].review_color_group).toBe("green");
    expect(result.words[2].review_color_group).toBe("green");
  });

  it("does not keep a stale green on a token edited away from its reference", () => {
    const result = syncPageTextToWords("BỮA SANG CUA", page);
    expect(colorsOf(result.words)).toEqual(["green", "red", "yellow"]);
  });

  it("does not keep a stale red after the token is changed to another wrong text", () => {
    const result = syncPageTextToWords("BỮA SÀNG CỦA", page);
    expect(colorsOf(result.words)).toEqual(["green", "yellow", "green"]);
  });

  it("restores the evidence-based color when the edit is undone", () => {
    const edited = syncPageTextToWords("BỮA SÁNG CỦA", page);
    const undone = syncPageTextToWords("BỮA SANG CỦA", edited.words);
    expect(colorsOf(undone.words)).toEqual(["green", "red", "green"]);
  });

  it("leaves every color untouched when the token count no longer matches", () => {
    const result = syncPageTextToWords("BỮA SÁNG", page);
    expect(result.status).toBe("token-count-mismatch");
    expect(colorsOf(result.words)).toEqual(["green", "red", "green"]);
  });
});

describe("engine adjudication on the client", () => {
  it("confirms a token both Vietnamese engines read, whatever PaddleOCR says", () => {
    const item = evidence({
      engine_outputs: { paddleocr: "SANG", vietocr: "SÁNG", tesseract: "SÁNG" },
      engine_statuses: {
        paddleocr: "success",
        vietocr: "success",
        tesseract: "success",
      },
    });
    expect(adjudicateWord(item)).toMatchObject({
      status: "resolved",
      text: "sáng",
    });
    expect(
      getWordReviewColorGroup(
        "engine_disagreement",
        word("SÁNG", { ocr_evidence: item }),
      ),
    ).toBe("green");
  });

  it.each([
    ["Tesseract read other marks", { tesseract: "SẢNG" }, {}],
    ["Tesseract found no token", {}, {}],
    [
      "a crop reading of a Vietnamese engine has other marks",
      { tesseract: "SÁNG" },
      { status: "completed", vietocr_candidate: "SẢNG" },
    ],
  ])("stays yellow when %s", (_name, extraOutputs, crop) => {
    const item = evidence({
      engine_outputs: { paddleocr: "SANG", vietocr: "SÁNG", ...extraOutputs },
      engine_statuses: {
        paddleocr: "success",
        vietocr: "success",
        tesseract: "success",
      },
      crop_evidence: { status: "skipped", ...crop },
    });
    expect(
      getWordReviewColorGroup(
        "engine_disagreement",
        word("SÁNG", { ocr_evidence: item }),
      ),
    ).toBe("yellow");
  });

  it("never produces red without a verified reference", () => {
    const item = evidence({
      engine_outputs: { paddleocr: "SANG", vietocr: "SÁNG", tesseract: "SANG" },
      engine_statuses: {
        paddleocr: "success",
        vietocr: "success",
        tesseract: "success",
      },
    });
    for (const status of [
      "needs_review",
      "engine_disagreement",
      "confirmed_mismatch",
    ] as const) {
      expect(
        getWordReviewColorGroup(status, word("SÁNG", { ocr_evidence: item })),
      ).not.toBe("red");
    }
  });

  it("is not applicable when the word region is unusable", () => {
    expect(adjudicateWord(evidence({ bbox_quality: "rejected" })).status).toBe(
      "not_applicable",
    );
    expect(adjudicateWord(evidence({ crop_quality: "weak" })).status).toBe(
      "not_applicable",
    );
    expect(adjudicateWord(null).status).toBe("not_applicable");
  });
});

describe("API payload parsing keeps the color contract", () => {
  const base = {
    page_id: "33333333-3333-4333-8333-333333333333",
    page_revision_id: "44444444-4444-4444-8444-444444444441",
    revision_no: 2,
    verification_status: "NEEDS_REVIEW",
    lifecycle_status: "ACTIVE",
    draft_text: "BỮA SANG zzq",
    ocr_metadata: {},
    created_at: "2026-11-10T00:00:00Z",
    verified_at: null,
    verified_by: null,
  };
  const served = (
    text: string,
    index: number,
    color: Color,
    status: string,
    wordEvidence: unknown,
  ) => ({
    word_index: index,
    line_index: 0,
    text,
    normalized_text: text.toLowerCase(),
    bbox: [0.1 + index * 0.2, 0.2, 0.15, 0.08],
    ocr_confidence: null,
    ocr_score_source: null,
    ocr_review_status: status,
    review_color_group: color,
    ocr_evidence: wordEvidence,
  });

  it("parses a mixed page and preserves each color and its provenance", () => {
    const parsed = adminRevisionDetailSchema.parse({
      ...base,
      words: [
        served(
          "BỮA",
          0,
          "green",
          "reference_match",
          withReference("BỮA", "match", "BỮA"),
        ),
        served(
          "SANG",
          1,
          "red",
          "confirmed_mismatch",
          withReference("SÁNG", "substitute", "SANG"),
        ),
        served("zzq", 2, "yellow", "needs_review", null),
      ],
    });
    expect(parsed.words.map((item) => item.review_color_group)).toEqual([
      "green",
      "red",
      "yellow",
    ]);
    expect(parsed.words[1].ocr_evidence?.reference_text).toBe("SÁNG");
    expect(parsed.words[1].ocr_evidence?.reference_alignment).toBe(
      "substitute",
    );
    expect(parsed.words[2].ocr_evidence).toBeNull();
  });

  it("keeps Tesseract and adjudication fields inside crop evidence", () => {
    const parsed = adminRevisionDetailSchema.parse({
      ...base,
      words: [
        served(
          "BỮA",
          0,
          "green",
          "engine_disagreement",
          evidence({
            engine_outputs: {
              paddleocr: "BU'A",
              vietocr: "BỮA",
              tesseract: "BỮA",
            },
            crop_evidence: {
              status: "completed",
              tesseract_candidate: "BỮA",
              adjudication_status: "resolved",
              adjudication_support: "vietocr_line,tesseract_line",
              text_before_adjudication: "BỪA",
            },
          }),
        ),
      ],
    });
    const crop = parsed.words[0].ocr_evidence?.crop_evidence;
    expect(crop?.tesseract_candidate).toBe("BỮA");
    expect(crop?.adjudication_status).toBe("resolved");
    expect(crop?.text_before_adjudication).toBe("BỪA");
  });

  it("falls back to evidence when a legacy payload has no color field", () => {
    const legacyWord = served(
      "SANG",
      0,
      "red",
      "needs_review",
      withReference("SÁNG", "substitute", "SANG"),
    ) as Record<string, unknown>;
    delete legacyWord.review_color_group;
    const parsed = adminRevisionDetailSchema.parse({
      ...base,
      words: [legacyWord],
    });
    const item = parsed.words[0] as AdminRevisionWordDTO;
    expect(
      getWordReviewColorGroup(getWordReviewStatus(item, "NEEDS_REVIEW"), item),
    ).toBe("red");
  });

  it("degrades malformed evidence to yellow instead of inventing a color", () => {
    const parsed = adminRevisionDetailSchema.parse({
      ...base,
      words: [
        served("SÁNG", 0, "yellow", "needs_review", { contract: "unknown" }),
      ],
    });
    const item = {
      ...(parsed.words[0] as AdminRevisionWordDTO),
      review_color_group: undefined,
    };
    expect(item.ocr_evidence).toBeNull();
    expect(getWordReviewColorGroup("needs_review", item)).toBe("yellow");
  });
});

describe("geometry and punctuation are reported next to the text color", () => {
  const confirmed = (overrides: Partial<AdminOcrWordEvidenceDTO>) =>
    evidence({
      engine_outputs: { paddleocr: "SANG", vietocr: "SÁNG", tesseract: "SÁNG" },
      engine_statuses: {
        paddleocr: "success",
        vietocr: "success",
        tesseract: "success",
      },
      ...overrides,
    });

  it.each([
    ["weak", { crop_quality: "weak" }],
    ["invalid", { bbox_quality: "rejected", crop_quality: "unavailable" }],
    ["good", {}],
    ["not_assessed", { bbox_quality: "not_checked", crop_quality: null }],
  ] as const)(
    "keeps a confirmed word green when its box is %s",
    (quality, overrides) => {
      const item = word("SÁNG", { ocr_evidence: confirmed(overrides) });
      expect(getWordReviewColorGroup("engine_disagreement", item)).toBe(
        "green",
      );
      expect(getWordGeometryQuality(item)).toBe(quality);
    },
  );

  it("keeps the earlier, stricter standard for evidence without Tesseract", () => {
    const legacy = evidence({
      engine_outputs: { paddleocr: "SÁNG", vietocr: "SÁNG" },
      alignment: "match",
      crop_evidence: { status: "not_needed" },
      crop_quality: "weak",
    });
    expect(
      getWordReviewColorGroup(
        "engine_agreement",
        word("SÁNG", { ocr_evidence: legacy }),
      ),
    ).toBe("yellow");
  });

  it("prefers the server geometry field and labels every state", () => {
    const labels = (["good", "weak", "invalid", "not_assessed"] as const).map(
      (quality) =>
        getWordGeometryLabel(word("x", { geometry_quality: quality })),
    );
    expect(new Set(labels).size).toBe(4);
    expect(
      getWordGeometryQuality(
        word("x", {
          geometry_quality: "invalid",
          ocr_evidence: confirmed({}),
        }),
      ),
    ).toBe("invalid");
    expect(getWordGeometryQuality(word("x"))).toBe("not_assessed");
  });

  it("labels every punctuation verdict distinctly", () => {
    const labels = (
      [
        "correct",
        "incorrect",
        "uncertain",
        "consistent",
        "not_assessed",
      ] as const
    ).map((status) =>
      getWordPunctuationLabel(word("x", { punctuation_status: status })),
    );
    expect(new Set(labels).size).toBe(5);
    expect(getWordPunctuationLabel(word("x"))).toBe(labels[4]);
  });

  it("a wrong punctuation mark does not change the word color", () => {
    const item = word("ngon.", {
      review_color_group: "green",
      punctuation_status: "incorrect",
      ocr_evidence: withReference("ngon!", "match", "ngon."),
    });
    expect(
      getWordReviewColorGroup(getWordReviewStatus(item, "NEEDS_REVIEW"), item),
    ).toBe("green");
    const legacy = { ...item, review_color_group: undefined };
    expect(getWordReviewColorGroup("needs_review", legacy)).toBe("green");
  });

  it("drops the stale punctuation verdict of an edited token only", () => {
    const page = [
      word("An", { punctuation_status: "correct" }, 0),
      word("ngon.", { punctuation_status: "incorrect" }, 1),
    ];
    const result = syncPageTextToWords("An ngon!", page);
    expect(result.words[0].punctuation_status).toBe("correct");
    expect(result.words[1].punctuation_status).toBeUndefined();
    expect(result.words[1].text).toBe("ngon!");
  });

  it("parses the new API fields and tolerates their absence", () => {
    const base = {
      page_id: "33333333-3333-4333-8333-333333333333",
      page_revision_id: "44444444-4444-4444-8444-444444444441",
      revision_no: 1,
      verification_status: "NEEDS_REVIEW",
      lifecycle_status: "ACTIVE",
      draft_text: "– An ngon.",
      ocr_metadata: {},
      created_at: "2026-11-10T00:00:00Z",
      verified_at: null,
      verified_by: null,
    };
    const served = {
      word_index: 0,
      line_index: 0,
      text: "An",
      normalized_text: "an",
      bbox: [0.1, 0.2, 0.15, 0.08],
      ocr_confidence: null,
      ocr_review_status: "needs_review",
      review_color_group: "green",
      ocr_evidence: null,
    };
    const parsed = adminRevisionDetailSchema.parse({
      ...base,
      words: [
        {
          ...served,
          geometry_quality: "weak",
          punctuation_status: "uncertain",
        },
        { ...served, word_index: 1, text: "ngon.", normalized_text: "ngon" },
        {
          ...served,
          word_index: 2,
          geometry_quality: "sideways",
          punctuation_status: 7,
        },
      ],
    });
    expect(parsed.words[0].geometry_quality).toBe("weak");
    expect(parsed.words[0].punctuation_status).toBe("uncertain");
    expect(parsed.words[1].geometry_quality).toBeUndefined();
    expect(parsed.words[2].geometry_quality).toBeUndefined();
    expect(parsed.words[2].punctuation_status).toBeUndefined();
    // The standalone dash stays in the page text although it is not a word.
    expect(parsed.draft_text).toBe("– An ngon.");
    expect(tokenizePageText(parsed.draft_text ?? "")).toEqual(["An", "ngon."]);
  });

  it.each([
    ["'An'", "an"],
    ["vườn'", "vườn"],
    ["-An", "an"],
    ["An-", "an"],
    ["d'accord", "d'accord"],
    ["xì-gà", "xì-gà"],
    ["“Sáng!”", "sáng"],
    ["-", "-"],
  ])("normalizes %s to the lexical core %s", (surface, core) => {
    expect(normalizeVietnameseWord(surface)).toBe(core);
  });
});
