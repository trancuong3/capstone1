import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReadingControls } from "@/components/reading/reading-controls";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";

vi.mock("@/lib/api/voice-studio-service", () => ({
  createVoiceStudioService: () => ({
    listVoices: vi.fn().mockResolvedValue({ voices: [], default_voice_id: "" }),
    synthesizeTimed: vi.fn(),
  }),
}));

const handlers = {
  onFinish: vi.fn(),
  onHelp: vi.fn(),
  onPause: vi.fn(),
};

describe("voice settings in the reading controls", () => {
  it("shows a visible Giọng đọc button right after the sample button", () => {
    render(
      <ReadingControls
        {...handlers}
        voiceSettings={
          <ReadingVoiceSettings onPreview={vi.fn()} onStopPreview={vi.fn()} />
        }
      />,
    );

    const nav = screen.getByRole("navigation", {
      name: "Điều khiển buổi đọc",
    });
    expect(nav.className).toContain("grid-cols-6");
    const labels = within(nav)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(labels.indexOf("Giọng đọc")).toBe(labels.indexOf("Nghe mẫu") + 1);
    expect(
      within(nav).getByRole("button", { name: "Giọng đọc" }),
    ).toBeVisible();
  });

  it("keeps the original five-button layout without voice settings", () => {
    render(<ReadingControls {...handlers} />);
    const nav = screen.getByRole("navigation", {
      name: "Điều khiển buổi đọc",
    });
    expect(nav.className).toContain("grid-cols-5");
    expect(within(nav).queryByText("Giọng đọc")).not.toBeInTheDocument();
  });
});
