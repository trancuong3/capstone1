import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntertainmentScreen } from "@/components/entertainment/entertainment-screen";
import { TaiThinhEarTrainerModal } from "@/components/entertainment/tai-thinh-ear-trainer-modal";
import { RegionalPhoneticProfileCard } from "@/components/profiles/regional-phonetic-profile-card";
import {
  AppServicesContext,
  type AppServices,
} from "@/components/providers/app-services-provider";
import type { ChildService } from "@/lib/api/child-service";
import type { PictureDescriptionService } from "@/lib/api/picture-description-service";
import {
  DIALECT_PREVIEW_SAMPLES,
  type CompleteEarTrainerInput,
  type EarTrainer30sDTO,
  type EvaluateAlignmentInput,
  type PhoneticProfile,
  type RegionalPhoneticService,
} from "@/lib/api/regional-phonetics-service";
import type { VocabularyNotebookService } from "@/lib/api/vocabulary-notebook-service";
import {
  regionalDialectEn,
  regionalDialectVi,
} from "@/messages/features/regional_dialect_messages";
import {
  childFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
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

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const messagesFilePath = path.resolve(
  currentDir,
  "../../../messages/features/regional_dialect_messages.ts",
);

function makeEarTrainerDto(
  profile: PhoneticProfile = "CENTRAL_TOLERANT",
): EarTrainer30sDTO {
  return {
    child_id: TEST_CHILD_ID,
    phonetic_profile: profile,
    total_rounds: 3,
    duration_seconds: 30,
    focus_weak_categories: ["l_n", "coda_n_ng_t_c", "hoi_nga"],
    visibility: "PARENT_PRIVATE",
    rounds: [
      {
        round_index: 0,
        target_word: "lúa",
        distractor_word: "núa",
        options: ["lúa", "núa"],
        tts_text: "Từ lúa.",
        contrastive_keyterms: ["lúa", "núa", "lùa", "lụa"],
        phonics_category: "l_n",
        phonics_category_label_vi: "Âm đầu l / n",
      },
      {
        round_index: 1,
        target_word: "mát",
        distractor_word: "mác",
        options: ["mác", "mát"],
        tts_text: "Từ mát.",
        contrastive_keyterms: ["mát", "mác", "mạt", "mạc"],
        phonics_category: "coda_n_ng_t_c",
        phonics_category_label_vi: "Vần cuối n/ng · t/c",
      },
      {
        round_index: 2,
        target_word: "cũ",
        distractor_word: "củ",
        options: ["cũ", "củ"],
        tts_text: "Từ cũ.",
        contrastive_keyterms: ["cũ", "củ", "cụ", "cú"],
        phonics_category: "hoi_nga",
        phonics_category_label_vi: "Thanh hỏi / ngã",
      },
    ],
  };
}

function makeMockDialectService(
  initialProfile: PhoneticProfile = "STRICT_SGK",
): RegionalPhoneticService {
  let savedProfile: PhoneticProfile = initialProfile;
  return {
    getProfile: vi.fn(async (childId: string) => ({
      child_id: childId,
      phonetic_profile: savedProfile,
      visibility: "PARENT_PRIVATE" as const,
    })),
    updateProfile: vi.fn(async (childId: string, input) => {
      savedProfile = input.phonetic_profile;
      return {
        child_id: childId,
        phonetic_profile: savedProfile,
        visibility: "PARENT_PRIVATE" as const,
      };
    }),
    evaluateAlignment: vi.fn(
      async (_childId: string, input: EvaluateAlignmentInput) => {
        const profile = input.phonetic_profile_override ?? savedProfile;
        return DIALECT_PREVIEW_SAMPLES[profile].fallbackEvaluation;
      },
    ),
    getEarTrainer: vi.fn(async () => makeEarTrainerDto(savedProfile)),
    completeEarTrainer: vi.fn(
      async (childId: string, input: CompleteEarTrainerInput) => ({
        child_id: childId,
        phonetic_profile: savedProfile,
        rounds_attempted: input.rounds_attempted,
        rounds_correct: input.rounds_correct,
        accuracy: Number(
          (input.rounds_correct / Math.max(1, input.rounds_attempted)).toFixed(
            4,
          ),
        ),
        phase_b_spoken: input.phase_b_spoken,
        completion_mode: input.phase_b_spoken
          ? ("VOICE_ECHO" as const)
          : ("CALM_TAP" as const),
        xp_earned: input.rounds_correct * 10 + (input.phase_b_spoken ? 5 : 0),
        message_vi:
          "Xuất sắc! Tai thính miệng xinh — bé phân biệt chuẩn cả 3 cặp âm!",
        message_en: "Wonderful! Sharp ear — you matched all 3 minimal pairs!",
        visibility: "PARENT_PRIVATE" as const,
      }),
    ),
  };
}

function buildTestAppServices(): AppServices {
  const childService: ChildService = {
    list: vi.fn(async () => [childFixture]),
    create: vi.fn(async () => childFixture),
    get: vi.fn(async () => childFixture),
    update: vi.fn(async () => childFixture),
    updateVoicePreferences: vi.fn(async () => childFixture),
    uploadAvatar: vi.fn(async () => childFixture),
    removeAvatar: vi.fn(async () => childFixture),
    delete: vi.fn(async () => undefined),
  };
  const unavailable = new Proxy(
    {},
    {
      get() {
        return vi.fn();
      },
    },
  );
  return {
    bookService: unavailable as AppServices["bookService"],
    bookContentReportService:
      unavailable as AppServices["bookContentReportService"],
    childService,
    comprehensionService: unavailable as AppServices["comprehensionService"],
    devicePermissionService:
      unavailable as AppServices["devicePermissionService"],
    difficultWordService: unavailable as AppServices["difficultWordService"],
    pageMatchService: unavailable as AppServices["pageMatchService"],
    profileService: unavailable as AppServices["profileService"],
    reportService: unavailable as AppServices["reportService"],
    readingService: unavailable as AppServices["readingService"],
    readingManagementService:
      unavailable as AppServices["readingManagementService"],
    readingSocketAdapter: unavailable as AppServices["readingSocketAdapter"],
    sessionService: unavailable as AppServices["sessionService"],
    pictureDescriptionService: unavailable as PictureDescriptionService,
    tutorService: unavailable as AppServices["tutorService"],
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ detail: "Not mocked" }, { status: 404 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("Feature #3: Regional Phonetic Profile & 30s Tai Thính Miệng Xinh Trainer", () => {
  it("enforces pure server-safe regional_dialect_messages.ts with 1:1 vi/en key parity", () => {
    const raw = fs.readFileSync(messagesFilePath, "utf-8");
    expect(raw).not.toContain('"use client"');
    expect(raw).not.toContain("'use client'");
    expect(raw).not.toContain("useCallback");
    expect(Object.keys(regionalDialectVi).sort()).toEqual(
      Object.keys(regionalDialectEn).sort(),
    );
  });

  it("renders RegionalPhoneticProfileCard with side-by-side dual-score fairness preview and saves profile", async () => {
    const user = userEvent.setup();
    const dialectService = makeMockDialectService("STRICT_SGK");

    render(
      <RegionalPhoneticProfileCard
        childAlias="Bé An"
        childId={TEST_CHILD_ID}
        service={dialectService}
      />,
    );

    expect(
      screen.getByTestId("regional-phonetic-profile-card"),
    ).toBeInTheDocument();

    // Default STRICT_SGK shows equal strict and regional scores (43% / 43%)
    await waitFor(() => {
      expect(screen.getByTestId("dual-score-strict-sgk")).toHaveTextContent(
        "43%",
      );
      expect(
        screen.getByTestId("dual-score-regional-tolerant"),
      ).toHaveTextContent("43%");
    });

    // Select CENTRAL_TOLERANT -> side-by-side 50% Chuẩn chính tả SGK vs 88% Khoan dung vùng miền
    await user.click(
      screen.getByTestId("phonetic-profile-option-CENTRAL_TOLERANT"),
    );

    await waitFor(() => {
      expect(screen.getByTestId("dual-score-strict-sgk")).toHaveTextContent(
        "50%",
      );
      expect(
        screen.getByTestId("dual-score-regional-tolerant"),
      ).toHaveTextContent("88%");
    });

    // Regional variants AND true error word ("nhà") are both transparently surfaced
    expect(screen.getByTestId("regional-variant-chip-0")).toHaveTextContent(
      "mát ↔ mác",
    );
    expect(screen.getByTestId("true-error-chip-nhà-0")).toHaveTextContent(
      "nhà",
    );

    // Persist profile
    await user.click(screen.getByTestId("save-phonetic-profile-btn"));
    await waitFor(() => {
      expect(dialectService.updateProfile).toHaveBeenCalledWith(TEST_CHILD_ID, {
        phonetic_profile: "CENTRAL_TOLERANT",
      });
    });
    expect(
      screen.getByText(regionalDialectVi.savedProfile),
    ).toBeInTheDocument();
  });

  it("completes 30s TaiThinhEarTrainerModal in both STT-free Calm Tap mode and Contrastive Voice Echo mode", async () => {
    const user = userEvent.setup();
    const dialectService = makeMockDialectService("NORTH_TOLERANT");
    const mockPlayer = {
      isPlaying: false,
      play: vi.fn(async () => undefined),
      stop: vi.fn(),
    };
    const mockRecorder = {
      isRecording: false,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => new Blob(["fake-audio"], { type: "audio/webm" })),
      cancel: vi.fn(),
    };
    const mockSpeechService = {
      transcribe: vi.fn(async () => ({
        text: "mát",
        language_code: "vi",
        language_probability: 0.99,
        words: null,
      })),
    };

    render(
      <TaiThinhEarTrainerModal
        childAlias="Bé An"
        childId={TEST_CHILD_ID}
        isOpen
        onClose={vi.fn()}
        service={dialectService}
        speechPlayer={mockPlayer}
        speechRecorder={mockRecorder}
        speechService={mockSpeechService}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("ear-trainer-round-indicator"),
      ).toHaveTextContent("1/3");
    });
    expect(screen.getByTestId("ear-trainer-countdown")).toHaveTextContent(
      "30s",
    );
    expect(mockPlayer.play).toHaveBeenCalledWith(
      "Từ lúa.",
      expect.objectContaining({ coaching: true }),
    );

    // Round 1: Phase A tap "lúa" (correct) -> Phase B calm no-mic next
    await user.click(screen.getByTestId("ear-trainer-option-lúa"));
    expect(screen.getByTestId("ear-trainer-phase-b")).toBeInTheDocument();
    await user.click(screen.getByTestId("ear-trainer-calm-next-btn"));

    // Round 2: Phase A tap "mát" (correct) -> Phase B optional spoken echo with contrastive keyterms!
    await waitFor(() => {
      expect(
        screen.getByTestId("ear-trainer-round-indicator"),
      ).toHaveTextContent("2/3");
    });
    await user.click(screen.getByTestId("ear-trainer-option-mát"));
    // Start recording echo, then stop & transcribe
    await user.click(screen.getByTestId("ear-trainer-echo-btn"));
    expect(mockRecorder.start).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("ear-trainer-echo-btn"));
    await waitFor(() => {
      expect(mockSpeechService.transcribe).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.objectContaining({
          keyterms: expect.arrayContaining(["mát", "mác"]),
        }),
      );
    });
    expect(screen.getByTestId("ear-trainer-echo-feedback")).toHaveTextContent(
      "mát",
    );
    await user.click(screen.getByTestId("ear-trainer-calm-next-btn"));

    // Round 3: Phase A tap "cũ" (correct) -> Finish
    await waitFor(() => {
      expect(
        screen.getByTestId("ear-trainer-round-indicator"),
      ).toHaveTextContent("3/3");
    });
    await user.click(screen.getByTestId("ear-trainer-option-cũ"));
    await user.click(screen.getByTestId("ear-trainer-calm-next-btn"));

    await waitFor(() => {
      expect(
        screen.getByTestId("ear-trainer-complete-summary"),
      ).toBeInTheDocument();
    });
    expect(dialectService.completeEarTrainer).toHaveBeenCalledWith(
      TEST_CHILD_ID,
      expect.objectContaining({
        rounds_attempted: 3,
        rounds_correct: 3,
        phase_b_spoken: true,
        practiced_words: ["lúa", "mát", "cũ"],
      }),
    );
    expect(screen.getByTestId("ear-trainer-final-score")).toHaveTextContent(
      "3/3",
    );
    expect(
      screen.getByTestId("ear-trainer-completion-mode-badge"),
    ).toHaveTextContent(regionalDialectVi.earTrainerModeVoiceBadge);
  });

  it("launches 30s TaiThinhEarTrainerModal cleanly from EntertainmentScreen hub CTA", async () => {
    const user = userEvent.setup();
    const dialectService = makeMockDialectService("CENTRAL_TOLERANT");
    const vocabService: VocabularyNotebookService = {
      explainWord: vi.fn(),
      listNotebook: vi.fn(async () => ({
        child_id: TEST_CHILD_ID,
        total: 0,
        storytelling_words: [],
        items: [],
      })),
      saveWord: vi.fn(),
      deleteWord: vi.fn(),
    };

    render(
      <AppServicesContext.Provider value={buildTestAppServices()}>
        <WithSelectedChild childId={childFixture.id}>
          <EntertainmentScreen
            initialRecommendations={{
              child_id: TEST_CHILD_ID,
              child_alias: childFixture.alias,
              child_grade: childFixture.grade,
              mascot_greeting_vi: "Chào bé yêu!",
              today_activities_count: 0,
              focus_difficult_words: ["lúa"],
              primary_recommendation: {
                game_key: "KARAOKE",
                zone_title_vi: "Sân khấu âm nhạc",
                game_title_vi: "Hát vui cùng bé",
                reason_vi: "Ôn cặp âm.",
                suggested_mode: "FULL_SONG",
                suggested_difficulty: 1,
                target_words: ["lúa"],
                href: "/karaoke",
                priority: 1,
              },
              recommendations: [],
              natural_break_reminder_vi: "Nghỉ mắt dịu nhẹ nhé!",
            }}
            regionalPhoneticService={dialectService}
            vocabularyService={vocabService}
          />
        </WithSelectedChild>
      </AppServicesContext.Provider>,
    );

    const launchBtn = await screen.findByTestId("hub-open-tai-thinh-btn");
    await user.click(launchBtn);

    await waitFor(() => {
      expect(
        screen.getByTestId("tai-thinh-ear-trainer-modal"),
      ).toBeInTheDocument();
    });
    expect(dialectService.getEarTrainer).toHaveBeenCalledWith(TEST_CHILD_ID);
  });
});
