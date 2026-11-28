import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MinimalPairSandbox } from "@/components/reading/minimal-pair-sandbox";
import { AppServicesContext } from "@/components/providers/app-services-provider";
import type { AppServices } from "@/components/providers/app-services-provider";
import {
  clearChildModeLockForUser,
  isChildModeLockedForUser,
  isParentProtectedRoute,
  setChildModeLockedForUser,
} from "@/lib/security/child-mode-lock";

const playMock = vi.fn().mockResolvedValue(undefined);
const stopMock = vi.fn();

vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => ({
    isPlaying: false,
    fallbackNotice: null,
    play: playMock,
    prefetch: vi.fn().mockResolvedValue(undefined),
    stop: stopMock,
  }),
}));

describe("Wave 1 Pedagogy & Child-Safe Family Companion", () => {
  beforeEach(() => {
    playMock.mockClear();
    stopMock.mockClear();
    window.sessionStorage.clear();
  });

  it("classifies parent-protected routes vs child-accessible learning routes", () => {
    expect(isParentProtectedRoute("/settings")).toBe(true);
    expect(isParentProtectedRoute("/my-books")).toBe(true);
    expect(isParentProtectedRoute("/reading-management")).toBe(true);
    expect(isParentProtectedRoute("/children/new")).toBe(true);
    expect(isParentProtectedRoute("/reports")).toBe(true);

    // Child learning & word-practice surfaces remain accessible!
    expect(isParentProtectedRoute("/dashboard")).toBe(false);
    expect(isParentProtectedRoute("/books")).toBe(false);
    expect(isParentProtectedRoute("/reading-preparation")).toBe(false);
    expect(isParentProtectedRoute("/reports/difficult-words")).toBe(false);
    expect(isParentProtectedRoute("/entertainment/sentence-shooter")).toBe(
      false,
    );
  });

  it("isolates Child-Safe Mode lock state per parent userId", () => {
    const parentA = "11111111-1111-1111-1111-111111111111";
    const parentB = "22222222-2222-2222-2222-222222222222";

    expect(isChildModeLockedForUser(parentA)).toBe(false);
    setChildModeLockedForUser(parentA, true);
    expect(isChildModeLockedForUser(parentA)).toBe(true);
    expect(isChildModeLockedForUser(parentB)).toBe(false);

    clearChildModeLockForUser(parentA);
    expect(isChildModeLockedForUser(parentA)).toBe(false);
  });

  it("renders MinimalPairSandbox with % progress bar and plays minimal-pair audio", async () => {
    const childId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let resolveSandbox!: (val: unknown) => void;
    const getPhonologySandbox = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSandbox = resolve;
        }),
    );

    const mockServices = {
      childProgressService: {
        get: vi.fn(),
        generate: vi.fn(),
        getPhonologySandbox,
      },
    } as unknown as AppServices;

    render(
      <AppServicesContext.Provider value={mockServices}>
        <MinimalPairSandbox childAlias="Bé An" childId={childId} initialOpen />
      </AppServicesContext.Provider>,
    );

    // Must render % AI progress bar while loading!
    expect(
      screen.getByTestId("minimal-pair-sandbox-progress"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("minimal-pair-sandbox-progress-pct"),
    ).toHaveTextContent(/%/);

    resolveSandbox({
      child_id: childId,
      days: 30,
      is_diagnostic: false,
      disclaimer_vi: "Không phải chẩn đoán y khoa.",
      has_recurring_patterns: true,
      patterns: [
        {
          pattern_key: "TONE:hoi<->nga",
          category: "TONE",
          unit_a: "hoi",
          unit_b: "nga",
          title_vi: "Cặp thanh hỏi ↔ thanh ngã",
          summary_vi: "Bé đang luyện phân biệt thanh hỏi và thanh ngã.",
          occurrences: 4,
          distinct_sessions: 3,
          examples: [
            { expected_word: "mả", spoken_word: "mã", occurrences: 2 },
          ],
          minimal_pairs: [],
        },
      ],
      recommended_pairs: [
        {
          pattern_key: "TONE:hoi<->nga",
          word_a: "mả",
          word_b: "mã",
          target_word: "mả",
          contrast_word: "mã",
          hint_vi: "Đọc chậm rõ dấu hỏi và dấu ngã.",
          origin: "CHILD_HISTORY",
        },
      ],
      duration_seconds: 60,
    });

    await waitFor(() => {
      expect(screen.getByText("mả")).toBeInTheDocument();
      expect(screen.getByText("mã")).toBeInTheDocument();
    });

    const listenBtn = screen.getByRole("button", { name: "Nghe: mả" });
    fireEvent.click(listenBtn);
    await waitFor(() => {
      expect(playMock).toHaveBeenCalledWith(
        "mả",
        expect.objectContaining({ wordSample: true }),
      );
    });
  });
});
