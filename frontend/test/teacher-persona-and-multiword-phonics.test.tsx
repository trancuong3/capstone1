import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReadingCompanionBubble } from "@/components/reading/reading-companion-bubble";
import { VoiceEngineBadge } from "@/components/reading/voice-engine-badge";
import { InteractivePromptSelector } from "@/lib/reading/interactive-prompts";
import {
  generateSpokenPhonicsGuide,
  matchPhonicsSpelling,
} from "@/lib/reading/phonics-spelling";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import { classifyYesNoVoiceIntent } from "@/lib/reading/retry-word-recognition";
import {
  getEffectiveTeacherPersona,
  getEffectiveVoiceId,
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
} from "@/lib/reading/session-voice-lock";
import {
  resetSpeechPreferencesCache,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import {
  recordSttEngineUsage,
  recordTtsEngineUsage,
  resetVoiceEngineStatus,
} from "@/lib/reading/voice-engine-status";
import {
  adaptTextToTeacherPersona,
  resolveVoiceGender,
} from "@/lib/reading/voice-persona";
import type { ReadingPageWordDTO } from "@/types/reading";

function makeWords(words: string[]): ReadingPageWordDTO[] {
  return words.map((text, idx) => ({
    word_id: `w-${idx + 1}`,
    word_index: idx,
    text,
    normalized_text: text.toLowerCase(),
    char_start: idx * 5,
    char_end: idx * 5 + text.length,
    bbox: [0, 0, 10, 10],
  }));
}

describe("Multi-word Vietnamese phonics sequence & child reading alignment", () => {
  it("matches single-vowel toned rhyme cue ('ư nặng ự tự' -> 'tự')", () => {
    const match = matchPhonicsSpelling(["ư", "nặng", "ự", "tự"], "tự");
    expect(match).not.toBeNull();
    expect(match?.consumedCount).toBe(4);
  });

  it("handles spelling 4 words ('môi trường tự nhiên') before reading the whole phrase without marking subsequent words RED", () => {
    const engine = new RealtimeAlignmentEngine(
      makeWords(["Môi", "trường", "tự", "nhiên"]),
    );

    // Child spells word 1, then spells upcoming words 3 & 4 in a row before reading the phrase
    const mid = engine.addFinalTranscript(
      "ô i ôi mờ ôi môi ư nặng ự tự i ê nờ iên nhờ iên nhiên",
    );
    const redDuringSpelling = [...mid.statusByWordId.values()].filter(
      (w) => w.status === "SUBSTITUTE" || w.status === "DELETE",
    );
    expect(redDuringSpelling).toHaveLength(0);

    // Now the child smoothly reads the full 4-word phrase
    const final = engine.addFinalTranscript("môi trường tự nhiên");
    expect(
      ["w-1", "w-2", "w-3", "w-4"].map(
        (id) => final.statusByWordId.get(id)?.status,
      ),
    ).toEqual(["MATCH", "MATCH", "MATCH", "MATCH"]);
  });

  it("still preserves G1 zero false-correct when child misreads tone ('ma' for 'má')", () => {
    const engine = new RealtimeAlignmentEngine(makeWords(["má", "ơi"]));
    const snap = engine.addFinalTranscript("ma ơi");
    expect(snap.statusByWordId.get("w-1")?.status).not.toBe("MATCH");
  });
});

describe("Teacher Persona (Cô giáo AI vs Thầy giáo AI) & unified voice lock", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetSpeechPreferencesCache();
    resetVoiceLockAndPolicyForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it("resolves gender accurately and adapts Vietnamese teacher pronouns without corrupting 'con/công/cố'", () => {
    expect(resolveVoiceGender("local_north_truc_ly")).toBe("female");
    expect(resolveVoiceGender("local_north_thien_minh")).toBe("male");
    expect(resolveVoiceGender("local_central_quang_son")).toBe("male");
    expect(resolveVoiceGender("local_south_thai_son")).toBe("male");

    const adapted = adaptTextToTeacherPersona(
      "Cô giáo khen con cố gắng công phu, đọc cùng cô nhé!",
      "male",
    );
    expect(adapted).toBe(
      "Thầy giáo khen con cố gắng công phu, đọc cùng thầy nhé!",
    );
  });

  it("synchronizes male voice & Thầy giáo AI persona across Reading -> Difficult Words -> Prompts -> Phonics", () => {
    setSpeechPreferences({ voiceId: "local_north_thien_minh", speed: 0.9 });
    const readingLock = lockSessionVoice("session-read-1");
    expect(readingLock.voiceId).toBe("local_north_thien_minh");
    expect(readingLock.gender).toBe("male");

    // Transition to Difficult Word Practice: must keep the exact same male voice!
    const practiceLock = lockSessionVoice("practice_child-1", {
      forceUpdate: true,
    });
    expect(practiceLock.voiceId).toBe("local_north_thien_minh");
    expect(practiceLock.gender).toBe("male");
    expect(getEffectiveVoiceId()).toBe("local_north_thien_minh");
    expect(getEffectiveTeacherPersona().title).toBe("Thầy giáo AI");

    const selector = new InteractivePromptSelector();
    const wrapUp = selector.next("postReadingWrongWordsAsk");
    expect(wrapUp).toContain("thầy");
    expect(wrapUp).not.toMatch(/(^|\s)cô(\s|$)/i);

    const phonicsGuide = generateSpokenPhonicsGuide("cá", "male");
    expect(phonicsGuide).toContain("thầy");
    expect(phonicsGuide).not.toContain("cô");

    render(
      <ReadingCompanionBubble
        state={{
          mood: "comforting",
          title: "Cô giáo dịu dàng",
          message: "Đừng lo, có cô ở đây cùng con!",
        }}
      />,
    );
    const bubble = screen.getByTestId("reading-companion-bubble");
    expect(bubble.getAttribute("data-teacher-persona")).toBe("male");
    expect(bubble.textContent).toContain("Thầy giáo AI dịu dàng");
    expect(bubble.textContent).toContain("có thầy ở đây cùng con");
  });

  it("classifies post-reading voice Yes/No answers accurately", () => {
    expect(classifyYesNoVoiceIntent("dạ có con muốn đọc lại")).toBe("yes");
    expect(classifyYesNoVoiceIntent("có")).toBe("yes");
    expect(classifyYesNoVoiceIntent("không con muốn bỏ qua")).toBe("no");
    expect(classifyYesNoVoiceIntent("thôi để sau")).toBe("no");
  });
});

