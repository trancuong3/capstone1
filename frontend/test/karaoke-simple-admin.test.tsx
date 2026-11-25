import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KaraokeSimpleUploadScreen } from "@/components/admin/karaoke/karaoke-simple-upload-screen";
import { KaraokeWorkspaceScreen } from "@/components/admin/karaoke/karaoke-workspace-screen";
import {
  SyllableTimingEditor,
  type TimingControls,
} from "@/components/admin/karaoke/syllable-timing-editor";
import { KaraokeServicesProvider } from "@/components/karaoke/karaoke-services-provider";
import type {
  KaraokeSimpleImportService,
  SimpleImportResult,
} from "@/lib/api/karaoke-simple-import-service";
import {
  classifyAudioBuffer,
  cleanFilenameToTitle,
  type AudioBufferLike,
  type AudioClassificationResult,
} from "@/lib/karaoke/audio-type-classifier";
import {
  lineId,
  previewDetail,
  songDetail,
  songId,
  syllableLyrics,
  versionId,
} from "@/test/karaoke-fixtures";
import { makeWizardFixture } from "@/test/karaoke-wizard-fixture";

const { push, replace } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));

function makeBuffer(
  sampleRate: number,
  channels: Float32Array[],
): AudioBufferLike {
  const length = channels[0].length;
  return {
    sampleRate,
    length,
    duration: length / sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (ch: number) => channels[ch],
  };
}

function makeStereoVocalBuffer(
  seconds = 4,
  sampleRate = 16000,
): AudioBufferLike {
  const len = Math.floor(seconds * sampleRate);
  const left = new Float32Array(len);
  const right = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    // Syllabic 4 Hz amplitude envelope + centered harmonic singing (360 Hz, 720 Hz, 1080 Hz).
    const syllabic = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    const vocal =
      syllabic *
      (0.55 * Math.sin(2 * Math.PI * 360 * t) +
        0.28 * Math.sin(2 * Math.PI * 720 * t) +
        0.15 * Math.sin(2 * Math.PI * 1080 * t));
    // Soft wide stereo bass accompaniment (110 Hz anti-phase).
    const backing = 0.14 * Math.sin(2 * Math.PI * 110 * t);
    left[i] = vocal + backing;
    right[i] = vocal - backing;
  }
  return makeBuffer(sampleRate, [left, right]);
}

function makeStereoInstrumentalBuffer(
  seconds = 4,
  sampleRate = 16000,
): AudioBufferLike {
  const len = Math.floor(seconds * sampleRate);
  const left = new Float32Array(len);
  const right = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    // Wide stereo accompaniment + steady low bass (no centered modulated singing).
    const bass = 0.5 * Math.sin(2 * Math.PI * 110 * t);
    const wideMid = 0.35 * Math.sin(2 * Math.PI * 520 * t);
    const hiShimmer = 0.2 * Math.sin(2 * Math.PI * 4800 * t);
    left[i] = bass + wideMid + hiShimmer;
    right[i] = bass - wideMid - hiShimmer;
  }
  return makeBuffer(sampleRate, [left, right]);
}

function makeMonoVocalBuffer(seconds = 4, sampleRate = 16000): AudioBufferLike {
  const len = Math.floor(seconds * sampleRate);
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const syllabic = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.8 * t);
    mono[i] =
      syllabic *
      (0.6 * Math.sin(2 * Math.PI * 420 * t) +
        0.3 * Math.sin(2 * Math.PI * 840 * t));
  }
  return makeBuffer(sampleRate, [mono]);
}

function makeMonoInstrumentalBuffer(
  seconds = 4,
  sampleRate = 16000,
): AudioBufferLike {
  const len = Math.floor(seconds * sampleRate);
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    // Steady low-frequency bass/organ chord outside vocal formants.
    mono[i] =
      0.5 * Math.sin(2 * Math.PI * 100 * t) +
      0.4 * Math.sin(2 * Math.PI * 190 * t);
  }
  return makeBuffer(sampleRate, [mono]);
}

function makeRhythmic120BpmBuffer(
  seconds = 6,
  sampleRate = 16000,
): AudioBufferLike {
  const len = Math.floor(seconds * sampleRate);
  const mono = new Float32Array(len);
  const beatSamples = Math.round(sampleRate * 0.5); // 120 BPM = 0.5s/beat
  for (let i = 0; i < len; i++) {
    const posInBeat = i % beatSamples;
    const env = Math.exp(-posInBeat / (sampleRate * 0.04));
    mono[i] = 0.8 * env * Math.sin((2 * Math.PI * 140 * i) / sampleRate);
  }
  return makeBuffer(sampleRate, [mono]);
}

