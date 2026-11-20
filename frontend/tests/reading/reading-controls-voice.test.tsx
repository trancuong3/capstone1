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

describe("retryMode hides the Chọn trang button", () => {
  it("hides Chọn trang in retryMode", () => {
    render(
      <ReadingControls {...handlers} retryMode={true} onChoosePage={vi.fn()} />,
    );

    const nav = screen.getByRole("navigation", {
      name: "Điều khiển buổi đọc",
    });
    expect(within(nav).queryByText("Chọn trang")).not.toBeInTheDocument();
  });

  it("shows Chọn trang in normal mode", () => {
    render(
      <ReadingControls
        {...handlers}
        retryMode={false}
        onChoosePage={vi.fn()}
      />,
    );

    const nav = screen.getByRole("navigation", {
      name: "Điều khiển buổi đọc",
    });
    expect(within(nav).getByText("Chọn trang")).toBeVisible();
  });

  it("uses sm:grid-cols-4 in retryMode without voiceSettings", () => {
    render(<ReadingControls {...handlers} retryMode={true} />);

    const nav = screen.getByRole("navigation", {
      name: "Điều khiển buổi đọc",
    });
    expect(nav.className).toContain("grid-cols-4");
    expect(nav.className).not.toContain("grid-cols-5");
  });

  it("uses sm:grid-cols-5 in retryMode with voiceSettings", () => {
    render(
      <ReadingControls
        {...handlers}
        retryMode={true}
        voiceSettings={
          <ReadingVoiceSettings onPreview={vi.fn()} onStopPreview={vi.fn()} />
        }
      />,
    );

    const nav = screen.getByRole("navigation", {
      name: "Điều khiển buổi đọc",
    });
    expect(nav.className).toContain("grid-cols-5");
  });

  it("keeps Tạm dừng, Nghe mẫu từ, Bật mic, and Hoàn thành in retryMode", () => {
    render(
      <ReadingControls
        {...handlers}
        retryMode={true}
        onToggleListening={vi.fn()}
        onReadSample={vi.fn()}
      />,
    );

    const nav = screen.getByRole("navigation", {
      name: "Điều khiển buổi đọc",
    });
    const buttons = within(nav).getAllByRole("button");
    const labels = buttons.map((b) => b.textContent);

    expect(labels).toContain("Tạm dừng");
    expect(labels).toContain("Nghe mẫu từ");
    expect(labels).toContain("Bật mic");
    expect(labels).toContain("Hoàn thành");
    expect(labels).not.toContain("Chọn trang");
  });
});
