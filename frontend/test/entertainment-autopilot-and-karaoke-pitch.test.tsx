import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryGameScreen } from "@/components/entertainment/memory-game/memory-game-screen";
import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import { KaraokeStage } from "@/components/karaoke/karaoke-stage";
import { foldMidiNearTarget } from "@/components/karaoke/pitch-highway-canvas";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import * as karaokeScoringHook from "@/hooks/use-karaoke-scoring";
import { MusicalDspAnalyzer } from "@/lib/karaoke/musical-dsp";
import type { TargetNoteSpan } from "@/lib/karaoke/pro-karaoke-scoring";
import {
  createReferenceMelodySynth,
  midiToHz,
  midiToVietnameseSolfege,
} from "@/lib/karaoke/reference-melody-synth";
import {
  childFixture,
  TEST_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";

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

const routerMock = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => recorderMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
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

describe("Karaoke Reference Pitch & Solfège Helpers", () => {
  const highNoteSpan: TargetNoteSpan[] = [
    {
      startMs: 1000,
      endMs: 1800,
      midi: 74, // D5
      hz: 587.33,
      confidence: 0.95,
      lineId: "line-1",
      syllableId: "syl-1",
      text: "cao",
    },
  ];

  it("folds octave near target MIDI so high notes (C5/D5) never cliff-jump down an octave", () => {
    // Singing D5 (74) on a D5 (74) target stays at 74 even when song midpoint is 66!
    expect(foldMidiNearTarget(74, highNoteSpan, 1200, 0, 66, null)).toBeCloseTo(
      74,
      3,
    );
    // Singing D4 (62) an octave below a D5 (74) target folds cleanly to 74
    expect(foldMidiNearTarget(62, highNoteSpan, 1200, 0, 66, null)).toBeCloseTo(
      74,
      3,
    );
    // With +2 semitone Key Shift (target becomes E5=76), singing E5 (76) stays at 76
    expect(foldMidiNearTarget(76, highNoteSpan, 1200, 2, 66, null)).toBeCloseTo(
      76,
      3,
    );
  });

  it("maps MIDI notes to Vietnamese solfège (Đô–Rê–Mi–Pha–Son–La–Si) and child register labels", () => {
    expect(midiToVietnameseSolfege(60)).toMatchObject({
      solfege: "Đô",
      octave: 4,
      labelVi: "Đô 4",
      registerVi: "Thấp",
    });
    expect(midiToVietnameseSolfege(67)).toMatchObject({
      solfege: "Son",
      octave: 4,
      labelVi: "Son 4",
      registerVi: "Vừa",
    });
    expect(midiToVietnameseSolfege(72)).toMatchObject({
      solfege: "Đô",
      octave: 5,
      labelVi: "Đô 5",
      registerVi: "Cao",
    });
  });

  it("synthesizes gentle reference melody guide notes and cleans up Web Audio nodes cleanly", () => {
    const startSpy = vi.fn();
    const stopSpy = vi.fn();
    const closeSpy = vi.fn(async () => undefined);
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      resume = vi.fn(async () => undefined);
      close = closeSpy;
      createGain = vi.fn(() => ({
        gain: {
          value: 0,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }));
      createBiquadFilter = vi.fn(() => ({
        type: "lowpass",
        frequency: { value: 1800, setValueAtTime: vi.fn() },
        Q: { value: 0.7 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }));
      createOscillator = vi.fn(() => ({
        type: "triangle",
        frequency: { value: 440, setValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: startSpy,
        stop: stopSpy,
        onended: null,
      }));
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const synth = createReferenceMelodySynth();
    // Syncing inside note window triggers reference guide harmonic oscillators once (fundamental + shimmer)
    synth.syncPlayback({
      currentMs: 1100,
      targetNotes: highNoteSpan,
      keyShift: 0,
      micListening: true,
      enabled: true,
    });
    const callsAfterFirstFrame = startSpy.mock.calls.length;
    expect(callsAfterFirstFrame).toBeGreaterThanOrEqual(1);

    // Repeated frame within the same note does NOT re-trigger duplicate oscillators
    synth.syncPlayback({
      currentMs: 1200,
      targetNotes: highNoteSpan,
      keyShift: 0,
      micListening: true,
      enabled: true,
    });
    expect(startSpy.mock.calls.length).toBe(callsAfterFirstFrame);

    synth.dispose();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("prevents acoustic self-scoring when ReferenceMelodySynth plays on loudspeaker into a silent open mic", () => {
    const sampleRate = 44100;
    const frameSize = 2048;
    const lyricSpans = [
      { startMs: 1000, endMs: 1900 },
      { startMs: 2100, endMs: 3000 },
      { startMs: 3200, endMs: 4100 },
    ];
    const analyzer = new MusicalDspAnalyzer({
      sampleRate,
      frameSize,
      lyricSpans,
      headphoneMode: false,
      micLatencyMs: 0,
    });

    // Simulate open-speaker 140ms marimba onset plucks at gain=0.026 (~35% acoustic coupling = 0.009)
    // with ZERO human singing across the entire 4.5s song window.
    const noteMidis = [60, 64, 67];
    for (let tMs = 0; tMs <= 4500; tMs += 46) {
      const buf = new Float32Array(frameSize);
      const activeIdx = lyricSpans.findIndex(
        (sp) => tMs >= sp.startMs && tMs < sp.startMs + 140,
      );
      if (activeIdx >= 0) {
        const f0 = midiToHz(noteMidis[activeIdx]);
        const elapsedSec = (tMs - lyricSpans[activeIdx].startMs) / 1000;
        const env = 0.009 * Math.exp(-elapsedSec * 22);
        for (let i = 0; i < frameSize; i++) {
          const sec = elapsedSec + i / sampleRate;
          buf[i] =
            env *
            (Math.sin(2 * Math.PI * f0 * sec) +
              0.22 * Math.sin(4 * Math.PI * f0 * sec));
        }
      }
      analyzer.processFrame(buf, tMs);
    }

    const summary = analyzer.summarize();
    // Quality gate must reject silent open-mic guide bleed so zero Pitch points are self-awarded!
    expect(summary.qualityGate.passed).toBe(false);
    expect(["SILENCE", "LOW_COVERAGE", "SPEAKER_BLEED"]).toContain(
      summary.qualityGate.reason,
    );
  });
});

describe("PictureDescriptionScreen 3-2-1 Auto-Mic Countdown & Cancellation", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    recorderMock.prepare.mockClear();
    recorderMock.start.mockClear();
    recorderMock.stop.mockClear();
    recorderMock.cancel.mockClear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/picture-description/catalog") {
        return Response.json({
          samples: [
            {
              sample_key: "sunny-garden",
              title: "Khu vườn đầy nắng",
              theme: "Thiên nhiên",
              description: "Chú mèo cam ngủ trưa.",
              image_url: "/images/picture-description/sunny-garden.jpg",
            },
          ],
          book_pages: [],
        });
      }
      if (
        path === "/games/picture-description/sessions" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json([]);
      }
      if (
        path === "/games/picture-description/sessions" &&
        init?.method === "POST"
      ) {
        return Response.json(
          {
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
            target_words: ["lung linh"],
            guide: {
              is_child_safe: true,
              scene_title: "Chú mèo ngủ trưa trong vườn nắng",
              scene_summary: "Chú mèo cam nằm ngủ.",
              guiding_questions: ["Bé thấy con vật nào?"],
              suggested_vocabulary: [
                { word: "lung linh", hint: "Từ bé đang luyện" },
              ],
              model_sample_sentences: ["Chú mèo đang ngủ."],
              target_words: ["lung linh"],
            },
            attempts: [],
            created_at: "2026-11-28T08:00:00Z",
            updated_at: "2026-11-28T08:00:00Z",
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected test route ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("counts down 3 -> 2 -> 1 on Start and automatically opens the microphone at 0s", async () => {
    render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <PictureDescriptionScreen />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const startBtn = await screen.findByRole(
      "button",
      { name: "Khám phá tranh này" },
      { timeout: 4000 },
    );
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
    fireEvent.click(startBtn);

    expect(
      await screen.findByTestId("picture-mic-countdown"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("picture-mic-countdown-number"),
    ).toHaveTextContent("3");
    expect(recorderMock.start).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(
      screen.getByTestId("picture-mic-countdown-number"),
    ).toHaveTextContent("2");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(
      screen.getByTestId("picture-mic-countdown-number"),
    ).toHaveTextContent("1");

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(
      screen.queryByTestId("picture-mic-countdown"),
    ).not.toBeInTheDocument();
    expect(recorderMock.start).toHaveBeenCalledTimes(1);

    // Regression: if child starts typing AFTER 0s auto-mic already activated,
    // active voice capture is aborted cleanly so the Submit button stays enabled!
    const textarea = screen.getByLabelText("Nội dung bé mô tả bức tranh");
    fireEvent.change(textarea, {
      target: { value: "Chú mèo cam đang ngủ ngon trên ghế gỗ." },
    });
    expect(recorderMock.cancel).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Gửi cô giáo AI chấm bài/i }),
    ).toBeEnabled();
  });

  it("cancels the 3-2-1 auto-mic countdown immediately if the child starts typing in textarea", async () => {
    render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <PictureDescriptionScreen />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const startBtn = await screen.findByRole(
      "button",
      { name: "Khám phá tranh này" },
      { timeout: 4000 },
    );
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
    fireEvent.click(startBtn);

    expect(
      await screen.findByTestId("picture-mic-countdown"),
    ).toBeInTheDocument();
    const textarea = screen.getByLabelText("Nội dung bé mô tả bức tranh");
    fireEvent.change(textarea, { target: { value: "Chú mèo cam" } });

    expect(
      screen.queryByTestId("picture-mic-countdown"),
    ).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(recorderMock.start).not.toHaveBeenCalled();
  });

  it("falls back to local MediaRecorder + server STT with keyterms in MemoryGameScreen when SpeechRecognition is absent", async () => {
    vi.stubGlobal("MediaRecorder", class {});
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/memory/themes") {
        return Response.json({
          themes: [
            {
              theme_key: "sunny_garden",
              name_vi: "Khu vườn nắng mai",
              description_vi: "Nắng sớm dịu nhẹ.",
              badge_vi: "Thiên nhiên",
              accent_hex: "#F7B731",
              sprite_count: 5,
              sample_items_vi: ["diều giấy"],
            },
          ],
          timer_options: [
            {
              mode: "10S",
              seconds: 10,
              label_vi: "10 giây",
              recommended_for_vi: "Lớp 1–2",
            },
          ],
          grade_recommendations: [],
          total_sprites: 10,
        });
      }
      if (
        path === "/games/memory/sessions" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json([]);
      }
      if (path === "/games/memory/sessions" && init?.method === "POST") {
        return Response.json(
          {
            id: TEST_SESSION_ID,
            child_id: TEST_CHILD_ID,
            child_grade: 2,
            theme_key: "sunny_garden",
            theme_name_vi: "Khu vườn nắng mai",
            difficulty_level: 2,
            scene_seed: 42,
            timer_mode: "UNLIMITED",
            timer_seconds: null,
            recall_mode: "FREE_RECALL",
            status: "OBSERVING",
            hints_used: 0,
            peek_count: 0,
            best_factual_score: 0,
            best_creative_score: 0,
            stars: 0,
            attempts_count: 0,
            scene_spec: {
              schema_version: "v4.0",
              theme_key: "sunny_garden",
              theme_name_vi: "Khu vườn nắng mai",
              child_grade: 2,
              difficulty_level: 2,
              scene_seed: 42,
              canvas_width: 800,
              canvas_height: 500,
              backdrop: {
                theme_key: "sunny_garden",
                sky_top_hex: "#BCE8FF",
                sky_bottom_hex: "#FFF8D9",
                horizon_hex: "#A4E48E",
                ground_hex: "#73C66A",
                accent_hex: "#F7B731",
                mood_vi: "Nắng sớm",
              },
              objects: [
                {
                  id: "obj_1",
                  sprite_key: "paper_kite",
                  name_vi: "diều giấy",
                  category_vi: "đồ chơi",
                  aliases_vi: ["diều"],
                  color_vi: "đỏ",
                  color_hex: "#D63031",
                  color_stroke_hex: "#8E1B1B",
                  color_light_hex: "#FF8A8A",
                  shape_cue: "circle",
                  count: 1,
                  position_zone: "trên trái",
                  bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
                  action_vi: "bay cao",
                  hint_tiers: { tier_1: "h1", tier_2: "h2", tier_3: "h3" },
                  is_focus_word: true,
                },
              ],
              observation_tips_vi: ["Nhìn kỹ tranh"],
              guided_questions_vi: ["Bé thấy gì?"],
              creative_prompt_vi: "Kể tiếp câu chuyện nhé!",
              matched_focus_words: ["diều giấy"],
              creative_focus_words: ["lung linh"],
            },
            attempts: [],
            created_at: "2026-11-28T08:00:00Z",
            updated_at: "2026-11-28T08:00:00Z",
          },
          { status: 201 },
        );
      }
      if (path === "/voice/speech-to-text") {
        return Response.json({
          text: "Bé thấy diều giấy màu đỏ bay cao",
          language_code: "vie",
          language_probability: 0.98,
          words: [],
        });
      }
      if (
        path === `/games/memory/sessions/${TEST_SESSION_ID}/attempts` &&
        init?.method === "POST"
      ) {
        return Response.json({
          attempt: {
            id: "33000000-0000-4000-8000-000000000009",
            session_id: TEST_SESSION_ID,
            attempt_number: 1,
            stage: "RECALL",
            input_mode: "VOICE",
            response_text: "Bé thấy diều giấy màu đỏ bay cao",
            factual_score: 92,
            creative_score: 0,
            stars: 3,
            evaluation: {
              stage: "RECALL",
              factual_score: 92,
              creative_score: 0,
              stars: 3,
              matched_facts: [],
              missed_facts: [],
              creative_highlights: [],
              story_anchors: [],
              used_focus_words: ["diều giấy"],
              praise_message_vi: "",
              story_praise_vi: "",
              next_tip_vi: "Tuyệt lắm!",
              creative_followup_vi: "Chiếc diều bay đi đâu tiếp nhỉ?",
              support_summary_vi: null,
              ai_provider: "deterministic",
            },
            ai_provider: "deterministic",
            created_at: "2026-11-28T08:01:00Z",
          },
          session: {
            id: TEST_SESSION_ID,
            child_id: TEST_CHILD_ID,
            child_grade: 2,
            theme_key: "sunny_garden",
            theme_name_vi: "Khu vườn nắng mai",
            difficulty_level: 2,
            scene_seed: 42,
            timer_mode: "UNLIMITED",
            timer_seconds: null,
            recall_mode: "FREE_RECALL",
            status: "CREATIVE",
            hints_used: 0,
            peek_count: 0,
            best_factual_score: 92,
            best_creative_score: 0,
            stars: 3,
            attempts_count: 1,
            scene_spec: {
              schema_version: "v4.0",
              theme_key: "sunny_garden",
              theme_name_vi: "Khu vườn nắng mai",
              child_grade: 2,
              difficulty_level: 2,
              scene_seed: 42,
              canvas_width: 800,
              canvas_height: 500,
              backdrop: {
                theme_key: "sunny_garden",
                sky_top_hex: "#BCE8FF",
                sky_bottom_hex: "#FFF8D9",
                horizon_hex: "#A4E48E",
                ground_hex: "#73C66A",
                accent_hex: "#F7B731",
                mood_vi: "Nắng sớm",
              },
              objects: [
                {
                  id: "obj_1",
                  sprite_key: "paper_kite",
                  name_vi: "diều giấy",
                  category_vi: "đồ chơi",
                  aliases_vi: ["diều"],
                  color_vi: "đỏ",
                  color_hex: "#D63031",
                  color_stroke_hex: "#8E1B1B",
                  color_light_hex: "#FF8A8A",
                  shape_cue: "circle",
                  count: 1,
                  position_zone: "trên trái",
                  bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
                  action_vi: "bay cao",
                  hint_tiers: { tier_1: "h1", tier_2: "h2", tier_3: "h3" },
                  is_focus_word: true,
                },
              ],
              observation_tips_vi: [],
              guided_questions_vi: [],
              creative_prompt_vi: "Kể tiếp câu chuyện nhé!",
              matched_focus_words: ["diều giấy"],
              creative_focus_words: ["lung linh"],
            },
            attempts: [],
            created_at: "2026-11-28T08:00:00Z",
            updated_at: "2026-11-28T08:01:00Z",
          },
        });
      }
      throw new Error(`Unexpected MemoryGame test route ${path}`);
    });

    render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <MemoryGameScreen />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const startMemoryBtn = await screen.findByTestId(
      "start-memory-game-btn",
      {},
      { timeout: 4000 },
    );
    fireEvent.click(startMemoryBtn);

    const doneObservingBtn = await screen.findByTestId(
      "finish-observe-btn",
      {},
      { timeout: 4000 },
    );
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
    fireEvent.click(doneObservingBtn);

    expect(
      await screen.findByTestId("memory-mic-countdown"),
    ).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(recorderMock.start).toHaveBeenCalledTimes(1);

    // Clicking stop on recall-voice-btn stops recorder and transcribes via server STT!
    await act(async () => {
      fireEvent.click(screen.getByTestId("recall-voice-btn"));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      (screen.getByTestId("recall-textarea") as HTMLTextAreaElement).value,
    ).toContain("diều giấy");

    // Submitting voice RECALL enters REVEAL with 6s Autopilot Round-2 countdown -> auto-opens CREATIVE + 3-2-1 mic countdown!
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit-recall-btn"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      await screen.findByTestId("memory-autopilot-reveal-coach"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("memory-reveal-autopilot-countdown"),
    ).toHaveTextContent("6");

    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });
    expect(screen.getByTestId("creative-stage")).toBeInTheDocument();
    expect(screen.getByTestId("memory-mic-countdown")).toBeInTheDocument();
  });

  it("exposes KaraokeStage Autopilot toggle that arms reference melody guide and focus word badges", async () => {
    const fakePlayer = {
      ready: true,
      playing: false,
      waiting: false,
      ended: false,
      segmentFinished: false,
      loopPass: 0,
      currentMs: 0,
      durationMs: 10000,
      volume: 0.7,
      muted: false,
      rate: 1,
      keyShift: 0,
      error: "",
      getCurrentMs: () => 0,
      subscribeClock: () => () => {},
      play: vi.fn(async () => {}),
      pause: vi.fn(),
      seek: vi.fn(),
      setVolume: vi.fn(),
      setMuted: vi.fn(),
      setRate: vi.fn(),
      setKeyShift: vi.fn(),
    };

    render(
      <KaraokeStage
        source={{
          song_id: "91000000-0000-4000-8000-000000000001",
          version_id: "92000000-0000-4000-8000-000000000001",
          title: "Vườn xuân lung linh",
          author: "ViRead CC0",
          duration_ms: 10000,
          audio_url: "http://127.0.0.1:8000/mock.mp3",
          audio_url_expires_at: "2099-01-01T00:00:00Z",
          cover_url: null,
          lyrics: {
            format_version: 2,
            lines: [
              {
                id: "94000000-0000-4000-8000-000000000001",
                text: "Lung linh giọt sương",
                start_ms: 1000,
                end_ms: 3500,
                syllables: [
                  {
                    id: "95000000-0000-4000-8000-000000000001",
                    text: "Lung",
                    start_ms: 1000,
                    end_ms: 1600,
                  },
                  {
                    id: "95000000-0000-4000-8000-000000000002",
                    text: "linh",
                    start_ms: 1650,
                    end_ms: 2250,
                  },
                ],
              },
            ],
          },
          melody_profile: {
            melody_version: 1,
            hop_ms: 80,
            duration_ms: 10000,
            min_midi: 64,
            max_midi: 69,
            median_midi: 67,
            bpm: 94,
            notes: [
              {
                start_ms: 1000,
                end_ms: 1600,
                midi: 67,
                hz: 392,
                confidence: 0.95,
                voiced: true,
                syllable_id: "95000000-0000-4000-8000-000000000001",
                line_id: "94000000-0000-4000-8000-000000000001",
                text: "Lung",
              },
              {
                start_ms: 1650,
                end_ms: 2250,
                midi: 69,
                hz: 440,
                confidence: 0.95,
                voiced: true,
                syllable_id: "95000000-0000-4000-8000-000000000002",
                line_id: "94000000-0000-4000-8000-000000000001",
                text: "linh",
              },
            ],
            pitch_contour: [
              { time_ms: 1000, hz: 392, midi: 67, confidence: 0.95 },
            ],
          },
        }}
        player={fakePlayer}
        childAlias="Bé An"
        label="Sân khấu Karaoke của Bé An"
        focusWords={["lung linh"]}
      />,
    );

    expect(screen.getByTestId("karaoke-focus-words-banner")).toHaveTextContent(
      "lung linh",
    );
    const autopilotToggle = screen.getByTestId("karaoke-autopilot-toggle");
    const melodyToggle = screen.getByTestId("karaoke-melody-guide-toggle");
    expect(autopilotToggle).toHaveAttribute("aria-pressed", "false");
    expect(melodyToggle).toHaveAttribute("aria-pressed", "false");

    await act(async () => {
      fireEvent.click(autopilotToggle);
      await Promise.resolve();
    });

    expect(autopilotToggle).toHaveAttribute("aria-pressed", "true");
    expect(melodyToggle).toHaveAttribute("aria-pressed", "true");
  });

  it("settles warmup Promise and resets step label cleanly when ReferenceMelodySynth.stop() interrupts warmup", async () => {
    vi.useFakeTimers();
    const synth = createReferenceMelodySynth();
    const steps: Array<[string | null, string | null]> = [];
    let resolved = false;
    const promise = synth
      .playWarmupSequence(0, (step, labelVi) => {
        steps.push([step, labelVi]);
      })
      .then(() => {
        resolved = true;
      });

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(steps.at(-1)).toEqual(["low", "Thấp · Đô 4"]);
    expect(resolved).toBe(false);

    // Interrupting mid-warmup must reset step to (null, null) and settle the Promise immediately!
    synth.stop();
    await Promise.resolve();
    await promise;
    expect(resolved).toBe(true);
    expect(steps.at(-1)).toEqual([null, null]);
    synth.dispose();
  });

  it("completes KaraokeStage Post-Song Autopilot Coach 5 -> 0s into 0.85x slow segment practice even when suggestedKeyShift re-renders player", async () => {
    vi.useFakeTimers();
    const armSpy = vi.fn(async () => true);
    const setRateSpy = vi.fn();
    const setKeyShiftSpy = vi.fn();
    const lineId = "94000000-0000-4000-8000-000000000001";

    const scoringSpy = vi
      .spyOn(karaokeScoringHook, "useKaraokeScoring")
      .mockReturnValue({
        supported: true,
        listening: false,
        status: "scored",
        score: null,
        liveScore: null,
        songScore: null,
        musicalScore: {
          overallScore: 68,
          stars: 2,
          rhythmScore: 70,
          pitchScore: 62,
          lyricsScore: 74,
          fluencyScore: 68,
          scoringMode: "FULL_MUSICAL",
          scoringModeLabelVi: "Chấm nhạc đầy đủ",
          pitchBasis: "REFERENCE_MELODY",
          pitchBasisLabelVi: "Theo giai điệu chuẩn",
          speakerBleedSuspected: false,
          practiceMode: "FULL_SONG",
          weightsUsed: { rhythm: 0.3, pitch: 0.35, lyrics: 0.25, fluency: 0.1 },
          activeVocalCoverage: 0.85,
          voicedCoverage: 0.85,
          meanCentsError: 18,
          meanSignedTimingOffsetMs: 0,
          meanAbsTimingErrorMs: 25,
          gateReason: "OK",
          guidanceVi: "Tập chậm câu 1 nhé!",
          encouragementVi: "Bé hát tốt lắm!",
          segments: [
            {
              lineIndex: 0,
              lineId,
              text: "Lung linh giọt sương",
              startMs: 1000,
              endMs: 3500,
              rhythmScore: 60,
              pitchScore: 48,
              lyricsScore: 58,
              vocalCoverage: 0.9,
              lineOverallScore: 54,
              status: "PRACTICE",
              tipVi: "Ngân cao hơn một chút ở chữ linh nhé!",
            },
          ],
          weakestSegment: {
            lineIndex: 0,
            lineId,
            text: "Lung linh giọt sương",
            startMs: 1000,
            endMs: 3500,
            rhythmScore: 60,
            pitchScore: 48,
            lyricsScore: 58,
            vocalCoverage: 0.9,
            lineOverallScore: 54,
            status: "PRACTICE",
            tipVi: "Ngân cao hơn một chút ở chữ linh nhé!",
          },
        },
        songMusicalScore: null,
        proScore: {
          kind: "scored",
          totalScore: 68,
          rank: "A",
          stars: 2,
          pitchScore: 62,
          rhythmScore: 70,
          lyricsScore: 74,
          weights: { pitch: 0.45, rhythm: 0.3, lyrics: 0.25 },
          activePillars: { pitch: true, rhythm: true, lyrics: true },
          hasReferenceMelody: true,
          keyShift: 0,
          suggestedKeyShift: -2,
          relativeMelodyScore: 62,
          pitchStabilityBonus: 0,
          meanCentsError: 18,
          timingBias: "on_beat",
          meanTimingDeltaMs: 0,
          meanAbsTimingErrorMs: 25,
          sustainCoverage: 0.8,
          maxCombo: 2,
          perfectNotes: 1,
          greatNotes: 1,
          goodNotes: 0,
          offPitchNotes: 1,
          gateReason: "OK",
          headlineVi: "Bé hát tốt lắm!",
          pitchInsightVi: "Hạ nhẹ 2 bán cung cho vừa giọng bé nhé!",
          rhythmInsightVi: "Giữ nhịp tốt!",
          lyricsInsightVi: "Rõ lời!",
          lineScores: [],
          worstLine: null,
        },
        songProScore: null,
        replayAudioUrl: null,
        dspFrames: [],
        sttAvailable: true,
        liveTelemetry: null,
        error: null,
        previewWords: new Map(),
        liveTranscript: "",
        signal: "voice",
        arm: armSpy,
        getPitchRing: () => [],
        getLatestPitchSample: () => null,
        observePlayback: vi.fn(),
        endPractice: vi.fn(),
        seekBoundary: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        finish: vi.fn(),
        reset: vi.fn(),
      });

    function StatefulStageHarness() {
      const [keyShift, setKeyShift] = useState(0);
      const [ended, setEnded] = useState(true);
      const [rate, setRate] = useState(1);
      // Fresh player object literal on every render — mirrors real `useKaraokePlayer`!
      const player = {
        ready: true,
        playing: false,
        waiting: false,
        ended,
        segmentFinished: false,
        loopPass: 0,
        currentMs: ended ? 10000 : 1000,
        durationMs: 10000,
        volume: 0.7,
        muted: false,
        rate,
        keyShift,
        error: "",
        getCurrentMs: () => (ended ? 10000 : 1000),
        subscribeClock: () => () => {},
        play: vi.fn(async () => {}),
        pause: vi.fn(),
        seek: vi.fn(() => setEnded(false)),
        setVolume: vi.fn(),
        setMuted: vi.fn(),
        setRate: (r: number) => {
          setRateSpy(r);
          setRate(r);
        },
        setKeyShift: (s: number) => {
          setKeyShiftSpy(s);
          setKeyShift(s);
        },
      };
      return (
        <KaraokeStage
          source={{
            song_id: "91000000-0000-4000-8000-000000000001",
            version_id: "92000000-0000-4000-8000-000000000001",
            title: "Vườn xuân lung linh",
            author: "ViRead CC0",
            duration_ms: 10000,
            audio_url: "http://127.0.0.1:8000/mock.mp3",
            audio_url_expires_at: "2099-01-01T00:00:00Z",
            cover_url: null,
            lyrics: {
              format_version: 2,
              lines: [
                {
                  id: lineId,
                  text: "Lung linh giọt sương",
                  start_ms: 1000,
                  end_ms: 3500,
                  syllables: [],
                },
              ],
            },
            melody_profile: null,
          }}
          player={player}
          childAlias="Bé An"
          label="Sân khấu Karaoke của Bé An"
          initialAutopilot
        />
      );
    }

    try {
      await act(async () => {
        render(<StatefulStageHarness />);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(setKeyShiftSpy).toHaveBeenCalledWith(-2);
      expect(
        screen.getByTestId("karaoke-autopilot-keyshift-note"),
      ).toHaveTextContent("-2 bán cung");
      expect(
        screen.getByTestId("karaoke-autopilot-countdown"),
      ).toHaveTextContent("5");

      // Advance 1s at a time: countdown must NOT freeze after setKeyShift(-2) re-rendered player!
      for (const expectedRemaining of ["4", "3", "2", "1"]) {
        await act(async () => {
          vi.advanceTimersByTime(1000);
          await Promise.resolve();
        });
        expect(
          screen.getByTestId("karaoke-autopilot-countdown"),
        ).toHaveTextContent(expectedRemaining);
      }

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      expect(setRateSpy).toHaveBeenCalledWith(0.85);
      expect(armSpy).toHaveBeenCalledWith(lineId);
    } finally {
      scoringSpy.mockRestore();
    }
  });

  it("cancels KaraokeStage Post-Song Autopilot Coach cleanly when switching to Gõ nhịp at 1s", async () => {
    vi.useFakeTimers();
    const setRateSpy = vi.fn();
    const lineId = "94000000-0000-4000-8000-000000000001";
    const scoringSpy = vi
      .spyOn(karaokeScoringHook, "useKaraokeScoring")
      .mockReturnValue({
        supported: true,
        listening: false,
        status: "scored",
        score: null,
        liveScore: null,
        songScore: null,
        musicalScore: {
          overallScore: 68,
          stars: 2,
          rhythmScore: 70,
          pitchScore: 62,
          lyricsScore: 74,
          fluencyScore: 68,
          scoringMode: "FULL_MUSICAL",
          scoringModeLabelVi: "Chấm nhạc đầy đủ",
          pitchBasis: "REFERENCE_MELODY",
          pitchBasisLabelVi: "Theo giai điệu chuẩn",
          speakerBleedSuspected: false,
          practiceMode: "FULL_SONG",
          weightsUsed: { rhythm: 0.3, pitch: 0.35, lyrics: 0.25, fluency: 0.1 },
          activeVocalCoverage: 0.85,
          voicedCoverage: 0.85,
          meanCentsError: 18,
          meanSignedTimingOffsetMs: 0,
          meanAbsTimingErrorMs: 25,
          gateReason: "OK",
          guidanceVi: "Tập chậm câu 1 nhé!",
          encouragementVi: "Bé hát tốt lắm!",
          segments: [],
          weakestSegment: {
            lineIndex: 0,
            lineId,
            text: "Lung linh giọt sương",
            startMs: 1000,
            endMs: 3500,
            rhythmScore: 60,
            pitchScore: 48,
            lyricsScore: 58,
            vocalCoverage: 0.9,
            lineOverallScore: 54,
            status: "PRACTICE",
            tipVi: "Ngân cao hơn một chút!",
          },
        },
        songMusicalScore: null,
        proScore: null,
        songProScore: null,
        replayAudioUrl: null,
        dspFrames: [],
        sttAvailable: true,
        liveTelemetry: null,
        error: null,
        previewWords: new Map(),
        liveTranscript: "",
        signal: "voice",
        arm: vi.fn(async () => true),
        getPitchRing: () => [],
        getLatestPitchSample: () => null,
        observePlayback: vi.fn(),
        endPractice: vi.fn(),
        seekBoundary: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        finish: vi.fn(),
        reset: vi.fn(),
      });

    try {
      await act(async () => {
        render(
          <KaraokeStage
            source={{
              song_id: "91000000-0000-4000-8000-000000000001",
              version_id: "92000000-0000-4000-8000-000000000001",
              title: "Vườn xuân lung linh",
              author: "ViRead CC0",
              duration_ms: 10000,
              audio_url: "http://127.0.0.1:8000/mock.mp3",
              audio_url_expires_at: "2099-01-01T00:00:00Z",
              cover_url: null,
              lyrics: {
                format_version: 2,
                lines: [
                  {
                    id: lineId,
                    text: "Lung linh giọt sương",
                    start_ms: 1000,
                    end_ms: 3500,
                    syllables: [],
                  },
                ],
              },
              melody_profile: null,
            }}
            player={{
              ready: true,
              playing: false,
              waiting: false,
              ended: true,
              segmentFinished: false,
              loopPass: 0,
              currentMs: 10000,
              volume: 0.7,
              rate: 1,
              keyShift: 0,
              error: "",
              getCurrentMs: () => 10000,
              subscribeClock: () => () => {},
              play: vi.fn(async () => {}),
              pause: vi.fn(),
              seek: vi.fn(),
              setVolume: vi.fn(),
              setMuted: vi.fn(),
              setRate: setRateSpy,
              setKeyShift: vi.fn(),
            }}
            childAlias="Bé An"
            label="Sân khấu Karaoke của Bé An"
            initialAutopilot
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      // Advance down to 1s remaining on `karaoke-autopilot-coach`
      await act(async () => {
        vi.advanceTimersByTime(4000);
        await Promise.resolve();
      });
      expect(
        screen.getByTestId("karaoke-autopilot-countdown"),
      ).toHaveTextContent("1");

      // Switch tab to "Gõ nhịp" right at 1s
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Gõ nhịp/i }));
        await Promise.resolve();
      });
      expect(
        screen.queryByTestId("karaoke-autopilot-coach"),
      ).not.toBeInTheDocument();

      // Even after 10 more seconds, timer never fires late SEGMENT 0.85x!
      await act(async () => {
        vi.advanceTimersByTime(10000);
        await Promise.resolve();
      });
      expect(setRateSpy).not.toHaveBeenCalledWith(0.85);
    } finally {
      scoringSpy.mockRestore();
    }
  });
});
