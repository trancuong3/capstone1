import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import {
  getSpeechPreferences,
  resetSpeechPreferencesCache,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import {
  getVoicePolicyPreferences,
  resetVoiceLockAndPolicyForTests,
} from "@/lib/reading/session-voice-lock";

const { voiceStudioMock } = vi.hoisted(() => ({
  voiceStudioMock: { listVoices: vi.fn(), synthesizeTimed: vi.fn() },
}));
vi.mock("@/lib/api/voice-studio-service", () => ({
  createVoiceStudioService: () => voiceStudioMock,
}));

const VOICES = {
  default_voice_id: "voice_default",
  voices: [
    {
      voice_id: "voice_default",
      name: "Jessica - Playful",
      gender: "female",
      accent: "american",
    },
    {
      voice_id: "voice_roger",
      name: "Roger - Laid-Back",
      gender: "male",
      accent: "british",
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetSpeechPreferencesCache();
  resetVoiceLockAndPolicyForTests();
  voiceStudioMock.listVoices.mockReset().mockResolvedValue(VOICES);
});

function setup(
  props: Partial<Parameters<typeof ReadingVoiceSettings>[0]> = {},
) {
  const onPreview = vi.fn();
  const onStopPreview = vi.fn();
  render(
    <ReadingVoiceSettings
      onPreview={onPreview}
      onStopPreview={onStopPreview}
      {...props}
    />,
  );
  return { onPreview, onStopPreview };
}

describe("reading voice settings", () => {
  it("resets a removed stored voice to default without guessing metadata", async () => {
    setSpeechPreferences({ voiceId: "deleted_voice" });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    expect(await screen.findByRole("radio", { name: /Jessica/ })).toBeChecked();
    expect(getSpeechPreferences().voiceId).toBeNull();
    expect(
      screen.queryByRole("option", { name: "Giọng trẻ trung" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Tất cả giọng đọc" }),
    ).toBeInTheDocument();
  });

  it("filters male, female and youthful voices only from supplied metadata", async () => {
    voiceStudioMock.listVoices.mockResolvedValueOnce({
      ...VOICES,
      voices: [
        ...VOICES.voices,
        { voice_id: "v_young", name: "Mai", age: "young" },
        { voice_id: "v_unknown", name: "Youthful child girl" },
      ],
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    const filter = await screen.findByRole("combobox", {
      name: "Lọc giọng đọc",
    });
    await user.selectOptions(filter, "male");
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    await user.click(screen.getByRole("radio", { name: /Roger/ }));
    expect(getSpeechPreferences().voiceId).toBe("voice_roger");
    await user.selectOptions(filter, "female");
    await user.click(screen.getByRole("radio", { name: /Jessica/ }));
    expect(getSpeechPreferences().voiceId).toBeNull();
    await user.selectOptions(filter, "young");
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /Mai/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: /Youthful child girl/ }),
    ).not.toBeInTheDocument();
  });

  it("shows a genuine empty voice list and allows reset", async () => {
    voiceStudioMock.listVoices.mockResolvedValueOnce({
      voices: [],
      default_voice_id: "default",
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    expect(
      await screen.findByText(/Chưa có giọng đọc trong danh sách/),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    await user.click(
      screen.getByRole("button", { name: "Dùng giọng mặc định" }),
    );
    expect(getSpeechPreferences().voiceId).toBeNull();
  });

  it("stops an active preview before voice or speed changes", async () => {
    const user = userEvent.setup();
    const { onStopPreview } = setup({ isPreviewing: true });
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    await user.click(await screen.findByRole("radio", { name: /Roger/ }));
    await user.click(screen.getByRole("button", { name: "Chậm" }));
    expect(onStopPreview).toHaveBeenCalledTimes(2);
  });

  it("ignores a canceled voice-list response after reopening the dialog", async () => {
    let oldResult!: (value: typeof VOICES) => void;
    voiceStudioMock.listVoices.mockReturnValueOnce(
      new Promise((resolve) => {
        oldResult = resolve;
      }),
    );
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    const signal = voiceStudioMock.listVoices.mock.calls[0][0] as AbortSignal;
    await user.click(screen.getByRole("button", { name: "Đóng hộp thoại" }));
    expect(signal.aborted).toBe(true);
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    await screen.findByRole("radio", { name: /Roger/ });
    oldResult({ voices: [], default_voice_id: "obsolete" });
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Roger/ })).toBeInTheDocument(),
    );
  });

  it("reports a preview failure safely", async () => {
    const user = userEvent.setup();
    setup({
      onPreview: async () => {
        throw new Error("provider diagnostic");
      },
    });
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    await user.click(screen.getByRole("button", { name: "Nghe thử" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Chưa phát được giọng đọc/,
    );
    expect(screen.queryByText(/provider diagnostic/)).not.toBeInTheDocument();
  });

  it("loads the account voices only when the dialog opens", async () => {
    const user = userEvent.setup();
    setup();
    expect(voiceStudioMock.listVoices).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));

    expect(await screen.findByRole("radio", { name: /Jessica/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Roger/ })).not.toBeChecked();
    expect(screen.getByText("Nữ · Giọng Mỹ")).toBeInTheDocument();
    expect(voiceStudioMock.listVoices).toHaveBeenCalledOnce();
  });

  it("remembers the chosen voice and treats the default as no override", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));

    await user.click(await screen.findByRole("radio", { name: /Roger/ }));
    expect(getSpeechPreferences().voiceId).toBe("voice_roger");
    expect(screen.getByRole("radio", { name: /Roger/ })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: /Jessica/ }));
    expect(getSpeechPreferences().voiceId).toBeNull();
  });

  it("changes the speed with presets (0.85, 1.00, 1.15) and the slider", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    await screen.findByRole("radio", { name: /Jessica/ });

    await user.click(screen.getByRole("button", { name: "Chậm" }));
    expect(getSpeechPreferences().speed).toBe(0.85);
    expect(screen.getByRole("button", { name: "Chậm" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("min", "0.7");
    expect(slider).toHaveAttribute("max", "1.2");

    await user.click(screen.getByRole("button", { name: "Vừa" }));
    expect(getSpeechPreferences().speed).toBe(1.0);

    await user.click(screen.getByRole("button", { name: "Nhanh" }));
    expect(getSpeechPreferences().speed).toBe(1.15);
  });

  it("lets parents filter Bắc · Trung · Nam regional voices and control separate STT/TTS Google fallbacks", async () => {
    voiceStudioMock.listVoices.mockResolvedValue({
      default_voice_id: "local_north_truc_ly",
      voices: [
        {
          voice_id: "local_north_truc_ly",
          name: "Cô Trúc Ly - Miền Bắc",
          gender: "female",
          region: "north",
          region_label: "Miền Bắc",
          provider: "local",
          model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
        },
        {
          voice_id: "local_central_ngoc_tran",
          name: "Cô Ngọc Trân - Miền Trung",
          gender: "female",
          region: "central",
          region_label: "Miền Trung",
          provider: "local",
          model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
        },
        {
          voice_id: "local_south_thuc_doan",
          name: "Cô Thục Đoan - Miền Nam",
          gender: "female",
          region: "south",
          region_label: "Miền Nam",
          provider: "local",
          model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
        },
        {
          voice_id: "google_vi_vn_neural2_a",
          name: "Google Nữ Bắc - Dự phòng",
          gender: "female",
          region: "north",
          region_label: "Miền Bắc",
          provider: "google",
          model_version: "google-cloud-tts-v1",
        },
      ],
    });

    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    await screen.findByRole("radio", { name: /Cô Trúc Ly/ });

    // Privacy-first default mode is local_only ("Chỉ máy này") with Google fallbacks OFF
    expect(getVoicePolicyPreferences()).toMatchObject({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
      allowGoogleTtsFallback: false,
    });

    // Switch region tabs: Miền Trung -> auto-selects Central voice
    await user.click(screen.getByRole("button", { name: "Miền Trung" }));
    expect(getVoicePolicyPreferences().region).toBe("central");
    expect(getSpeechPreferences().voiceId).toBe("local_central_ngoc_tran");

    // Switch region tabs: Miền Nam -> auto-selects Southern voice
    await user.click(screen.getByRole("button", { name: "Miền Nam" }));
    expect(getVoicePolicyPreferences().region).toBe("south");
    expect(getSpeechPreferences().voiceId).toBe("local_south_thuc_doan");

    // Technical provider mode toggles and STT/TTS fallback checkboxes stay hidden from parents
    expect(
      screen.queryByRole("button", { name: /Máy này \+ Google dự phòng/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Chỉ máy này/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Dự phòng Google cho Nhận diện giọng nói/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Dự phòng Google cho Đọc mẫu/),
    ).not.toBeInTheDocument();
  });

  it("previews the voice and stops the preview when the dialog closes", async () => {
    const user = userEvent.setup();
    const { onPreview, onStopPreview } = setup();
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    await screen.findByRole("radio", { name: /Jessica/ });

    await user.click(screen.getByRole("button", { name: "Nghe thử" }));
    expect(onPreview).toHaveBeenCalledWith(expect.stringContaining("đọc sách"));

    await user.click(screen.getByRole("button", { name: "Đóng hộp thoại" }));
    expect(onStopPreview).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("offers a retry when the voice list cannot be loaded", async () => {
    const user = userEvent.setup();
    voiceStudioMock.listVoices.mockRejectedValueOnce(new Error("offline"));
    setup();
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));

    expect(
      await screen.findByText(/Chưa tải được danh sách giọng/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByRole("radio", { name: /Jessica/ })).toBeChecked();
  });

  it("can be disabled while the microphone is recording", () => {
    setup({ disabled: true });
    expect(screen.getByRole("button", { name: /Giọng đọc/ })).toBeDisabled();
  });

  it("does not display preview error alert when preview rejects with DOMException AbortError", async () => {
    const user = userEvent.setup();
    setup({
      onPreview: async () => {
        throw { name: "AbortError", message: "Audio playback was stopped." };
      },
    });
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    await screen.findByRole("radio", { name: /Jessica/ });
    await user.click(screen.getByRole("button", { name: "Nghe thử" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