function makeSimpleImportResult(
  overrides: Partial<SimpleImportResult> = {},
): SimpleImportResult {
  const detail = songDetail();
  detail.revision = 2;
  detail.draft!.title = "Cháu lên ba";
  detail.draft!.author = "Phạm Tuyên";
  detail.draft!.has_cover = true;
  detail.draft!.source_note = "";
  detail.draft!.usage_note = "";
  detail.draft!.lyrics = syllableLyrics();

  return {
    song_id: songId,
    version_id: versionId,
    revision: 2,
    title: "Cháu lên ba",
    author: "Phạm Tuyên",
    duration_ms: 20000,
    has_cover: true,
    audio_type: "VOCAL_FULL",
    bpm: 118,
    lyrics_source: "GROQ_WHISPER",
    lyrics_line_count: 1,
    flagged_lines: [
      {
        line_id: lineId,
        line_index: 0,
        text: detail.draft!.lyrics.lines[0].text,
        flag: "NEEDS_REVIEW",
        reason: "Độ tin cậy nhận diện thấp (avg_logprob=-0.75).",
        avg_logprob: -0.75,
        no_speech_prob: 0.08,
      },
    ],
    requires_lyrics_input: false,
    guidance_vi: "Đã tự nhận diện 1 dòng lời bằng Groq Whisper.",
    ready_to_publish: false,
    missing_checks: [
      "SOURCE_REQUIRED",
      "USAGE_REQUIRED",
      "RIGHTS_CONFIRMATION_REQUIRED",
      "CHILD_SAFE_CONFIRMATION_REQUIRED",
    ],
    song: detail,
    ...overrides,
  };
}

function makeMockSimpleService(
  importResult: SimpleImportResult = makeSimpleImportResult(),
) {
  const published = songDetail();
  published.status = "PUBLISHED";
  published.revision = 4;
  published.published = { ...published.draft!, state: "PUBLISHED" };
  published.draft = null;

  return {
    simpleImport: vi.fn().mockResolvedValue(importResult),
    simplePublish: vi.fn().mockResolvedValue(published),
  } satisfies KaraokeSimpleImportService;
}

const vocalClassification: AudioClassificationResult = {
  audioType: "VOCAL_FULL",
  estimatedBpm: 118,
  confidence: 0.88,
  guidanceVi: "Phát hiện bài hát có giọng hát.",
  metrics: {
    midSideRatio: 3.1,
    vocalBandRatio: 0.72,
    modulationDepth: 0.45,
    voicedFrameRatio: 0.75,
    isStereo: true,
  },
};

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("audio-type-classifier deterministic DSP", () => {
  it("classifies stereo vocal vs stereo instrumental buffers accurately", () => {
    const vocal = classifyAudioBuffer(makeStereoVocalBuffer());
    expect(vocal.audioType).toBe("VOCAL_FULL");
    expect(vocal.confidence).toBeGreaterThanOrEqual(0.56);
    expect(vocal.metrics.midSideRatio).toBeGreaterThan(1.5);
    expect(vocal.guidanceVi).toContain("giọng hát");

    const instrumental = classifyAudioBuffer(makeStereoInstrumentalBuffer());
    expect(instrumental.audioType).toBe("INSTRUMENTAL_ONLY");
    expect(instrumental.confidence).toBeGreaterThanOrEqual(0.56);
    expect(instrumental.guidanceVi).toContain("Instrumental");
  });

  it("classifies mono vocal vs mono instrumental and handles silence & BPM", () => {
    const monoVocal = classifyAudioBuffer(makeMonoVocalBuffer());
    expect(monoVocal.audioType).toBe("VOCAL_FULL");

    const monoInst = classifyAudioBuffer(makeMonoInstrumentalBuffer());
    expect(monoInst.audioType).toBe("INSTRUMENTAL_ONLY");

    const silent = classifyAudioBuffer(
      makeBuffer(16000, [new Float32Array(32000)]),
    );
    expect(silent.audioType).toBe("UNKNOWN");

    const beat = classifyAudioBuffer(makeRhythmic120BpmBuffer());
    expect(beat.estimatedBpm).not.toBeNull();
    expect(Math.abs((beat.estimatedBpm ?? 0) - 120)).toBeLessThanOrEqual(10);
  });

  it("cleans track numbers and noise tags from uploaded MP3 filenames", () => {
    expect(
      cleanFilenameToTitle("01_Chau_Len_Ba_(Official_Audio)_[320kbps].mp3"),
    ).toBe("Chau Len Ba");
  });
});