describe("Live STT & TTS Engine Source Indicator (<VoiceEngineBadge />)", () => {
  beforeEach(() => {
    resetVoiceEngineStatus();
  });

  afterEach(() => {
    cleanup();
  });

  it("reflects all 3 engine tiers live: Local Offline -> Google Cloud API -> Browser Default", () => {
    recordSttEngineUsage({ provider: "local", fallbackUsed: false });
    recordTtsEngineUsage({
      provider: "local",
      fallbackUsed: false,
      voiceId: "local_north_truc_ly",
      voiceGender: "female",
    });

    const { rerender } = render(<VoiceEngineBadge />);
    const badge = screen.getByTestId("voice-engine-status-badge");
    expect(badge.getAttribute("data-stt-tier")).toBe("local_offline");
    expect(badge.getAttribute("data-tts-tier")).toBe("local_offline");
    expect(badge.textContent).toContain("Offline (Sherpa-ONNX)");
    expect(badge.textContent).toContain("Offline (VieNeu-TTS)");

    // Fallback tier 1: Google Cloud API
    recordSttEngineUsage({
      provider: "google",
      fallbackUsed: true,
      fallbackReason: "LOCAL_STT_UNAVAILABLE",
    });
    recordTtsEngineUsage({
      provider: "google",
      fallbackUsed: true,
      fallbackReason: "LOCAL_TTS_UNAVAILABLE",
      voiceId: "google_vi_vn_neural2_a",
      voiceGender: "female",
    });
    rerender(<VoiceEngineBadge />);
    expect(badge.getAttribute("data-stt-tier")).toBe("google_cloud");
    expect(badge.getAttribute("data-tts-tier")).toBe("google_cloud");
    expect(badge.textContent).toContain("Google Cloud API");

    // Fallback tier 2: Browser Default
    recordSttEngineUsage({
      provider: "browser",
      fallbackUsed: true,
      fallbackReason: "BROWSER_SPEECH_RECOGNITION",
    });
    recordTtsEngineUsage({
      provider: "browser",
      fallbackUsed: true,
      fallbackReason: "BROWSER_TTS",
    });
    rerender(<VoiceEngineBadge />);
    expect(badge.getAttribute("data-stt-tier")).toBe("browser_default");
    expect(badge.getAttribute("data-tts-tier")).toBe("browser_default");
    expect(badge.textContent).toContain("Trình duyệt mặc định");

    // Compact badge clearly distinguishes Online vs Offline
    rerender(<VoiceEngineBadge compact />);
    expect(badge.textContent).toContain("Online (Google/Trình duyệt)");

    recordSttEngineUsage({ provider: "google", fallbackUsed: true });
    rerender(<VoiceEngineBadge compact />);
    expect(badge.textContent).toContain("Online (Google API)");

    recordSttEngineUsage({ provider: "local", fallbackUsed: false });
    rerender(<VoiceEngineBadge compact />);
    expect(badge.textContent).toContain("STT: Offline");
  });
});
