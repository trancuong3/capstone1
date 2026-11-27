import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import {
  computeStagedAiProgress,
  formatAiProgressPct,
  useAiProgress,
  type AiProgressStage,
  type UseAiProgressOptions,
} from "@/hooks/use-ai-progress";

function HookHarness(props: UseAiProgressOptions) {
  const result = useAiProgress(props);
  return (
    <div data-testid="hook-harness">
      <AiProgressBar
        active={props.active}
        elapsedSeconds={result.elapsedSeconds}
        label={result.stageLabel ?? "Đang xử lý"}
        percent={result.percent}
        testId="harness-bar"
      />
      <span data-testid="hook-complete">{String(result.isComplete)}</span>
    </div>
  );
}

describe("AiProgressBar & useAiProgress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders accessible progressbar semantics, explicit percentage, detail, and elapsed seconds", () => {
    render(
      <AiProgressBar
        active
        detail="3/10 trang"
        elapsedSeconds={12}
        label="Đang nhận diện chữ (OCR)…"
        percent={42.4}
        size="md"
        testId="sample-progress"
        tone="primary"
      />,
    );

    const container = screen.getByTestId("sample-progress");
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-label", "Đang nhận diện chữ (OCR)…");
    expect(container).toHaveTextContent("42%");
    expect(container).toHaveTextContent("3/10 trang");
    expect(container).toHaveTextContent("12 giây");
  });

  it("clamps invalid and out-of-range percentages cleanly", () => {
    const { rerender } = render(
      <AiProgressBar label="Low" percent={-15} testId="clamp-bar" />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    expect(screen.getByTestId("clamp-bar")).toHaveTextContent("0%");

    rerender(<AiProgressBar label="High" percent={145} testId="clamp-bar" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    expect(screen.getByTestId("clamp-bar")).toHaveTextContent("100%");

    rerender(
      <AiProgressBar label="NaN" percent={Number.NaN} testId="clamp-bar" />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    expect(formatAiProgressPct(87.6)).toBe("88%");
  });

  it("advances smoothly along the asymptotic curve without ever hitting 100% prematurely, and snaps to 100% on completion", async () => {
    vi.useFakeTimers();
    const stages: readonly AiProgressStage[] = [
      { atPct: 0, label: "Đang chuẩn bị…" },
      { atPct: 30, label: "Đang phân tích nội dung…" },
      { atPct: 75, label: "Đang hoàn tất kết quả…" },
    ];

    const { rerender } = render(
      <HookHarness
        active
        ceilingPct={94}
        expectedDurationMs={8000}
        floorPct={8}
        stages={stages}
      />,
    );

    const bar = screen.getByRole("progressbar");
    expect(Number(bar.getAttribute("aria-valuenow"))).toBe(8);
    expect(screen.getByTestId("harness-bar")).toHaveTextContent("8%");
    expect(screen.getByTestId("harness-bar")).toHaveTextContent(
      "Đang chuẩn bị…",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    const midPct = Number(
      screen.getByRole("progressbar").getAttribute("aria-valuenow"),
    );
    expect(midPct).toBeGreaterThan(30);
    expect(midPct).toBeLessThan(95);
    expect(screen.getByTestId("harness-bar")).toHaveTextContent(
      "Đang phân tích nội dung…",
    );

    // Even after 120 seconds (15x expected duration), asymptotic progress NEVER hits 100%!
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    const cappedPct = Number(
      screen.getByRole("progressbar").getAttribute("aria-valuenow"),
    );
    expect(cappedPct).toBeLessThanOrEqual(94);
    expect(cappedPct).toBeGreaterThanOrEqual(90);
    expect(screen.getByTestId("hook-complete")).toHaveTextContent("false");

    // On completion -> snaps cleanly to 100%
    rerender(
      <HookHarness
        active={false}
        completed
        expectedDurationMs={8000}
        stages={stages}
      />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    expect(screen.getByTestId("harness-bar")).toHaveTextContent("100%");
    expect(screen.getByTestId("hook-complete")).toHaveTextContent("true");

    // Reset on inactive / failed -> returns to 0%
    rerender(
      <HookHarness
        active={false}
        completed={false}
        expectedDurationMs={8000}
        failed
        stages={stages}
      />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
  });

  it("holds measured realPercent honestly (e.g. 2% when waiting for offline worker) and creeps monotonically in staged mode", async () => {
    vi.useFakeTimers();

    const { rerender } = render(
      <HookHarness active progressMode="measured" realPercent={2} />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "2",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    // Measured mode MUST stay honest at 2%, never faking progress
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "2",
    );

    // Staged mode with backend milestone creeps gently within +12 ceiling
    rerender(
      <HookHarness
        active
        expectedDurationMs={6000}
        progressMode="staged"
        realPercent={40}
      />,
    );
    const startStaged = Number(
      screen.getByRole("progressbar").getAttribute("aria-valuenow"),
    );
    expect(startStaged).toBeGreaterThanOrEqual(40);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const creptStaged = Number(
      screen.getByRole("progressbar").getAttribute("aria-valuenow"),
    );
    expect(creptStaged).toBeGreaterThan(40);
    expect(creptStaged).toBeLessThanOrEqual(52);
  });

  it("resets peakPct and timer when resetKey changes and honors measured drops immediately", async () => {
    vi.useFakeTimers();

    const { rerender } = render(
      <HookHarness
        active
        expectedDurationMs={4000}
        progressMode="staged"
        realPercent={35}
        resetKey="task-1"
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const highPct = Number(
      screen.getByRole("progressbar").getAttribute("aria-valuenow"),
    );
    expect(highPct).toBeGreaterThan(40);

    // Transition to measured 2% (e.g. uploading -> offline queued worker) without sticky peakPct
    rerender(
      <HookHarness
        active
        progressMode="measured"
        realPercent={2}
        resetKey="task-1"
      />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "2",
    );

    // Switch back to a brand new staged task with different resetKey -> starts fresh at its floor (12%), not stale 45%
    rerender(
      <HookHarness
        active
        expectedDurationMs={8000}
        progressMode="staged"
        realPercent={12}
        resetKey="task-2"
      />,
    );
    const task2Pct = Number(
      screen.getByRole("progressbar").getAttribute("aria-valuenow"),
    );
    expect(task2Pct).toBe(12);
    expect(screen.getByTestId("harness-bar")).not.toHaveTextContent("5 giây");
  });

  it("computes deterministic staged percentages via computeStagedAiProgress", () => {
    expect(computeStagedAiProgress(0, { floorPct: 8, ceilingPct: 94 })).toBe(8);
    expect(
      computeStagedAiProgress(6000, {
        expectedDurationMs: 12000,
        floorPct: 8,
        ceilingPct: 94,
      }),
    ).toBeGreaterThan(50);
    expect(
      computeStagedAiProgress(10_000_000, { floorPct: 8, ceilingPct: 94 }),
    ).toBeLessThanOrEqual(94);
  });
});