describe("Admin Karaoke Simple Mode workflow", () => {
  it("runs 1-MP3 upload -> Review by Exception -> unchecked safety checkboxes -> publish", async () => {
    const { service } = makeWizardFixture();
    service.preview.mockResolvedValue(previewDetail());
    const simpleService = makeMockSimpleService();
    const classifier = vi.fn().mockResolvedValue(vocalClassification);

    render(
      <KaraokeServicesProvider service={service}>
        <KaraokeSimpleUploadScreen
          simpleService={simpleService}
          classifier={classifier}
        />
      </KaraokeServicesProvider>,
    );

    const mp3File = new File(["synthetic-mp3"], "01_Chau_Len_Ba_(HQ).mp3", {
      type: "audio/mpeg",
    });
    fireEvent.change(screen.getByLabelText("Chọn file nhạc MP3"), {
      target: { files: [mp3File] },
    });

    await waitFor(() =>
      expect(screen.getByTestId("audio-type-badge")).toHaveTextContent(
        "Có giọng hát (Vocal)",
      ),
    );
    expect(screen.getByLabelText("Tên bài hát gợi ý")).toHaveValue(
      "Chau Len Ba",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Tự động tạo karaoke" }),
    );

    await screen.findByText(/Bước 2 — Kiểm tra nhanh/);
    expect(simpleService.simpleImport).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/Có 1 dòng cần kiểm tra nhanh/),
    ).toBeInTheDocument();
    expect(screen.getByText("Đã tự tách ảnh bìa MP3")).toBeInTheDocument();

    // Visible, pre-filled, editable notes MUST NOT be hidden in a collapsed details tag.
    const sourceInput = screen.getByLabelText("Nguồn nhạc và lời");
    const usageInput = screen.getByLabelText("Quyền sử dụng nội dung");
    expect(sourceInput).toBeVisible();
    expect(usageInput).toBeVisible();
    expect((sourceInput as HTMLInputElement).value.length).toBeGreaterThan(0);
    expect((usageInput as HTMLInputElement).value.length).toBeGreaterThan(0);

    // Safety checkboxes MUST be UNCHECKED by default and publish button disabled until BOTH are checked!
    const rightsCheckbox = screen.getByRole("checkbox", {
      name: /Tôi xác nhận quyền sử dụng bài hát phù hợp/,
    });
    const childSafeCheckbox = screen.getByRole("checkbox", {
      name: /Tôi xác nhận nội dung phù hợp trẻ em lớp 1–5/,
    });
    const publishBtn = screen.getByRole("button", { name: "Xuất bản ngay" });

    expect(rightsCheckbox).not.toBeChecked();
    expect(childSafeCheckbox).not.toBeChecked();
    expect(publishBtn).toBeDisabled();

    fireEvent.click(rightsCheckbox);
    expect(publishBtn).toBeDisabled();

    fireEvent.click(childSafeCheckbox);
    expect(publishBtn).toBeEnabled();

    fireEvent.click(publishBtn);
    await screen.findByText("Đã xuất bản bài hát");
    expect(simpleService.simplePublish).toHaveBeenCalledWith(
      songId,
      expect.objectContaining({
        expected_revision: 2,
        draft_version_id: versionId,
        rights_confirmed: true,
        child_safe_confirmed: true,
      }),
      expect.any(AbortSignal),
    );
  });

  it("defaults /admin/karaoke/new to Simple Mode even when offline worker is OFF and toggles to Advanced Editor in 1 click", async () => {
    const { service } = makeWizardFixture();
    service.getProcessingCapabilities.mockResolvedValue({
      enabled: false,
      configured: false,
      active_song_job_limit: 1,
      hourly_admin_job_limit: 10,
      max_audio_bytes: 20 * 1024 * 1024,
      max_duration_ms: 300000,
    });
    const simpleService = makeMockSimpleService();

    render(
      <KaraokeServicesProvider service={service}>
        <KaraokeWorkspaceScreen simpleService={simpleService} />
      </KaraokeServicesProvider>,
    );

    await screen.findByText("Thêm nhanh 1 file MP3");
    expect(
      screen.getByRole("button", { name: "Tự động tạo karaoke" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Chỉnh sửa nâng cao" }));
    await screen.findByRole("button", { name: "Tạo bản nháp" });
  });

  it("handles INSTRUMENTAL_ONLY draft cleanly with 1-step inline lyrics & Spacebar tap-to-sync", async () => {
    const { service } = makeWizardFixture();
    service.preview.mockResolvedValue(previewDetail());
    const emptyDetail = songDetail();
    emptyDetail.revision = 2;
    emptyDetail.draft!.lyrics = { format_version: 1, lines: [] };

    const instrumentalResult = makeSimpleImportResult({
      audio_type: "INSTRUMENTAL_ONLY",
      lyrics_source: "NONE",
      lyrics_line_count: 0,
      flagged_lines: [],
      requires_lyrics_input: true,
      guidance_vi:
        "File được nhận diện là nhạc nền không lời (Instrumental). Hãy dán lời bài hát ngay bên dưới.",
      song: emptyDetail,
    });
    const simpleService = makeMockSimpleService(instrumentalResult);
    const instClassifier = vi.fn().mockResolvedValue({
      ...vocalClassification,
      audioType: "INSTRUMENTAL_ONLY" as const,
      guidanceVi: "Phát hiện nhạc nền không lời (Instrumental).",
    });

    render(
      <KaraokeServicesProvider service={service}>
        <KaraokeSimpleUploadScreen
          simpleService={simpleService}
          classifier={instClassifier}
        />
      </KaraokeServicesProvider>,
    );

    const mp3File = new File(["beat-bytes"], "beat_nhac_nen.mp3", {
      type: "audio/mpeg",
    });
    fireEvent.change(screen.getByLabelText("Chọn file nhạc MP3"), {
      target: { files: [mp3File] },
    });
    await waitFor(() =>
      expect(screen.getByTestId("audio-type-badge")).toHaveTextContent(
        "Nhạc nền không lời (Instrumental)",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Tự động tạo karaoke" }),
    );

    await screen.findByText(/Chưa có lời bài hát — dán lời/);
    // Publish MUST remain disabled even if both checkboxes are ticked before lyrics are added!
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Tôi xác nhận quyền sử dụng bài hát phù hợp/,
      }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Tôi xác nhận nội dung phù hợp trẻ em lớp 1–5/,
      }),
    );
    expect(
      screen.getByRole("button", { name: "Xuất bản ngay" }),
    ).toBeDisabled();

    // Paste 2 lines and apply in 1 click -> enables Spacebar 1-pass tap-sync AND publish!
    fireEvent.change(screen.getByLabelText("Dán lời bài hát hoặc .lrc"), {
      target: { value: "Cháu lên ba\nCháu đi mẫu giáo" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Áp dụng lời & chia mốc nhanh" }),
    );
    await screen.findByText(/Có 2 dòng cần kiểm tra nhanh/);

    // Run 1-pass Spacebar Tap-to-Sync across both lines -> clears NEEDS_TIMING_CHECK flags!
    fireEvent.click(
      screen.getByRole("button", { name: "Căn nhịp nhanh bằng phím Space" }),
    );
    const tapBtn = await screen.findByRole("button", {
      name: /Gõ nhịp \(Space\)/,
    });
    fireEvent.click(tapBtn);
    fireEvent.click(tapBtn);
    await screen.findByText(/Đã hoàn tất căn nhịp 1 lượt bằng phím Space/);

    expect(screen.getByRole("button", { name: "Xuất bản ngay" })).toBeEnabled();
  });
});

