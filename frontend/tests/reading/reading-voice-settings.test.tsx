import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import {
  getSpeechPreferences,
  resetSpeechPreferencesCache,
} from "@/lib/reading/speech-preferences";

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
  resetSpeechPreferencesCache();
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
  it("loads the account voices only when the dialog opens", async () => {
    const user = userEvent.setup();
    setup();
    expect(voiceStudioMock.listVoices).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));

    expect(await screen.findByRole("radio", { name: /Jessica/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Roger/ })).not.toBeChecked();
    expect(screen.getByText("Nữ · american")).toBeInTheDocument();
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

  it("changes the speed with presets and the slider", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    await screen.findByRole("radio", { name: /Jessica/ });

    await user.click(screen.getByRole("button", { name: "Chậm" }));
    expect(getSpeechPreferences().speed).toBe(0.8);
    expect(screen.getByRole("button", { name: "Chậm" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("min", "0.7");
    expect(slider).toHaveAttribute("max", "1.2");
    await user.click(screen.getByRole("button", { name: "Nhanh" }));
    expect(getSpeechPreferences().speed).toBe(1.1);
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
});