describe("SyllableTimingEditor paused rAF performance fix", () => {
  it("does NOT schedule requestAnimationFrame while paused, and runs/cancels cleanly on play/pause", () => {
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 42);
    const cafSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});

    const line = syllableLyrics().lines[0];
    const basePlayer: TimingControls = {
      ready: true,
      playing: false,
      getCurrentMs: () => 1200,
      play: vi.fn(async () => {}),
      pause: vi.fn(),
    };

    const { rerender } = render(
      <SyllableTimingEditor
        line={line}
        lineNumber={1}
        lines={[line]}
        duration={20000}
        disabled={false}
        player={basePlayer}
        onChange={vi.fn()}
      />,
    );

    expect(rafSpy).not.toHaveBeenCalled();

    rerender(
      <SyllableTimingEditor
        line={line}
        lineNumber={1}
        lines={[line]}
        duration={20000}
        disabled={false}
        player={{ ...basePlayer, playing: true }}
        onChange={vi.fn()}
      />,
    );
    expect(rafSpy).toHaveBeenCalledTimes(1);

    rerender(
      <SyllableTimingEditor
        line={line}
        lineNumber={1}
        lines={[line]}
        duration={20000}
        disabled={false}
        player={{ ...basePlayer, playing: false }}
        onChange={vi.fn()}
      />,
    );
    expect(cafSpy).toHaveBeenCalledWith(42);
  });
});
